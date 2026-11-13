//! Language features (completion, definition, references, rename, formatting) for the editor,
//! answered by the workspace's language servers about one exact revision.

use std::time::Duration;

use host_core::{LanguageFeatureRequest, LanguageFeatureResponse, LspError};
use tauri::Manager;

use crate::state::DesktopAppState;

const ANSWER_TIMEOUT: Duration = Duration::from_secs(10);
/// The editor may ask right after sending its last keystroke, whose transaction is then
/// still on its way: wait briefly for the Host to reach the revision asked about.
const CATCH_UP_ATTEMPTS: u32 = 10;
const CATCH_UP_DELAY: Duration = Duration::from_millis(20);

pub(crate) fn language_feature(
    state: &DesktopAppState,
    request: &LanguageFeatureRequest,
) -> Result<LanguageFeatureResponse, String> {
    let services = state
        .language_services()
        .ok_or_else(|| "No workspace is open".to_string())?;
    let path = state
        .bridge
        .lock()
        .map_err(|_| "desktop document bridge lock poisoned".to_string())?
        .document_service()
        .session(&request.document_id, request.session_generation)
        .map_err(|error| error.to_string())?
        .disk_path()
        .map(std::path::Path::to_path_buf)
        .ok_or_else(|| "The document has no file a language server can read".to_string())?;
    let mut attempt = 0;
    loop {
        match services.request_feature(&path, request, ANSWER_TIMEOUT) {
            Err(LspError::StaleRevision { requested, current })
                if current < requested && attempt + 1 < CATCH_UP_ATTEMPTS =>
            {
                attempt += 1;
                std::thread::sleep(CATCH_UP_DELAY);
            }
            other => return other.map_err(|error| error.to_string()),
        }
    }
}

/// Waits for a language server: runs on a blocking worker, never on the main thread.
#[tauri::command]
pub async fn language_feature_command(
    app: tauri::AppHandle,
    request: LanguageFeatureRequest,
) -> Result<LanguageFeatureResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        language_feature(&app.state::<DesktopAppState>(), &request)
    })
    .await
    .map_err(|error| format!("Language feature task failed: {error}"))?
}
