//! Workspace Trust gate (`LOT-010`, `AGENTS.md` rule 6).
//!
//! A workspace is `Untrusted` until the user explicitly approves it. While it is untrusted the
//! Host launches **no** external process on its behalf: no repository-local binary, Git hook,
//! startup script, workspace-local language server, debug adapter or extension.
//!
//! This module is the single place in `host-core` allowed to create an OS process
//! (`clippy.toml` forbids `Command::new` everywhere else in the crate), so every launch has to
//! present a capability and pass the trust check, both when the command is built and again at
//! the moment it is spawned.

use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::process::{SupervisedChild, SupervisionError};

pub const WORKSPACE_TRUST_STORE_FILENAME: &str = "workspace_trust.json";
const TRUST_STORE_SCHEMA_VERSION: u16 = 1;

static STORE_TMP_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Trust decision for one workspace root.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum WorkspaceTrustState {
    Untrusted,
    Trusted,
}

/// What a process launch is for. Every capability is denied on an untrusted workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum GatedCapability {
    /// A binary that lives inside the repository (`node_modules/.bin/*`, scripts, ...).
    WorkspaceLocalBinary,
    /// Anything that may run `.git/hooks/*` or repository-configured Git programs.
    GitHook,
    /// Tasks or scripts that run when the folder is opened.
    StartupScript,
    /// Language servers and linters working on the workspace (`vtsls`, Biome): they load
    /// repository-controlled configuration and plugins.
    WorkspaceLanguageServer,
    /// Debug adapters and the debuggee they start.
    DebugAdapter,
    /// Extensions activated for the workspace.
    ActiveExtension,
}

#[derive(Debug, Error)]
pub enum TrustError {
    #[error("workspace {workspace_root} is not trusted: {capability:?} is blocked")]
    Untrusted {
        capability: GatedCapability,
        workspace_root: PathBuf,
    },
    #[error("workspace {workspace_root} is no longer open: {capability:?} is blocked")]
    GateClosed {
        capability: GatedCapability,
        workspace_root: PathBuf,
    },
    #[error("workspace root {0} cannot be recorded: its path is not valid UTF-8")]
    NonUtf8Root(PathBuf),
    #[error("workspace trust I/O error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("workspace trust store cannot be encoded: {0}")]
    Encode(#[from] serde_json::Error),
    #[error("failed to launch {program}: {source}")]
    Spawn {
        program: PathBuf,
        #[source]
        source: SupervisionError,
    },
}

#[derive(Debug, Serialize, Deserialize)]
struct TrustStoreFile {
    schema_version: u16,
    trusted_roots: BTreeSet<String>,
}

/// Reads the trusted roots. A missing, unreadable or malformed store means nothing is trusted
/// (fail closed): the user is simply asked again.
fn load_trusted_roots(store_path: &Path) -> BTreeSet<String> {
    let Ok(bytes) = fs::read(store_path) else {
        return BTreeSet::new();
    };
    match serde_json::from_slice::<TrustStoreFile>(&bytes) {
        Ok(file) if file.schema_version == TRUST_STORE_SCHEMA_VERSION => file.trusted_roots,
        Ok(file) => {
            tracing::warn!(
                schema_version = file.schema_version,
                "unsupported workspace trust store version: treating every workspace as untrusted"
            );
            BTreeSet::new()
        }
        Err(error) => {
            tracing::warn!(%error, "malformed workspace trust store: treating every workspace as untrusted");
            BTreeSet::new()
        }
    }
}

/// Atomically replaces the store (temporary file, fsync, rename).
fn save_trusted_roots(store_path: &Path, roots: BTreeSet<String>) -> Result<(), TrustError> {
    let io = |path: &Path| {
        let path = path.to_path_buf();
        move |source| TrustError::Io { path, source }
    };
    if let Some(parent) = store_path.parent() {
        fs::create_dir_all(parent).map_err(io(parent))?;
    }
    let encoded = serde_json::to_vec_pretty(&TrustStoreFile {
        schema_version: TRUST_STORE_SCHEMA_VERSION,
        trusted_roots: roots,
    })?;
    let seq = STORE_TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut tmp_name = store_path.as_os_str().to_os_string();
    tmp_name.push(format!(".tmp.{}.{seq}", std::process::id()));
    let tmp_path = PathBuf::from(tmp_name);
    {
        let mut file = File::create(&tmp_path).map_err(io(&tmp_path))?;
        file.write_all(&encoded).map_err(io(&tmp_path))?;
        file.sync_all().map_err(io(&tmp_path))?;
    }
    fs::rename(&tmp_path, store_path).map_err(io(store_path))
}

#[derive(Debug)]
struct GateInner {
    store_path: PathBuf,
    workspace_root: PathBuf,
    root_key: String,
    trusted: AtomicBool,
    closed: AtomicBool,
    spawned: AtomicU64,
    /// Serializes read-modify-write cycles on the store file.
    store_write: Mutex<()>,
}

/// Trust gate of one open workspace. Cheap to clone; every clone sees the same decision, so a
/// supervisor holding one is cut off the moment trust is revoked or the workspace is closed.
#[derive(Debug, Clone)]
pub struct WorkspaceTrustGate {
    inner: Arc<GateInner>,
}

impl WorkspaceTrustGate {
    /// Opens the gate for `workspace_root`, reading the persisted decision from `store_path`.
    /// The root is canonicalized, so a symlink to a trusted folder and the folder itself share
    /// one decision, and a moved or copied repository starts untrusted.
    pub fn open(store_path: impl Into<PathBuf>, workspace_root: &Path) -> Result<Self, TrustError> {
        let store_path = store_path.into();
        let workspace_root = workspace_root
            .canonicalize()
            .map_err(|source| TrustError::Io {
                path: workspace_root.to_path_buf(),
                source,
            })?;
        let root_key = workspace_root
            .to_str()
            .ok_or_else(|| TrustError::NonUtf8Root(workspace_root.clone()))?
            .to_string();
        let trusted = load_trusted_roots(&store_path).contains(&root_key);
        Ok(Self {
            inner: Arc::new(GateInner {
                store_path,
                workspace_root,
                root_key,
                trusted: AtomicBool::new(trusted),
                closed: AtomicBool::new(false),
                spawned: AtomicU64::new(0),
                store_write: Mutex::new(()),
            }),
        })
    }

