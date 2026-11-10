use context_engine::ContextEngineStatus;
use host_core::{
    decode_contract_binary, encode_contract_binary, DocumentError, DocumentService, EditorSnapshot,
    EditorTransaction, HostHealthStatus,
};
use judge_orchestrator::JudgeHealthStatus;
use sandbox_runner::SandboxCapabilities;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SystemDiagnosticsReport {
    pub host: HostHealthStatus,
    pub context: ContextEngineStatus,
    pub judge: JudgeHealthStatus,
    pub sandbox: SandboxCapabilities,
}

pub fn collect_system_diagnostics() -> SystemDiagnosticsReport {
    SystemDiagnosticsReport {
        host: host_core::healthcheck(),
        context: context_engine::healthcheck(),
        judge: judge_orchestrator::healthcheck(),
        sandbox: sandbox_runner::healthcheck(),
    }
}

/// Binary IPC bridge connecting the Tauri v2 shell and CodeMirror 6 (`LOT-004`) to `host_core::DocumentService`.
#[derive(Debug)]
pub struct DesktopBinaryEditorBridge {
    documents: DocumentService,
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
        }
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
        Ok(encode_contract_binary(&snapshot).expect("EditorSnapshot binary encode"))
    }

    pub fn apply_binary_transaction(&mut self, tx_bytes: &[u8]) -> Result<Vec<u8>, DocumentError> {
        let tx: EditorTransaction =
            decode_contract_binary(tx_bytes).expect("valid EditorTransaction binary payload");
        let snapshot = self.documents.apply_transaction(tx)?;
        Ok(encode_contract_binary(&snapshot).expect("EditorSnapshot binary encode"))
    }

    #[must_use]
    pub const fn document_service(&self) -> &DocumentService {
        &self.documents
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use host_core::{
        EditorSelection, TextChange, TransactionOrigin, Utf16CodeUnitOffset, Utf16Span,
        CONTRACT_SCHEMA_VERSION,
    };

    #[test]
    fn desktop_shell_aggregates_all_four_rust_crates() {
        let report = collect_system_diagnostics();
        assert!(report.host.ready);
        assert!(report.context.zero_mb_boot_ready);
        assert!(report.judge.deterministic_evidence_required);
        assert!(report.sandbox.fail_closed_enforced);
    }

    #[test]
    fn desktop_binary_editor_bridge_applies_transactions_and_guards_stale_generations() {
        let mut bridge = DesktopBinaryEditorBridge::new_in_memory();
        let open_bytes = bridge
            .open_document_binary("main.ts", 1, "const a = 1;\n")
            .unwrap();
        let open_snap: EditorSnapshot = decode_contract_binary(&open_bytes).unwrap();
        assert_eq!(open_snap.interactive_revision, 0);

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
        let tx_bytes = encode_contract_binary(&tx).unwrap();
        let snap_bytes = bridge.apply_binary_transaction(&tx_bytes).unwrap();
        let snap: EditorSnapshot = decode_contract_binary(&snap_bytes).unwrap();
        assert_eq!(snap.interactive_revision, 1);
        assert_eq!(
            bridge
                .document_service()
                .session("main.ts", 1)
                .unwrap()
                .text(),
            "const a = 42;\n"
        );
    }
}
