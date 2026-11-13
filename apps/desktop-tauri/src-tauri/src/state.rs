use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Mutex;

use context_engine::SqliteWalContextEngine;

use crate::bridge::DesktopBinaryEditorBridge;

/// State shared by every Tauri command.
pub(crate) struct DesktopAppState {
    pub(crate) bridge: Mutex<DesktopBinaryEditorBridge>,
    pub(crate) workspace_root: Mutex<Option<PathBuf>>,
    pub(crate) app_data_dir: PathBuf,
    pub(crate) context_engine: Mutex<Option<SqliteWalContextEngine>>,
    /// Bumped (under the `context_engine` lock) each time a workspace is opened. An index built
    /// for an older workspace is discarded instead of being installed.
    pub(crate) workspace_generation: AtomicU64,
    /// Serializes index rebuilds: they all write the same SQLite file.
    pub(crate) index_build: Mutex<()>,
}

impl DesktopAppState {
    pub(crate) fn new(bridge: DesktopBinaryEditorBridge, app_data_dir: PathBuf) -> Self {
        Self {
            bridge: Mutex::new(bridge),
            workspace_root: Mutex::new(None),
            app_data_dir,
            context_engine: Mutex::new(None),
            workspace_generation: AtomicU64::new(0),
            index_build: Mutex::new(()),
        }
    }
}

#[cfg(test)]
pub(crate) fn test_state(data_dir: &std::path::Path) -> DesktopAppState {
    DesktopAppState::new(
        DesktopBinaryEditorBridge::with_journal(data_dir.join("documents.wal")).unwrap(),
        data_dir.to_path_buf(),
    )
}
