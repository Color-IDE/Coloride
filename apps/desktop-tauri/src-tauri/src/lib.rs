//! Coloride desktop shell: wires the Rust host crates to the Tauri v2 window.

mod bridge;
mod commands;
mod state;

use context_engine::ContextEngineStatus;
use host_core::HostHealthStatus;
use judge_orchestrator::JudgeHealthStatus;
use sandbox_runner::SandboxCapabilities;
use serde::{Deserialize, Serialize};
use tauri::Manager;

pub use bridge::DesktopBinaryEditorBridge;
use state::DesktopAppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let bridge = DesktopBinaryEditorBridge::with_journal(data_dir.join("documents.wal"))?;
            app.manage(DesktopAppState::new(bridge, data_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::documents::open_document_binary_command,
            commands::documents::apply_binary_transaction_command,
            commands::documents::save_document_binary_command,
            commands::workspace::load_workspace_command,
            commands::workspace::read_workspace_file_command,
            commands::session_cache::load_session_cache_command,
            commands::session_cache::save_session_cache_command,
            commands::context_index::initialize_background_services_command,
            commands::search::search_workspace_command,
            commands::search::analyze_document_command,
            commands::migration::run_native_migration_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running Coloride");
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_shell_aggregates_all_four_rust_crates() {
        let report = collect_system_diagnostics();
        assert!(report.host.ready);
        assert!(report.context.zero_mb_boot_ready);
        assert!(report.judge.deterministic_evidence_required);
        assert!(!report.judge.policy_engine_operational);
        assert!(report.sandbox.fail_closed_enforced);
        assert!(!report.sandbox.execution_available);
    }
}
