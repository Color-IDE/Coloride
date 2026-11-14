//! The language servers of one workspace (Biome, `vtsls`), started only once it is trusted and
//! kept in sync with every open document.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ropey::Rope;
use serde_json::Value;

use super::client::LspError;
use super::session::{
    DiagnosticsMode, DiagnosticsSink, DocumentRef, LanguageServerProfile, LanguageServerSession,
};
use crate::contracts::{
    DiagnosticSource, LanguageFeature, LanguageFeatureRequest, LanguageFeatureResponse, TextChange,
};
use crate::document::DocumentSession;
use crate::trust::WorkspaceTrustGate;

/// A server profile plus the documents it is interested in.
#[derive(Debug, Clone)]
pub struct LanguageServerSpec {
    pub profile: LanguageServerProfile,
    /// LSP language identifiers this server receives (`typescript`, `json`, ...).
    pub language_ids: Vec<&'static str>,
}

/// LSP language identifier of a file, from its extension. `None`: no server handles it.
#[must_use]
pub fn language_id_for_path(path: &Path) -> Option<&'static str> {
    Some(
        match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
            "ts" | "mts" | "cts" => "typescript",
            "tsx" => "typescriptreact",
            "js" | "mjs" | "cjs" => "javascript",
            "jsx" => "javascriptreact",
            "json" => "json",
            "jsonc" => "jsonc",
            "css" => "css",
            _ => return None,
        },
    )
}

/// Finds a tool for a **trusted** workspace: its own `node_modules/.bin` first, then `PATH`.
/// Returns `None` while the workspace is untrusted, so a repository binary is not even looked
/// up before the user's approval.
#[must_use]
pub fn resolve_workspace_tool(gate: &WorkspaceTrustGate, name: &str) -> Option<PathBuf> {
    if !gate.is_trusted() {
        return None;
    }
    let local = gate.workspace_root().join("node_modules/.bin").join(name);
    if local.is_file() {
        return Some(local);
    }
    std::env::split_paths(&std::env::var_os("PATH")?)
        // A relative `PATH` entry would resolve inside whatever directory we run from.
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// Biome as a language server (`biome lsp-proxy`): lint and syntax diagnostics for JS/TS/JSON/CSS.
#[must_use]
pub fn biome_server_spec(program: PathBuf) -> LanguageServerSpec {
    LanguageServerSpec {
        profile: LanguageServerProfile {
            source: DiagnosticSource::Biome,
            program,
            args: vec!["lsp-proxy".to_string()],
            initialization_options: Value::Null,
            diagnostics: DiagnosticsMode::Push,
        },
        language_ids: vec![
            "typescript",
            "typescriptreact",
            "javascript",
            "javascriptreact",
            "json",
            "jsonc",
            "css",
        ],
    }
}

const TYPESCRIPT_LANGUAGE_IDS: [&str; 4] = [
    "typescript",
    "typescriptreact",
    "javascript",
    "javascriptreact",
];

/// `vtsls`: TypeScript/JavaScript semantics (type errors, definitions, references, rename,
/// completions) on top of `tsserver`.
#[must_use]
pub fn vtsls_server_spec(program: PathBuf) -> LanguageServerSpec {
    LanguageServerSpec {
        profile: LanguageServerProfile {
            source: DiagnosticSource::Vtsls,
            program,
            args: vec!["--stdio".to_string()],
            initialization_options: Value::Null,
            diagnostics: DiagnosticsMode::TsserverPull,
        },
        language_ids: TYPESCRIPT_LANGUAGE_IDS.to_vec(),
    }
}

/// Adapter for `tsgo` (the native TypeScript server), a drop-in replacement for `vtsls` that
/// speaks standard LSP with pull diagnostics. Its diagnostics are reported under the same
/// source, so the two are never run together for one workspace.
#[must_use]
pub fn tsgo_server_spec(program: PathBuf) -> LanguageServerSpec {
    LanguageServerSpec {
        profile: LanguageServerProfile {
            source: DiagnosticSource::Vtsls,
            program,
            args: vec!["--lsp".to_string(), "--stdio".to_string()],
            initialization_options: Value::Null,
            diagnostics: DiagnosticsMode::LspPull,
        },
        language_ids: TYPESCRIPT_LANGUAGE_IDS.to_vec(),
    }
}

#[derive(Debug, Clone)]
struct OpenDocument {
    document_id: String,
    session_generation: u32,
    language_id: &'static str,
    revision: u32,
    rope: Rope,
    content_blake3_hash: String,
}

#[derive(Debug)]
struct RunningServer {
    /// Shared so that a feature request can wait for its answer without holding the state
    /// lock (which every keystroke takes).
    session: Arc<LanguageServerSession>,
    language_ids: Vec<&'static str>,
}

#[derive(Debug, Default)]
struct ServicesState {
    servers: Vec<RunningServer>,
    /// Latest text of every open document with a file on disk, keyed by that file's path. A
    /// server started later (trust granted after files were opened) is brought up to date
    /// from here.
    open: HashMap<PathBuf, OpenDocument>,
}

pub struct LanguageServices {
    gate: WorkspaceTrustGate,
    sink: DiagnosticsSink,
    state: Mutex<ServicesState>,
}

impl std::fmt::Debug for LanguageServices {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LanguageServices")
            .field("workspace_root", &self.gate.workspace_root())
            .finish_non_exhaustive()
    }
}

