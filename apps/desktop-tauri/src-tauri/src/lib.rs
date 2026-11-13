//! Coloride desktop shell: wires the Rust host crates to the Tauri v2 window.

mod bridge;
mod commands;
mod state;

use context_engine::ContextEngineStatus;
use host_core::HostHealthStatus;
use judge_orchestrator::JudgeHealthStatus;
use sandbox_runner::SandboxCapabilities;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

pub use bridge::DesktopBinaryEditorBridge;
use state::DesktopAppState;

/// Event carrying a `DocumentDiagnostics` batch to the UI.
pub(crate) const DOCUMENT_DIAGNOSTICS_EVENT: &str = "coloride-document-diagnostics";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Closing the window with unsaved changes: hold it back and ask the UI first.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let held_back = window
                    .try_state::<DesktopAppState>()
                    .is_some_and(|state| state.close_needs_confirmation());
                if held_back {
                    api.prevent_close();
                    commands::window::request_close_confirmation(window.app_handle());
                }
            }
        })
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let bridge = DesktopBinaryEditorBridge::with_journal(data_dir.join("documents.wal"))?;
            // Diagnostics reach the UI tagged with the revision they were computed for; the
            // editor discards the ones its text has moved past.
            let handle = app.handle().clone();
            let diagnostics_sink: host_core::DiagnosticsSink = std::sync::Arc::new(move |batch| {
                let _ = handle.emit(DOCUMENT_DIAGNOSTICS_EVENT, batch);
            });
            app.manage(DesktopAppState::new(bridge, data_dir, diagnostics_sink));
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
            commands::migration::run_native_migration_command,
            commands::language::language_feature_command,
            commands::terminal::terminal_open_command,
            commands::terminal::terminal_write_command,
            commands::terminal::terminal_resize_command,
            commands::terminal::terminal_close_command,
            commands::trust::workspace_trust_command,
            commands::trust::request_workspace_trust_command,
            commands::trust::revoke_workspace_trust_command,
            commands::window::report_unsaved_buffers_command,
            commands::window::confirm_exit_command
        ])
        .build(tauri::generate_context!())
        .expect("error while building Coloride");

    app.run(|handle, event| {
        // Quitting (Cmd/Ctrl+Q, or the last window closing) with unsaved changes. An exit asked for
        // with a code (`app.exit`) is the one the user already confirmed.
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            let held_back = code.is_none()
                && handle
                    .try_state::<DesktopAppState>()
                    .is_some_and(|state| state.close_needs_confirmation());
            if held_back {
                api.prevent_exit();
                commands::window::request_close_confirmation(handle);
            }
        }
    });
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
