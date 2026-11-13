use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
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
    /// Files with unsaved changes, as last reported by the UI (which also holds the edits of the
    /// projects that are not open in the editor). Closing the window asks first while it is > 0.
    pub(crate) unsaved_buffers: AtomicUsize,
    /// Set once the user has answered the close prompt, so the exit that follows goes through.
    pub(crate) exit_confirmed: AtomicBool,
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
            unsaved_buffers: AtomicUsize::new(0),
            exit_confirmed: AtomicBool::new(false),
        }
    }

    /// Whether closing the window or quitting must first ask the UI what to do with unsaved edits.
    pub(crate) fn close_needs_confirmation(&self) -> bool {
        !self.exit_confirmed.load(Ordering::SeqCst)
            && self.unsaved_buffers.load(Ordering::SeqCst) > 0
    }
}

#[cfg(test)]
pub(crate) fn test_state(data_dir: &std::path::Path) -> DesktopAppState {
    DesktopAppState::new(
        DesktopBinaryEditorBridge::with_journal(data_dir.join("documents.wal")).unwrap(),
        data_dir.to_path_buf(),
    )
}
