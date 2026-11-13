//! Opening a workspace folder and reading its files, always inside the authorized root.

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::Manager;

use crate::state::DesktopAppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileNode {
    path: String,
    name: String,
    depth: usize,
    is_directory: bool,
}

fn collect_workspace_nodes(
    root: &Path,
    current: &Path,
    depth: usize,
    nodes: &mut Vec<WorkspaceFileNode>,
) -> Result<(), String> {
    if nodes.len() >= 50_000 {
        return Ok(());
    }
    let mut entries = std::fs::read_dir(current)
        .map_err(|error| format!("Failed to read {}: {error}", current.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to enumerate {}: {error}", current.display()))?;
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());

    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if matches!(name.as_str(), ".git" | "node_modules" | "target" | "dist") {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "Workspace path escaped its authorized root".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        nodes.push(WorkspaceFileNode {
            path: relative,
            name,
            depth,
            is_directory: file_type.is_dir(),
        });
        if file_type.is_dir() {
            collect_workspace_nodes(root, &path, depth + 1, nodes)?;
        }
        if nodes.len() >= 50_000 {
            break;
        }
    }
    Ok(())
}

/// Walking a large project must not run on the main thread: on macOS that thread presents the
/// window's frames, so the whole UI would freeze until the walk ends.
#[tauri::command]
pub async fn load_workspace_command(
    app: tauri::AppHandle,
    root: String,
) -> Result<Vec<WorkspaceFileNode>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        load_workspace(&app.state::<DesktopAppState>(), &root)
    })
    .await
    .map_err(|error| format!("Workspace loading task failed: {error}"))?
}

pub(crate) fn load_workspace(
    state: &DesktopAppState,
    root: &str,
) -> Result<Vec<WorkspaceFileNode>, String> {
    let canonical = PathBuf::from(root)
        .canonicalize()
        .map_err(|error| format!("Failed to open workspace: {error}"))?;
    if !canonical.is_dir() {
        return Err("Selected workspace is not a directory".to_string());
    }
    let mut nodes = Vec::new();
    collect_workspace_nodes(&canonical, &canonical, 0, &mut nodes)?;
    // Root, engine reset and generation change together, so an index build can never install an
    // engine for the previous root after this point.
    let mut engine = state
        .context_engine
        .lock()
        .map_err(|_| "context engine lock poisoned".to_string())?;
    // The previous workspace's gate is closed first: anything still holding it (a language
    // server supervisor, a pending trust prompt) can no longer launch a process. The new
    // workspace starts from its persisted decision, untrusted by default.
    let mut trust_gate = state
        .trust_gate
        .lock()
        .map_err(|_| "workspace trust lock poisoned".to_string())?;
    if let Some(previous) = trust_gate.take() {
        previous.close();
    }
    *trust_gate = host_core::WorkspaceTrustGate::open(state.trust_store_path(), &canonical)
        .map_err(|error| tracing::warn!(%error, "workspace stays untrusted"))
        .ok();
    // Same for its language servers: stopping them kills their processes. The new workspace
    // gets its own set, which stays idle until it is trusted.
    let mut language_services = state
        .language_services
        .lock()
        .map_err(|_| "language services lock poisoned".to_string())?;
    if let Some(previous) = language_services.take() {
        previous.stop();
    }
    state.latest_diagnostics.clear();
    // Terminals ran in the previous folder, under its trust: they go with it.
    crate::commands::terminal::close_all_terminals(state);
    crate::commands::debug::stop_debugging(state);
    *language_services = trust_gate.as_ref().map(|gate| {
        std::sync::Arc::new(host_core::LanguageServices::new(
            gate.clone(),
            state.diagnostics_sink.clone(),
        ))
    });
    drop(language_services);
    drop(trust_gate);
    *state
        .workspace_root
        .lock()
        .map_err(|_| "workspace root lock poisoned".to_string())? = Some(canonical);
    *engine = None;
    state.workspace_generation.fetch_add(1, Ordering::SeqCst);
    Ok(nodes)
}

fn authorized_workspace_file(
    state: &tauri::State<'_, DesktopAppState>,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let root = state
        .workspace_root
        .lock()
        .map_err(|_| "workspace root lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "No workspace has been selected".to_string())?;
    resolve_authorized_workspace_file(&root, relative_path)
}

pub(crate) fn resolve_authorized_workspace_file(
    root: &Path,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let canonical = root
        .join(relative_path)
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace file: {error}"))?;
    if !canonical.starts_with(root) || !canonical.is_file() {
        return Err("Workspace file is outside the authorized root".to_string());
    }
    Ok(canonical)
}

#[tauri::command]
pub fn read_workspace_file_command(
    state: tauri::State<'_, DesktopAppState>,
    relative_path: String,
) -> Result<String, String> {
    let path = authorized_workspace_file(&state, &relative_path)?;
    let metadata = path
        .metadata()
        .map_err(|error| format!("Failed to inspect workspace file: {error}"))?;
    if metadata.len() > 4 * 1024 * 1024 {
        return Err("Files larger than 4 MB require Large File Mode".to_string());
    }
    std::fs::read_to_string(path).map_err(|error| format!("Failed to read workspace file: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::context_index::ensure_context_engine;
    use crate::state::test_state;

    #[test]
    fn opening_a_workspace_lists_it_and_builds_its_search_index() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir(workspace.path().join("src")).unwrap();
        std::fs::write(
            workspace.path().join("src/main.ts"),
            "export const ready = true;\n",
        )
        .unwrap();
        let state = test_state(data.path());

        let nodes = load_workspace(&state, workspace.path().to_str().unwrap()).unwrap();
        assert_eq!(
            nodes
                .iter()
                .map(|node| node.path.as_str())
                .collect::<Vec<_>>(),
            ["src", "src/main.ts"]
        );
        assert_eq!(state.workspace_generation.load(Ordering::SeqCst), 1);
        assert!(ensure_context_engine(&state));
        assert!(state.context_engine.lock().unwrap().is_some());
    }

    #[test]
    fn workspace_file_resolution_rejects_parent_and_symlink_escapes() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("workspace");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("inside.ts"), "export const inside = true;\n").unwrap();
        std::fs::write(parent.path().join("outside.ts"), "secret\n").unwrap();
        let root = root.canonicalize().unwrap();

        assert_eq!(
            resolve_authorized_workspace_file(&root, "inside.ts").unwrap(),
            root.join("inside.ts")
        );
        assert!(resolve_authorized_workspace_file(&root, "../outside.ts").is_err());

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(parent.path().join("outside.ts"), root.join("link.ts"))
                .unwrap();
            assert!(resolve_authorized_workspace_file(&root, "link.ts").is_err());
        }
    }
}
