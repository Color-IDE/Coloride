//! Binary IPC bridge between the Tauri shell, CodeMirror 6 and the Rust host crates.

use std::path::{Path, PathBuf};

use context_engine::{
    AclAndSecretScanner, ContextSearchHit, ExtractedSymbol, ImpactAnalyzer, IncrementalAstParser,
    RopeTextProvider, SqliteWalContextEngine, SupportedAstLanguage, TestFileTarget,
};
use host_core::{
    decode_editor_transaction_ipc, encode_editor_snapshot_ipc, BackgroundServicesStatus,
    DocumentError, DocumentService, EditorSnapshot, LazyBootError, LazyBootOrchestrator,
    LazyBootReadySnapshot,
};

/// Binary IPC bridge connecting the Tauri v2 shell and CodeMirror 6 (`LOT-004`, `LOT-005`)
/// to `host_core::DocumentService` and `LazyBootOrchestrator`.
#[derive(Debug)]
pub struct DesktopBinaryEditorBridge {
    documents: DocumentService,
    lazy_boot: LazyBootOrchestrator,
}

impl Default for DesktopBinaryEditorBridge {
    fn default() -> Self {
        Self::new_in_memory()
    }
}

impl DesktopBinaryEditorBridge {
    #[must_use]
    pub fn new_in_memory() -> Self {
        Self {
            documents: DocumentService::new_in_memory(),
            lazy_boot: LazyBootOrchestrator::new(),
        }
    }

    pub fn with_journal(
        journal_path: impl Into<std::path::PathBuf>,
    ) -> Result<Self, DocumentError> {
        Ok(Self {
            documents: DocumentService::with_journal(journal_path)?,
            lazy_boot: LazyBootOrchestrator::new(),
        })
    }

    /// Execute Lazy Boot Phase 1 (`workspace_session_cache.bin` + active buffer restoration in `< 3 s`).
    pub fn lazy_boot_restore(
        &mut self,
        cache_dir: Option<&Path>,
    ) -> Result<LazyBootReadySnapshot, LazyBootError> {
        self.lazy_boot
            .restore_interactive_session(cache_dir, &mut self.documents)
    }

    /// Spawn low-priority Tokio tasks to initialize heavy secondary services after window restoration.
    pub fn spawn_background_services(&self) -> tokio::task::JoinHandle<BackgroundServicesStatus> {
        self.lazy_boot.spawn_deferred_background_services()
    }

    #[must_use]
    pub fn background_services_status(&self) -> BackgroundServicesStatus {
        self.lazy_boot.background_status()
    }

    pub fn open_document_binary(
        &mut self,
        document_id: impl Into<String>,
        session_generation: u32,
        initial_text: &str,
    ) -> Result<Vec<u8>, DocumentError> {
        let snapshot: EditorSnapshot = self.documents.open_document_from_str(
            document_id,
            session_generation,
            None,
            initial_text,
        )?;
        encode_editor_snapshot_ipc(&snapshot).map_err(|error| {
            DocumentError::EditorIpc(format!("EditorSnapshot IPC encode failed: {error}"))
        })
    }

    pub fn open_document_from_disk_binary(
        &mut self,
        document_id: impl Into<String>,
        session_generation: u32,
        disk_path: impl Into<PathBuf>,
    ) -> Result<Vec<u8>, DocumentError> {
        let snapshot =
            self.documents
                .open_document_from_disk(document_id, session_generation, disk_path)?;
        encode_editor_snapshot_ipc(&snapshot).map_err(|error| {
            DocumentError::EditorIpc(format!("EditorSnapshot IPC encode failed: {error}"))
        })
    }

