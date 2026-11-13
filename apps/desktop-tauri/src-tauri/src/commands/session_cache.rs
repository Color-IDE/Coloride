//! The UI session cache (`workspace_session_cache.bin`), written atomically.

use crate::state::DesktopAppState;

#[tauri::command]
pub fn load_session_cache_command(
    state: tauri::State<'_, DesktopAppState>,
) -> Result<Option<Vec<u8>>, String> {
    let path = state.app_data_dir.join("workspace_session_cache.bin");
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "Failed to load the workspace session cache: {error}"
        )),
    }
}

#[tauri::command]
pub fn save_session_cache_command(
    state: tauri::State<'_, DesktopAppState>,
    payload: Vec<u8>,
) -> Result<(), String> {
    let target = state.app_data_dir.join("workspace_session_cache.bin");
    let temporary = state.app_data_dir.join(".workspace_session_cache.bin.tmp");
    std::fs::write(&temporary, payload)
        .map_err(|error| format!("Failed to write the workspace session cache: {error}"))?;
    std::fs::rename(&temporary, &target)
        .map_err(|error| format!("Failed to commit the workspace session cache: {error}"))
}
