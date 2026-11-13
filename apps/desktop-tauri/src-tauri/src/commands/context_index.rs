//! The workspace search index, built off the main thread and discarded if it went stale.

use std::sync::atomic::Ordering;

use context_engine::{AclAndSecretScanner, SqliteWalContextEngine};
use serde::Serialize;
use tauri::Manager;

use crate::bridge::DesktopBinaryEditorBridge;
use crate::state::DesktopAppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBackgroundServicesState {
    vtsls_lsp_ready: bool,
    biome_daemon_ready: bool,
    sqlite_fts5_ready: bool,
    sandbox_warm_pool_ready: bool,
}

/// Indexing reads every file of the workspace: it runs on a blocking worker, never on the main
/// thread, and without holding the `context_engine` lock (search answers "not initialized"
/// meanwhile instead of hanging).
#[tauri::command]
pub async fn initialize_background_services_command(
    app: tauri::AppHandle,
) -> Result<DesktopBackgroundServicesState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopAppState>();
        let sqlite_fts5_ready = ensure_context_engine(&state);
        let servers = start_language_servers(&state);
        DesktopBackgroundServicesState {
            vtsls_lsp_ready: servers.vtsls,
            biome_daemon_ready: servers.biome,
            sqlite_fts5_ready,
            sandbox_warm_pool_ready: false,
        }
    })
    .await
    .map_err(|error| format!("Background services task failed: {error}"))
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct LanguageServersReady {
    pub(crate) biome: bool,
    pub(crate) vtsls: bool,
}

/// Starts the language servers of the open workspace, if it is trusted. On an untrusted
/// workspace (or with none open) nothing is resolved or launched and nothing is reported ready.
pub(crate) fn start_language_servers(state: &DesktopAppState) -> LanguageServersReady {
    let gate = state.trust_gate.lock().ok().and_then(|gate| gate.clone());
    let (Some(gate), Some(services)) = (gate, state.language_services()) else {
        return LanguageServersReady::default();
    };
    let biome = host_core::resolve_workspace_tool(&gate, "biome")
        .is_some_and(|program| services.ensure_server(&host_core::biome_server_spec(program)));
    let vtsls = host_core::resolve_workspace_tool(&gate, "vtsls")
        .is_some_and(|program| services.ensure_server(&host_core::vtsls_server_spec(program)));
    LanguageServersReady { biome, vtsls }
}

pub(crate) fn ensure_context_engine(state: &DesktopAppState) -> bool {
    let Ok(_build) = state.index_build.lock() else {
        return false;
    };
    if state
        .context_engine
        .lock()
        .map(|engine| engine.is_some())
        .unwrap_or(false)
    {
        return true;
    }
    // Generation first, then root: a root read after a newer generation is always the new one.
    let generation = state.workspace_generation.load(Ordering::SeqCst);
    let workspace_root = state
        .workspace_root
        .lock()
        .ok()
        .and_then(|root| root.clone());
    let db_path = state.app_data_dir.join("context.sqlite3");
    let built = match workspace_root.as_deref() {
        Some(root) => SqliteWalContextEngine::open(
            &db_path,
            "workspace",
            AclAndSecretScanner::from_workspace_root(root),
        )
        .and_then(|mut context| {
            context.rebuild_from_workspace(root)?;
            Ok(context)
        })
        .ok(),
        None => DesktopBinaryEditorBridge::open_context_engine(&db_path, "workspace").ok(),
    };
    install_context_engine(state, generation, built)
}

