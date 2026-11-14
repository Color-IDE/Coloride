use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use context_engine::SqliteWalContextEngine;
use host_core::{
    DiagnosticsSink, LanguageServices, LatestDiagnostics, WorkspaceTrustGate,
    WORKSPACE_TRUST_STORE_FILENAME,
};

use crate::bridge::DesktopBinaryEditorBridge;

/// State shared by every Tauri command.
pub(crate) struct DesktopAppState {
    pub(crate) bridge: Mutex<DesktopBinaryEditorBridge>,
    pub(crate) workspace_root: Mutex<Option<PathBuf>>,
    /// Trust gate of the open workspace. `None` (no workspace, or a root whose decision cannot
    /// be recorded) means untrusted: nothing may be launched.
    pub(crate) trust_gate: Mutex<Option<WorkspaceTrustGate>>,
    /// Language servers of the open workspace. They exist only for a workspace with a gate and
    /// run only once it is trusted; replacing or dropping them kills their processes.
    pub(crate) language_services: Mutex<Option<Arc<LanguageServices>>>,
    /// Where revision-tagged diagnostics go: recorded in `latest_diagnostics`, then sent to
    /// the UI (a Tauri event).
    pub(crate) diagnostics_sink: DiagnosticsSink,
    /// Each open document's diagnostics for its newest content, per tool: what the context
    /// MCP server publishes (`LocalMcpServer::publish_document_diagnostics`).
    pub(crate) latest_diagnostics: Arc<LatestDiagnostics>,
    /// Open terminals by id. Dropping one kills its shell and jobs.
    pub(crate) terminals: Mutex<HashMap<u32, Arc<host_core::TerminalSession>>>,
    pub(crate) next_terminal_id: AtomicU32,
    /// The program being debugged, if any (one at a time).
    pub(crate) debug_session: Mutex<Option<Arc<host_core::DebugSession>>>,
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
    pub(crate) fn new(
        bridge: DesktopBinaryEditorBridge,
        app_data_dir: PathBuf,
        diagnostics_sink: DiagnosticsSink,
    ) -> Self {
        let latest_diagnostics = Arc::new(LatestDiagnostics::new());
        Self {
            bridge: Mutex::new(bridge),
            workspace_root: Mutex::new(None),
            trust_gate: Mutex::new(None),
            language_services: Mutex::new(None),
            diagnostics_sink: {
                let latest = Arc::clone(&latest_diagnostics);
                Arc::new(move |batch| {
                    latest.record(batch.clone());
                    diagnostics_sink(batch);
                })
            },
            latest_diagnostics,
            terminals: Mutex::new(HashMap::new()),
            next_terminal_id: AtomicU32::new(1),
            debug_session: Mutex::new(None),
            app_data_dir,
            context_engine: Mutex::new(None),
            workspace_generation: AtomicU64::new(0),
            index_build: Mutex::new(()),
            unsaved_buffers: AtomicUsize::new(0),
            exit_confirmed: AtomicBool::new(false),
        }
    }

    /// Where the user's trust decisions are kept (survives restarts).
    pub(crate) fn trust_store_path(&self) -> PathBuf {
        self.app_data_dir.join(WORKSPACE_TRUST_STORE_FILENAME)
    }

    pub(crate) fn language_services(&self) -> Option<Arc<LanguageServices>> {
        self.language_services
            .lock()
            .ok()
            .and_then(|services| services.clone())
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
        Arc::new(|_| {}),
    )
}

/// Like `test_state`, collecting the diagnostics that would be sent to the UI. Only the Unix-only
/// language-server test uses it.
#[cfg(all(test, unix))]
pub(crate) fn test_state_collecting_diagnostics(
    data_dir: &std::path::Path,
) -> (
    DesktopAppState,
    std::sync::mpsc::Receiver<host_core::DocumentDiagnostics>,
) {
    let (sender, receiver) = std::sync::mpsc::channel();
    let sender = Mutex::new(sender);
    let state = DesktopAppState::new(
        DesktopBinaryEditorBridge::with_journal(data_dir.join("documents.wal")).unwrap(),
        data_dir.to_path_buf(),
        Arc::new(move |batch| {
            if let Ok(sender) = sender.lock() {
                let _ = sender.send(batch);
            }
        }),
    );
    (state, receiver)
}