    #[must_use]
    pub fn workspace_root(&self) -> &Path {
        &self.inner.workspace_root
    }

    #[must_use]
    pub fn state(&self) -> WorkspaceTrustState {
        if self.inner.trusted.load(Ordering::SeqCst) && !self.inner.closed.load(Ordering::SeqCst) {
            WorkspaceTrustState::Trusted
        } else {
            WorkspaceTrustState::Untrusted
        }
    }

    #[must_use]
    pub fn is_trusted(&self) -> bool {
        self.state() == WorkspaceTrustState::Trusted
    }

    /// Number of processes this gate has launched since it was opened.
    #[must_use]
    pub fn spawned_process_count(&self) -> u64 {
        self.inner.spawned.load(Ordering::SeqCst)
    }

    /// Records the user's explicit approval. Call this only as the direct result of a user
    /// decision, never from model, MCP, extension or repository content. The decision is
    /// durable before the gate opens: if it cannot be persisted, the workspace stays untrusted.
    pub fn grant(&self) -> Result<(), TrustError> {
        self.update_store(|roots, key| {
            roots.insert(key.to_string());
        })?;
        self.inner.trusted.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// Withdraws trust. The gate closes immediately, even if the store cannot be rewritten.
    pub fn revoke(&self) -> Result<(), TrustError> {
        self.inner.trusted.store(false, Ordering::SeqCst);
        self.update_store(|roots, key| {
            roots.remove(key);
        })
    }

    /// Marks the workspace as no longer open (another one replaced it). Every clone of this
    /// gate then denies everything, whatever the persisted decision is.
    pub fn close(&self) {
        self.inner.closed.store(true, Ordering::SeqCst);
    }

    fn update_store(
        &self,
        change: impl FnOnce(&mut BTreeSet<String>, &str),
    ) -> Result<(), TrustError> {
        let _guard = self
            .inner
            .store_write
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut roots = load_trusted_roots(&self.inner.store_path);
        change(&mut roots, &self.inner.root_key);
        save_trusted_roots(&self.inner.store_path, roots)
    }

    /// Checks that `capability` may be used now.
    pub fn authorize(&self, capability: GatedCapability) -> Result<(), TrustError> {
        if self.inner.closed.load(Ordering::SeqCst) {
            return Err(TrustError::GateClosed {
                capability,
                workspace_root: self.inner.workspace_root.clone(),
            });
        }
        if !self.inner.trusted.load(Ordering::SeqCst) {
            return Err(TrustError::Untrusted {
                capability,
                workspace_root: self.inner.workspace_root.clone(),
            });
        }
        Ok(())
    }

    /// Whether `path` resolves to somewhere inside the workspace (symlinks followed).
    #[must_use]
    pub fn is_inside_workspace(&self, path: &Path) -> bool {
        path.canonicalize()
            .is_ok_and(|canonical| canonical.starts_with(&self.inner.workspace_root))
    }

    /// Builds a command for `program`, or refuses if the workspace is not trusted. This is the
    /// only way to obtain a launchable command in `host-core`.
    pub fn command(
        &self,
        capability: GatedCapability,
        program: impl AsRef<Path>,
    ) -> Result<GatedCommand, TrustError> {
        self.authorize(capability)?;
        let program = program.as_ref().to_path_buf();
        // The one sanctioned `Command::new` of the crate (see `clippy.toml`).
        #[allow(clippy::disallowed_methods)]
        let command = Command::new(&program);
        Ok(GatedCommand {
            gate: self.clone(),
            capability,
            program,
            command,
        })
    }
}

/// A command that can only be spawned while its workspace is still trusted.
#[derive(Debug)]
pub struct GatedCommand {
    gate: WorkspaceTrustGate,
    capability: GatedCapability,
    program: PathBuf,
    command: Command,
}

impl GatedCommand {
    /// Arguments, environment, working directory and stdio are configured on the inner command.
    pub fn command_mut(&mut self) -> &mut Command {
        &mut self.command
    }

