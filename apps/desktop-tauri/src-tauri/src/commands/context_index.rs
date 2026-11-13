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
        let sqlite_fts5_ready = ensure_context_engine(&app.state::<DesktopAppState>());
        // Workspace-local language servers and tools remain disabled until an explicit
        // trust decision exists. Reporting them as ready here would violate fail-closed trust.
        DesktopBackgroundServicesState {
            vtsls_lsp_ready: false,
            biome_daemon_ready: false,
            sqlite_fts5_ready,
            sandbox_warm_pool_ready: false,
        }
    })
    .await
    .map_err(|error| format!("Background services task failed: {error}"))
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
