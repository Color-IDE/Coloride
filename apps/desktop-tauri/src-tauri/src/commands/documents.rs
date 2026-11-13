//! Binary document IPC between CodeMirror 6 and `host_core::DocumentService`.

use host_core::encode_editor_snapshot_ipc;

use crate::commands::workspace::resolve_authorized_workspace_file;
use crate::state::DesktopAppState;

#[tauri::command]
pub fn open_document_binary_command(
    state: tauri::State<'_, DesktopAppState>,
    document_id: String,
    session_generation: u32,
    initial_text: String,
) -> Result<Vec<u8>, String> {
    let workspace_root = state
        .workspace_root
        .lock()
        .map_err(|_| "workspace root lock poisoned".to_string())?
        .clone();
    let mut bridge = state
        .bridge
        .lock()
        .map_err(|_| "desktop document bridge lock poisoned".to_string())?;
    match workspace_root {
        _ if document_id.starts_with("untitled:") => {
            bridge.open_document_binary(document_id, session_generation, &initial_text)
        }
        Some(root) => {
            let path = resolve_authorized_workspace_file(&root, &document_id)?;
            bridge.open_document_from_disk_binary(document_id, session_generation, path)
        }
        None => bridge.open_document_binary(document_id, session_generation, &initial_text),
    }
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn apply_binary_transaction_command(
    state: tauri::State<'_, DesktopAppState>,
    payload: Vec<u8>,
) -> Result<Vec<u8>, String> {
    state
        .bridge
        .lock()
        .map_err(|_| "desktop document bridge lock poisoned".to_string())?
        .apply_binary_transaction(&payload)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_document_binary_command(
    state: tauri::State<'_, DesktopAppState>,
    document_id: String,
    session_generation: u32,
) -> Result<Vec<u8>, String> {
    let mut bridge = state
        .bridge
        .lock()
        .map_err(|_| "desktop document bridge lock poisoned".to_string())?;
    let snapshot = bridge
        .documents_mut()
        .save_document_atomic(&document_id, session_generation)
        .map_err(|error| error.to_string())?;
    encode_editor_snapshot_ipc(&snapshot).map_err(|error| error.to_string())
}