/// Installs `built` unless another workspace was opened since `generation` was read.
fn install_context_engine(
    state: &DesktopAppState,
    generation: u64,
    built: Option<SqliteWalContextEngine>,
) -> bool {
    let Ok(mut engine) = state.context_engine.lock() else {
        return false;
    };
    if state.workspace_generation.load(Ordering::SeqCst) == generation && engine.is_none() {
        *engine = built;
    }
    engine.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::workspace::load_workspace;
    use crate::state::test_state;

    /// LOT-010 end to end through the desktop shell, with the real Biome binary of this
    /// repository: nothing runs before trust; after it, edits applied to the rope come back as
    /// diagnostics tagged with their revision; leaving the workspace kills the server.
    #[cfg(unix)]
    #[test]
    fn biome_runs_only_after_trust_follows_the_buffer_and_dies_with_the_workspace() {
        use crate::commands::documents::{apply_transaction, open_document};
        use crate::commands::trust::{apply_trust_decision, revoke_workspace_trust};
        use crate::state::test_state_collecting_diagnostics;
        use host_core::{
            encode_editor_transaction_ipc, DiagnosticSource, EditorSelection, EditorTransaction,
            TextChange, TransactionOrigin, Utf16CodeUnitOffset, Utf16Span, CONTRACT_SCHEMA_VERSION,
        };
        use std::os::unix::fs::PermissionsExt;
        use std::time::Duration;

        let real_biome = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../node_modules/.bin/biome")
            .canonicalize()
            .expect("the real Biome binary is required: run `pnpm install`");
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        // The workspace's own Biome, as `pnpm install` would leave it.
        let bin = workspace.path().join("node_modules/.bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(
            bin.join("biome"),
            format!("#!/bin/sh\nexec '{}' \"$@\"\n", real_biome.display()),
        )
        .unwrap();
        std::fs::set_permissions(bin.join("biome"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        std::fs::write(workspace.path().join("main.ts"), "export const a = 1;\n").unwrap();

        let (state, diagnostics) = test_state_collecting_diagnostics(data.path());
        load_workspace(&state, workspace.path().to_str().unwrap()).unwrap();
        let gate = state.trust_gate.lock().unwrap().clone().unwrap();
        open_document(&state, "main.ts".into(), 1, "export const a = 1;\n").unwrap();

        // Untrusted: asking for the services starts nothing.
        assert_eq!(
            start_language_servers(&state),
            LanguageServersReady::default()
        );
        assert_eq!(gate.spawned_process_count(), 0);

        apply_trust_decision(&gate, true).unwrap();
        assert!(start_language_servers(&state).biome);
        let services = state.language_services().unwrap();
        let pid = services.server_process_ids()[0];

        // The user types `var b = a == 2;` at the end: revision 1.
        let end = "export const a = 1;\n".len() as u32;
        let tx = EditorTransaction {
            schema_version: CONTRACT_SCHEMA_VERSION,
            document_id: "main.ts".into(),
            session_generation: 1,
            base_revision: 0,
            op_id: "op-1".into(),
            changes: vec![TextChange {
                range_utf16: Utf16Span::new(
                    Utf16CodeUnitOffset::new(end),
                    Utf16CodeUnitOffset::new(end),
                ),
                range_utf8: None,
                inserted_text: "export const b = a == 2;\n".into(),
            }],
            selection: EditorSelection::default(),
            origin: TransactionOrigin::User,
            ime_composing: false,
        };
        apply_transaction(&state, &encode_editor_transaction_ipc(&tx).unwrap()).unwrap();

        let batch = loop {
            let batch = diagnostics
                .recv_timeout(Duration::from_secs(20))
                .expect("Biome diagnostics for revision 1");
            if batch.base_revision == 1 {
                break batch;
            }
        };
        assert_eq!(batch.source, DiagnosticSource::Biome);
        assert_eq!(batch.document_id, "main.ts");
        let flagged = batch
            .items
            .iter()
            .find(|item| item.code == "lint/suspicious/noDoubleEquals")
            .expect("the `==` typed in revision 1 is reported");
        assert_eq!(
            flagged.span_utf16.start.as_u32(),
            end + "export const b = a ".len() as u32
        );

        // Formatting is answered by Biome about revision 1; asking about revision 0, which
        // the buffer has left, is refused instead of being answered against newer text.
        let request = |revision| host_core::LanguageFeatureRequest {
            document_id: "main.ts".into(),
            session_generation: 1,
            revision,
            position_utf16: Utf16CodeUnitOffset::new(0),
            feature: host_core::LanguageFeature::Formatting,
        };
        let formatted = crate::commands::language::language_feature(&state, &request(1)).unwrap();
        assert_eq!(formatted.base_revision, 1);
        assert!(matches!(
            formatted.result,
            host_core::LanguageFeatureResult::Edits { .. }
        ));
        assert!(crate::commands::language::language_feature(&state, &request(0)).is_err());

        // Opening another folder stops the first workspace's server.
        load_workspace(&state, other.path().to_str().unwrap()).unwrap();
        assert!(!services.is_running(DiagnosticSource::Biome));
        let alive = || {
            std::process::Command::new("ps")
                .args(["-o", "stat=", "-p", &pid.to_string()])
                .output()
                .is_ok_and(|out| {
                    out.status.success()
                        && !String::from_utf8_lossy(&out.stdout).trim().starts_with('Z')
                })
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while alive() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(!alive(), "Biome survived its workspace");
        // And the new, untrusted workspace has none.
        assert_eq!(
            start_language_servers(&state),
            LanguageServersReady::default()
        );
        let _ = revoke_workspace_trust(&state);
    }

    #[test]
    fn an_index_built_for_a_previous_workspace_is_discarded() {
        let data = tempfile::tempdir().unwrap();
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let state = test_state(data.path());
        load_workspace(&state, first.path().to_str().unwrap()).unwrap();
        let stale_generation = state.workspace_generation.load(Ordering::SeqCst);
        let stale = DesktopBinaryEditorBridge::open_context_engine(
            &data.path().join("stale.sqlite3"),
            "workspace",
        )
        .ok();

        // The user switches project while the first index is still being built.
        load_workspace(&state, second.path().to_str().unwrap()).unwrap();
        assert!(!install_context_engine(&state, stale_generation, stale));
        assert!(state.context_engine.lock().unwrap().is_none());

        // The rebuild for the current workspace is installed normally.
        assert!(ensure_context_engine(&state));
    }
}