impl LanguageServices {
    #[must_use]
    pub fn new(gate: WorkspaceTrustGate, sink: DiagnosticsSink) -> Self {
        Self {
            gate,
            sink,
            state: Mutex::default(),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, ServicesState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Starts `spec` unless a live server already reports for the same source. Returns whether
    /// that server is running afterwards. On an untrusted workspace nothing is launched.
    pub fn ensure_server(&self, spec: &LanguageServerSpec) -> bool {
        match self.try_ensure_server(spec) {
            Ok(()) => true,
            Err(error) => {
                tracing::info!(source = ?spec.profile.source, %error, "language server not started");
                false
            }
        }
    }

    /// Like [`Self::ensure_server`], but says why a server could not be started.
    ///
    /// # Errors
    /// The trust gate refused, or the server could not be launched or initialized.
    pub fn try_ensure_server(&self, spec: &LanguageServerSpec) -> Result<(), LspError> {
        let mut state = self.state();
        state.servers.retain(|server| server.session.is_alive());
        let source = spec.profile.source;
        if state
            .servers
            .iter()
            .any(|server| server.session.source() == source)
        {
            return Ok(());
        }
        let session = LanguageServerSession::start(&self.gate, &spec.profile, self.sink.clone())?;
        for (path, document) in &state.open {
            if spec.language_ids.contains(&document.language_id) {
                let _ = session.open_document(
                    DocumentRef {
                        document_id: &document.document_id,
                        session_generation: document.session_generation,
                        path,
                    },
                    document.language_id,
                    document.revision,
                    &document.rope,
                    &document.content_blake3_hash,
                );
            }
        }
        state.servers.push(RunningServer {
            session: Arc::new(session),
            language_ids: spec.language_ids.clone(),
        });
        Ok(())
    }

    /// Whether a live server reports diagnostics for `source`.
    #[must_use]
    pub fn is_running(&self, source: DiagnosticSource) -> bool {
        self.state()
            .servers
            .iter()
            .any(|server| server.session.source() == source && server.session.is_alive())
    }

    /// OS process ids of the running servers.
    #[must_use]
    pub fn server_process_ids(&self) -> Vec<u32> {
        self.state()
            .servers
            .iter()
            .map(|server| server.session.process_id())
            .collect()
    }

    /// A document was opened (or reopened under a new session generation).
    pub fn document_opened(&self, session: &DocumentSession) {
        let Some(path) = session.disk_path() else {
            return; // untitled buffers have no file a server could reason about
        };
        let Some(language_id) = language_id_for_path(path) else {
            return;
        };
        let document = OpenDocument {
            document_id: session.document_id().to_string(),
            session_generation: session.session_generation(),
            language_id,
            revision: session.interactive_revision(),
            rope: session.rope().clone(),
            content_blake3_hash: session.content_blake3_hash().to_string(),
        };
        let mut state = self.state();
        for server in &state.servers {
            if server.language_ids.contains(&language_id) {
                let _ = server.session.open_document(
                    DocumentRef {
                        document_id: &document.document_id,
                        session_generation: document.session_generation,
                        path,
                    },
                    language_id,
                    document.revision,
                    &document.rope,
                    &document.content_blake3_hash,
                );
            }
        }
        state.open.insert(path.to_path_buf(), document);
    }

    /// An `EditorTransaction` was applied: `changes` turned `rope_before` into the current text
    /// of `session`. Only enqueues messages; never waits for a server.
    pub fn transaction_applied(
        &self,
        rope_before: &Rope,
        changes: &[TextChange],
        session: &DocumentSession,
    ) {
        let Some(path) = session.disk_path() else {
            return;
        };
        let mut state = self.state();
        let Some(document) = state.open.get_mut(path) else {
            return;
        };
        if document.session_generation != session.session_generation() {
            return;
        }
        document.revision = session.interactive_revision();
        document.rope = session.rope().clone();
        document.content_blake3_hash = session.content_blake3_hash().to_string();
        let language_id = document.language_id;
        let reference = DocumentRef {
            document_id: session.document_id(),
            session_generation: session.session_generation(),
            path,
        };
        for server in &state.servers {
            if server.language_ids.contains(&language_id) {
                let _ = server.session.change_document(
                    reference,
                    session.interactive_revision(),
                    rope_before,
                    changes,
                    session.rope(),
                    session.content_blake3_hash(),
                );
            }
        }
    }

    /// Answers a feature request for the open document at `path` (see
    /// [`LanguageServerSession::request_feature`]). Formatting goes to Biome when it handles
    /// the language, everything else to the TypeScript server.
    pub fn request_feature(
        &self,
        path: &Path,
        request: &LanguageFeatureRequest,
        timeout: Duration,
    ) -> Result<LanguageFeatureResponse, LspError> {
        let preference: &[DiagnosticSource] = match request.feature {
            LanguageFeature::Formatting => &[DiagnosticSource::Biome, DiagnosticSource::Vtsls],
            _ => &[DiagnosticSource::Vtsls],
        };
        let session = {
            let state = self.state();
            let language_id = state
                .open
                .get(path)
                .map(|document| document.language_id)
                .ok_or(LspError::NoServer)?;
            preference
                .iter()
                .find_map(|source| {
                    state.servers.iter().find(|server| {
                        server.session.source() == *source
                            && server.session.is_alive()
                            && server.language_ids.contains(&language_id)
                    })
                })
                .map(|server| Arc::clone(&server.session))
                .ok_or(LspError::NoServer)?
        };
        session.request_feature(path, self.gate.workspace_root(), request, timeout)
    }

    pub fn document_closed(&self, path: &Path) {
        let mut state = self.state();
        if state.open.remove(path).is_some() {
            for server in &state.servers {
                let _ = server.session.close_document(path);
            }
        }
    }

    /// Stops every server (trust revoked, workspace closed). Open documents are remembered so
    /// that servers started again later pick them up.
    pub fn stop(&self) {
        for server in self.state().servers.drain(..) {
            server.session.shutdown();
        }
    }
}

impl Drop for LanguageServices {
    fn drop(&mut self) {
        self.stop();
    }
}