    pub fn apply_binary_transaction(&mut self, tx_bytes: &[u8]) -> Result<Vec<u8>, DocumentError> {
        let tx = decode_editor_transaction_ipc(tx_bytes).map_err(|error| {
            DocumentError::EditorIpc(format!("EditorTransaction IPC decode failed: {error}"))
        })?;
        let snapshot = self.documents.apply_transaction(tx)?;
        encode_editor_snapshot_ipc(&snapshot).map_err(|error| {
            DocumentError::EditorIpc(format!("EditorSnapshot IPC encode failed: {error}"))
        })
    }

    #[must_use]
    pub const fn document_service(&self) -> &DocumentService {
        &self.documents
    }

    pub fn documents_mut(&mut self) -> &mut DocumentService {
        &mut self.documents
    }

    /// Analyze AST symbols and impacted tests (`LOT-007`) for a live buffer in `DocumentService`.
    pub fn analyze_document_ast_impact(
        &self,
        document_id: &str,
        session_generation: u32,
    ) -> Option<(Vec<ExtractedSymbol>, Vec<TestFileTarget>)> {
        let session = self
            .documents
            .session(document_id, session_generation)
            .ok()?;
        let mut parser = IncrementalAstParser::new();
        let lang = SupportedAstLanguage::from_path(document_id);
        let provider = RopeTextProvider::new(session.rope());
        let tree = parser.parse_with(lang, &provider, None);
        let symbols = tree.symbols();
        let pairs: Vec<(&str, &str)> = symbols
            .iter()
            .map(|s| (document_id, s.name.as_str()))
            .collect();
        let mut analyzer = ImpactAnalyzer::new();
        analyzer.index_file(document_id, session.rope(), &tree);
        let impacted = analyzer.find_impacted_tests(&pairs, 4);
        Some((symbols, impacted))
    }

    /// Query `SqliteWalContextEngine` (`LOT-008`) after synchronizing `UnsavedBufferOverlay`
    /// from `DocumentService` so unsaved edits in CodeMirror 6 take 100% priority.
    pub fn search_workspace_hybrid(
        &self,
        context_engine: &mut SqliteWalContextEngine,
        workspace_root: Option<&Path>,
        query: &str,
        limit: usize,
    ) -> Vec<ContextSearchHit> {
        context_engine
            .overlay_mut()
            .sync_from_document_service(workspace_root, &self.documents);
        context_engine.query_hybrid(query, limit)
    }