    /// Spawns the process, bound to the Host's lifetime (see [`SupervisedChild`]). Trust is
    /// checked again here: it may have been revoked, or the workspace closed, since the command
    /// was built.
    pub fn spawn(self) -> Result<SupervisedChild, TrustError> {
        self.gate.authorize(self.capability)?;
        let child = SupervisedChild::spawn(self.command).map_err(|source| TrustError::Spawn {
            program: self.program.clone(),
            source,
        })?;
        self.gate.inner.spawned.fetch_add(1, Ordering::SeqCst);
        Ok(child)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(dir: &Path) -> PathBuf {
        dir.join(WORKSPACE_TRUST_STORE_FILENAME)
    }

    #[test]
    fn a_workspace_starts_untrusted_and_every_capability_is_denied() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let gate = WorkspaceTrustGate::open(store(data.path()), workspace.path()).unwrap();
        assert_eq!(gate.state(), WorkspaceTrustState::Untrusted);
        for capability in [
            GatedCapability::WorkspaceLocalBinary,
            GatedCapability::GitHook,
            GatedCapability::StartupScript,
            GatedCapability::WorkspaceLanguageServer,
            GatedCapability::DebugAdapter,
            GatedCapability::ActiveExtension,
        ] {
            assert!(matches!(
                gate.authorize(capability),
                Err(TrustError::Untrusted { .. })
            ));
            assert!(gate.command(capability, "/bin/echo").is_err());
        }
        assert_eq!(gate.spawned_process_count(), 0);
    }

    #[test]
    fn a_malformed_or_future_store_trusts_nothing() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let key = workspace.path().canonicalize().unwrap();
        fs::write(store(data.path()), b"{ not json").unwrap();
        let gate = WorkspaceTrustGate::open(store(data.path()), workspace.path()).unwrap();
        assert!(!gate.is_trusted());

        let future = serde_json::json!({"schema_version": 99, "trusted_roots": [key]});
        fs::write(store(data.path()), future.to_string()).unwrap();
        let gate = WorkspaceTrustGate::open(store(data.path()), workspace.path()).unwrap();
        assert!(!gate.is_trusted());
    }

    #[test]
    fn a_grant_that_cannot_be_persisted_leaves_the_workspace_untrusted() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        // The store's parent is a regular file, so nothing can be written under it.
        let blocker = data.path().join("blocker");
        fs::write(&blocker, b"").unwrap();
        let gate = WorkspaceTrustGate::open(blocker.join("trust.json"), workspace.path()).unwrap();
        assert!(gate.grant().is_err());
        assert!(!gate.is_trusted());
    }

    #[test]
    fn trust_is_per_root_and_a_closed_gate_denies_everything() {
        let data = tempfile::tempdir().unwrap();
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let gate = WorkspaceTrustGate::open(store(data.path()), first.path()).unwrap();
        gate.grant().unwrap();
        let other = WorkspaceTrustGate::open(store(data.path()), second.path()).unwrap();
        assert!(!other.is_trusted());

        let held_by_supervisor = gate.clone();
        gate.close();
        assert!(matches!(
            held_by_supervisor.authorize(GatedCapability::WorkspaceLanguageServer),
            Err(TrustError::GateClosed { .. })
        ));
        // Closing does not forget the decision: reopening the workspace finds it trusted.
        assert!(WorkspaceTrustGate::open(store(data.path()), first.path())
            .unwrap()
            .is_trusted());
    }
}
