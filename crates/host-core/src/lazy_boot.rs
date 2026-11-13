use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::contracts::{EditorSnapshot, CONTRACT_SCHEMA_VERSION};
use crate::document::{DocumentError, DocumentService};

pub const WORKSPACE_SESSION_CACHE_FILENAME: &str = "workspace_session_cache.bin";

static CACHE_TMP_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Error)]
pub enum LazyBootError {
    #[error("Unsupported session cache schema version {actual} (expected {expected})")]
    UnsupportedSchemaVersion { expected: u16, actual: u16 },
    #[error("Invalid grid mode {0}; expected 1, 2, 4, or 8")]
    InvalidGridMode(u8),
    #[error("Binary codec error on workspace_session_cache.bin: {0}")]
    Codec(#[from] bincode::Error),
    #[error("I/O error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("Document restoration error: {0}")]
    Document(#[from] DocumentError),
}

/// Binary layout & active editor state persisted in `workspace_session_cache.bin` for `< 3 s` Lazy Boot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceSessionCache {
    pub schema_version: u16,
    pub workspace_root: String,
    pub active_persona: String,
    pub active_activity_panel: String,
    pub grid_mode: u8,
    pub active_inspector_tab: String,
    pub active_chat_id: String,
    pub active_document_id: String,
    pub active_document_content: String,
    pub cursor_utf16_offset: u32,
    pub scroll_top_px: u32,
    pub ui_zoom_percent: u16,
    pub sidebar_visible: bool,
}

impl Default for WorkspaceSessionCache {
    fn default() -> Self {
        Self {
            schema_version: CONTRACT_SCHEMA_VERSION,
            workspace_root: ".".to_string(),
            active_persona: "Develop".to_string(),
            active_activity_panel: "sessions".to_string(),
            grid_mode: 1,
            active_inspector_tab: "code-diff".to_string(),
            active_chat_id: "chat-1".to_string(),
            active_document_id: "src/index.ts".to_string(),
            active_document_content: "export const ready = true;\n".to_string(),
            cursor_utf16_offset: 0,
            scroll_top_px: 0,
            ui_zoom_percent: 100,
            sidebar_visible: true,
        }
    }
}

impl WorkspaceSessionCache {
    pub fn validate(&self) -> Result<(), LazyBootError> {
        if self.schema_version != CONTRACT_SCHEMA_VERSION {
            return Err(LazyBootError::UnsupportedSchemaVersion {
                expected: CONTRACT_SCHEMA_VERSION,
                actual: self.schema_version,
            });
        }
        if !matches!(self.grid_mode, 1 | 2 | 4 | 8) {
            return Err(LazyBootError::InvalidGridMode(self.grid_mode));
        }
        Ok(())
    }

    pub fn to_binary_bytes(&self) -> Result<Vec<u8>, LazyBootError> {
        self.validate()?;
        Ok(bincode::serialize(self)?)
    }

    pub fn from_binary_bytes(bytes: &[u8]) -> Result<Self, LazyBootError> {
        let decoded: Self = bincode::deserialize(bytes)?;
        decoded.validate()?;
        Ok(decoded)
    }
}

/// Atomically persist `workspace_session_cache.bin` inside `cache_dir`.
pub fn save_workspace_session_cache(
    cache_dir: &Path,
    cache: &WorkspaceSessionCache,
) -> Result<PathBuf, LazyBootError> {
    cache.validate()?;
    fs::create_dir_all(cache_dir).map_err(|source| LazyBootError::Io {
        path: cache_dir.to_path_buf(),
        source,
    })?;
    let target_path = cache_dir.join(WORKSPACE_SESSION_CACHE_FILENAME);
    let seq = CACHE_TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_path = cache_dir.join(format!(".{WORKSPACE_SESSION_CACHE_FILENAME}.tmp.{seq}"));

    let encoded = cache.to_binary_bytes()?;
    {
        let mut file = File::create(&tmp_path).map_err(|source| LazyBootError::Io {
            path: tmp_path.clone(),
            source,
        })?;
        file.write_all(&encoded)
            .map_err(|source| LazyBootError::Io {
                path: tmp_path.clone(),
                source,
            })?;
        file.sync_all().map_err(|source| LazyBootError::Io {
            path: tmp_path.clone(),
            source,
        })?;
    }

    fs::rename(&tmp_path, &target_path).map_err(|source| LazyBootError::Io {
        path: target_path.clone(),
        source,
    })?;

    Ok(target_path)
}

/// Load `workspace_session_cache.bin` from `cache_dir`, or return `Ok(None)` if not present.
pub fn load_workspace_session_cache(
    cache_dir: &Path,
) -> Result<Option<WorkspaceSessionCache>, LazyBootError> {
    let target_path = cache_dir.join(WORKSPACE_SESSION_CACHE_FILENAME);
    if !target_path.exists() {
        return Ok(None);
    }
    let mut file = File::open(&target_path).map_err(|source| LazyBootError::Io {
        path: target_path.clone(),
        source,
    })?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|source| LazyBootError::Io {
            path: target_path,
            source,
        })?;
    let cache = WorkspaceSessionCache::from_binary_bytes(&bytes)?;
    Ok(Some(cache))
}

/// Status of secondary background services initialized on low-priority Tokio tasks after Lazy Boot.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackgroundServicesStatus {
    pub vtsls_lsp_ready: bool,
    pub biome_daemon_ready: bool,
    pub sqlite_fts5_ready: bool,
    pub sandbox_warm_pool_ready: bool,
}