    /// Create an initialized `SqliteWalContextEngine` at `db_path` with default `AclAndSecretScanner`.
    pub fn open_context_engine(
        db_path: &Path,
        git_branch: &str,
    ) -> Result<SqliteWalContextEngine, context_engine::ContextStorageError> {
        SqliteWalContextEngine::open(db_path, git_branch, AclAndSecretScanner::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use host_core::{
        encode_editor_transaction_ipc, EditorSelection, EditorTransaction, TextChange,
        TransactionOrigin, Utf16CodeUnitOffset, Utf16Span, CONTRACT_SCHEMA_VERSION,
    };

    #[test]
    fn desktop_binary_editor_bridge_applies_transactions_and_guards_stale_generations() {
        let mut bridge = DesktopBinaryEditorBridge::new_in_memory();
        let open_bytes = bridge
            .open_document_binary("main.ts", 1, "const a = 1;\n")
            .unwrap();
        assert_eq!(&open_bytes[..4], &0x434c_534e_u32.to_le_bytes());
        assert_eq!(
            bridge
                .document_service()
                .session("main.ts", 1)
                .unwrap()
                .interactive_revision(),
            0
        );

        let tx = EditorTransaction {
            schema_version: CONTRACT_SCHEMA_VERSION,
            document_id: "main.ts".to_string(),
            session_generation: 1,
            base_revision: 0,
            op_id: "op-1".to_string(),
            changes: vec![TextChange {
                range_utf16: Utf16Span::new(
                    Utf16CodeUnitOffset::new(10),
                    Utf16CodeUnitOffset::new(11),
                ),
                range_utf8: None,
                inserted_text: "42".to_string(),
            }],
            selection: EditorSelection::default(),
            origin: TransactionOrigin::User,
            ime_composing: false,
        };
        let tx_bytes = encode_editor_transaction_ipc(&tx).unwrap();
        let snap_bytes = bridge.apply_binary_transaction(&tx_bytes).unwrap();
        assert_eq!(&snap_bytes[..4], &0x434c_534e_u32.to_le_bytes());
        assert_eq!(
            bridge
                .document_service()
                .session("main.ts", 1)
                .unwrap()
                .text(),
            "const a = 42;\n"
        );
    }

    #[test]
    fn desktop_binary_editor_bridge_rejects_malformed_ipc_without_panicking() {
        let mut bridge = DesktopBinaryEditorBridge::new_in_memory();
        bridge
            .open_document_binary("main.ts", 1, "const safe = true;\n")
            .unwrap();
        let error = bridge.apply_binary_transaction(&[0x43, 0x4c]).unwrap_err();
        assert!(error.to_string().contains("IPC decode failed"));
        assert_eq!(
            bridge
                .document_service()
                .session("main.ts", 1)
                .unwrap()
                .text(),
            "const safe = true;\n"
        );
    }

    #[tokio::test]
    async fn desktop_lazy_boot_restores_cached_session_and_accepts_first_keystroke_under_3s() {
        let dir = tempfile::tempdir().unwrap();
        let cache = host_core::WorkspaceSessionCache {
            schema_version: CONTRACT_SCHEMA_VERSION,
            workspace_root: "/workspace/app".to_string(),
            active_persona: "Develop".to_string(),
            active_activity_panel: "sessions".to_string(),
            grid_mode: 4,
            active_inspector_tab: "code-diff".to_string(),
            active_chat_id: "chat-1".to_string(),
            active_document_id: "src/app.ts".to_string(),
            active_document_content: "const ready = false;\n".to_string(),
            cursor_utf16_offset: 14,
            scroll_top_px: 0,
            ui_zoom_percent: 100,
            sidebar_visible: true,
        };
        host_core::save_workspace_session_cache(dir.path(), &cache).unwrap();

        let boot_start = std::time::Instant::now();
        let mut bridge = DesktopBinaryEditorBridge::new_in_memory();
        let boot_snap = bridge.lazy_boot_restore(Some(dir.path())).unwrap();
        let bg_handle = bridge.spawn_background_services();

        // First keystroke immediately after window restoration (before background services complete)
        let first_keystroke = EditorTransaction {
            schema_version: CONTRACT_SCHEMA_VERSION,
            document_id: boot_snap.session_cache.active_document_id.clone(),
            session_generation: 1,
            base_revision: 0,
            op_id: "first-keystroke".to_string(),
            changes: vec![TextChange {
                range_utf16: Utf16Span::new(
                    Utf16CodeUnitOffset::new(14),
                    Utf16CodeUnitOffset::new(19),
                ),
                range_utf8: None,
                inserted_text: "true".to_string(),
            }],
            selection: EditorSelection::default(),
            origin: TransactionOrigin::User,
            ime_composing: false,
        };
        let tx_bytes = encode_editor_transaction_ipc(&first_keystroke).unwrap();
        bridge.apply_binary_transaction(&tx_bytes).unwrap();
        let first_keystroke_elapsed = boot_start.elapsed();

        assert!(
            first_keystroke_elapsed.as_millis() <= 3_000,
            "Lazy Boot + first keystroke took {} ms (> 3000 ms)",
            first_keystroke_elapsed.as_millis()
        );
        assert_eq!(
            bridge
                .document_service()
                .session("src/app.ts", 1)
                .unwrap()
                .interactive_revision(),
            1
        );
        assert_eq!(
            bridge
                .document_service()
                .session("src/app.ts", 1)
                .unwrap()
                .text(),
            "const ready = true;\n"
        );

        let bg_status = bg_handle.await.unwrap();
        assert!(bg_status.all_ready());
    }
}