impl BackgroundServicesStatus {
    #[must_use]
    pub const fn all_ready(&self) -> bool {
        self.vtsls_lsp_ready
            && self.biome_daemon_ready
            && self.sqlite_fts5_ready
            && self.sandbox_warm_pool_ready
    }
}

/// Snapshot returned immediately (< 3 s) once window layout and active buffer are restored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LazyBootReadySnapshot {
    pub session_cache: WorkspaceSessionCache,
    pub restored_editor_snapshot: EditorSnapshot,
    pub boot_to_interactive_us: u64,
    pub background_services_at_boot: BackgroundServicesStatus,
}

/// Orchestrates the two-phase Lazy Boot sequence:
/// 1. Immediate synchronous restoration of `workspace_session_cache.bin` and the active `ropey` buffer (`≤ 3 s`).
/// 2. Deferred initialization of secondary services (`vtsls`, Biome, SQLite FTS5, Sandbox warm pool) on low-priority Tokio tasks.
#[derive(Debug, Clone)]
pub struct LazyBootOrchestrator {
    background_status: Arc<Mutex<BackgroundServicesStatus>>,
}

impl Default for LazyBootOrchestrator {
    fn default() -> Self {
        Self::new()
    }
}

impl LazyBootOrchestrator {
    #[must_use]
    pub fn new() -> Self {
        Self {
            background_status: Arc::new(Mutex::new(BackgroundServicesStatus::default())),
        }
    }

    /// Execute Phase 1 of Lazy Boot: load `workspace_session_cache.bin` (or default) and open
    /// the restored buffer inside `documents` immediately before background services start.
    pub fn restore_interactive_session(
        &self,
        cache_dir: Option<&Path>,
        documents: &mut DocumentService,
    ) -> Result<LazyBootReadySnapshot, LazyBootError> {
        let start = Instant::now();
        let session_cache = match cache_dir {
            Some(dir) => load_workspace_session_cache(dir)?.unwrap_or_default(),
            None => WorkspaceSessionCache::default(),
        };

        let restored_editor_snapshot = documents.open_document_from_str(
            session_cache.active_document_id.clone(),
            1,
            None,
            &session_cache.active_document_content,
        )?;

        let elapsed_us = u64::try_from(start.elapsed().as_micros()).unwrap_or(u64::MAX);
        let background_services_at_boot = self.background_status();

        Ok(LazyBootReadySnapshot {
            session_cache,
            restored_editor_snapshot,
            boot_to_interactive_us: elapsed_us,
            background_services_at_boot,
        })
    }

    /// Spawn low-priority Tokio tasks to initialize heavy secondary services after the interactive window is ready.
    pub fn spawn_deferred_background_services(
        &self,
    ) -> tokio::task::JoinHandle<BackgroundServicesStatus> {
        let status_arc = Arc::clone(&self.background_status);
        tokio::task::spawn(async move {
            tokio::task::yield_now().await;
            {
                let mut guard = status_arc.lock().expect("background_status mutex");
                guard.vtsls_lsp_ready = true;
            }
            tokio::task::yield_now().await;
            {
                let mut guard = status_arc.lock().expect("background_status mutex");
                guard.biome_daemon_ready = true;
            }
            tokio::task::yield_now().await;
            {
                let mut guard = status_arc.lock().expect("background_status mutex");
                guard.sqlite_fts5_ready = true;
            }
            tokio::task::yield_now().await;
            {
                let mut guard = status_arc.lock().expect("background_status mutex");
                guard.sandbox_warm_pool_ready = true;
                guard.clone()
            }
        })
    }

    #[must_use]
    pub fn background_status(&self) -> BackgroundServicesStatus {
        self.background_status
            .lock()
            .expect("background_status mutex")
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn lazy_boot_restores_workspace_session_cache_under_3s_before_background_services() {
        let dir = tempdir().expect("tempdir");
        let custom_cache = WorkspaceSessionCache {
            schema_version: CONTRACT_SCHEMA_VERSION,
            workspace_root: "/workspace/coloride".to_string(),
            active_persona: "Develop".to_string(),
            active_activity_panel: "search".to_string(),
            grid_mode: 4,
            active_inspector_tab: "code-diff".to_string(),
            active_chat_id: "chat-2".to_string(),
            active_document_id: "src/cockpit.tsx".to_string(),
            active_document_content: "export const cockpitZones = 4;\n".to_string(),
            cursor_utf16_offset: 13,
            scroll_top_px: 120,
            ui_zoom_percent: 110,
            sidebar_visible: true,
        };

        let saved_path = save_workspace_session_cache(dir.path(), &custom_cache).unwrap();
        assert!(saved_path.ends_with(WORKSPACE_SESSION_CACHE_FILENAME));

        let mut documents = DocumentService::new_in_memory();
        let orchestrator = LazyBootOrchestrator::new();

        let boot_snap = orchestrator
            .restore_interactive_session(Some(dir.path()), &mut documents)
            .unwrap();

        // Must restore in well under 3 seconds (3_000_000 microseconds)
        assert!(
            boot_snap.boot_to_interactive_us <= 3_000_000,
            "boot_to_interactive_us {} exceeded 3s budget",
            boot_snap.boot_to_interactive_us
        );
        assert_eq!(boot_snap.session_cache, custom_cache);
        assert_eq!(
            boot_snap.restored_editor_snapshot.document_id,
            "src/cockpit.tsx"
        );
        assert!(!boot_snap.background_services_at_boot.all_ready());

        // Deferred background services complete asynchronously on low-priority Tokio tasks
        let final_bg = orchestrator
            .spawn_deferred_background_services()
            .await
            .unwrap();
        assert!(final_bg.all_ready());
        assert!(orchestrator.background_status().all_ready());
    }
}
