//! JavaScript debugging (`LOT-010`): one session at a time, with vscode-js-debug's DAP server.
//! Events reach the UI over a binary Tauri `Channel` as JSON frames, at most one every 16 ms.
//!
//! The adapter is never downloaded by the app. It is looked up, in order, at
//! `$COLORIDE_JS_DEBUG` (path to `dapDebugServer.js`), in the app data folder under
//! `tools/js-debug/<version>/`, and, in development builds, in the repository's `tools/`
//! folder filled by `pnpm fetch:js-debug`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use host_core::{DebugCommand, DebugEventSink, DebugLaunch, DebugSession};
use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::Manager;

use crate::commands::workspace::resolve_authorized_workspace_file;
use crate::state::DesktopAppState;

const JS_DEBUG_VERSION: &str = "v1.140.0";
const DAP_SERVER: &str = "js-debug/src/dapDebugServer.js";

pub(crate) fn locate_js_debug(app_data_dir: &Path) -> Option<PathBuf> {
    let from_env = std::env::var_os("COLORIDE_JS_DEBUG").map(PathBuf::from);
    let installed = app_data_dir
        .join("tools/js-debug")
        .join(JS_DEBUG_VERSION)
        .join(DAP_SERVER);
    #[cfg(debug_assertions)]
    let repository = Some(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tools/js-debug")
            .join(JS_DEBUG_VERSION)
            .join(DAP_SERVER),
    );
    #[cfg(not(debug_assertions))]
    let repository: Option<PathBuf> = None;
    from_env
        .into_iter()
        .chain([installed])
        .chain(repository)
        .find(|path| path.is_file())
}

/// `node` from `PATH`, then the usual install locations (apps started from the Dock get a
/// minimal `PATH` on macOS).
pub(crate) fn locate_node() -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .filter(|dir| dir.is_absolute())
        .chain(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from))
        .map(|dir| dir.join("node"))
        .find(|candidate| candidate.is_file())
}

pub(crate) fn start_debugging(
    state: &DesktopAppState,
    program: &str,
    breakpoints: &[(String, Vec<u32>)],
    sink: DebugEventSink,
) -> Result<(), String> {
    stop_debugging(state);
    let gate = state
        .trust_gate
        .lock()
        .map_err(|_| "workspace trust lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "No workspace is open".to_string())?;
    let root = gate.workspace_root().to_path_buf();
    let program = resolve_authorized_workspace_file(&root, program)?;
    let breakpoints: BTreeMap<PathBuf, Vec<u32>> = breakpoints
        .iter()
        .filter_map(|(path, lines)| {
            resolve_authorized_workspace_file(&root, path)
                .ok()
                .map(|path| (path, lines.clone()))
        })
        .collect();
    let server = locate_js_debug(&state.app_data_dir).ok_or_else(|| {
        "The JavaScript debug adapter is not installed (run `pnpm fetch:js-debug`)".to_string()
    })?;
    let node = locate_node().ok_or_else(|| "Node.js was not found".to_string())?;
    let session = DebugSession::launch(
        &gate,
        &node,
        &server,
        &DebugLaunch {
            program,
            args: Vec::new(),
        },
        breakpoints,
        sink,
    )
    .map_err(|error| error.to_string())?;
    *state
        .debug_session
        .lock()
        .map_err(|_| "debug session lock poisoned".to_string())? = Some(Arc::new(session));
    Ok(())
}

fn session(state: &DesktopAppState) -> Result<Arc<DebugSession>, String> {
    state
        .debug_session
        .lock()
        .map_err(|_| "debug session lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "Nothing is being debugged".to_string())
}

/// Ends the session, the debuggee and the adapter (also when the workspace changes).
pub(crate) fn stop_debugging(state: &DesktopAppState) {
    let session = state
        .debug_session
        .lock()
        .ok()
        .and_then(|mut session| session.take());
    if let Some(session) = session {
        session.stop();
    }
}

#[tauri::command]
pub async fn debug_start_command(
    app: tauri::AppHandle,
    program: String,
    breakpoints: Vec<(String, Vec<u32>)>,
    events: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sink: DebugEventSink = Arc::new(move |frame| {
            if let Ok(bytes) = serde_json::to_vec(&frame) {
                let _ = events.send(InvokeResponseBody::Raw(bytes));
            }
        });
        start_debugging(
            &app.state::<DesktopAppState>(),
            &program,
            &breakpoints,
            sink,
        )
    })
    .await
    .map_err(|error| format!("Debug task failed: {error}"))?
}

#[tauri::command]
pub async fn debug_request_command(
    app: tauri::AppHandle,
    command: DebugCommand,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        session(&app.state::<DesktopAppState>())?
            .request(&command)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Debug task failed: {error}"))?
}

#[tauri::command]
pub async fn debug_set_breakpoints_command(
    app: tauri::AppHandle,
    path: String,
    lines: Vec<u32>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopAppState>();
        let Ok(session) = session(&state) else {
            return Ok(Value::Null); // sent with the next launch
        };
        let root = state
            .workspace_root
            .lock()
            .map_err(|_| "workspace root lock poisoned".to_string())?
            .clone()
            .ok_or_else(|| "No workspace is open".to_string())?;
        let path = resolve_authorized_workspace_file(&root, &path)?;
        session
            .set_breakpoints(&path, lines)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Debug task failed: {error}"))?
}

#[tauri::command]
pub async fn debug_stop_command(app: tauri::AppHandle) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        stop_debugging(&app.state::<DesktopAppState>());
    })
    .await;
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::commands::trust::apply_trust_decision;
    use crate::commands::workspace::load_workspace;
    use crate::state::test_state;

    /// Through the desktop shell, with the real adapter (`pnpm fetch:js-debug`) and Node.
    #[test]
    fn debugging_needs_trust_stops_at_breakpoints_and_ends_with_the_workspace() {
        assert!(
            locate_js_debug(Path::new("/nonexistent")).is_some(),
            "the real js-debug adapter is required: run `pnpm fetch:js-debug`"
        );
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        std::fs::write(
            workspace.path().join("app.js"),
            "let total = 0;\nfor (let i = 0; i < 3; i++) {\n  total += i;\n}\nconsole.log(total);\n",
        )
        .unwrap();
        let state = test_state(data.path());
        load_workspace(&state, workspace.path().to_str().unwrap()).unwrap();
        let (sender, frames) = std::sync::mpsc::channel::<Vec<host_core::DebugEvent>>();
        let sender = std::sync::Mutex::new(sender);
        let sink: DebugEventSink = Arc::new(move |frame| {
            let _ = sender.lock().unwrap().send(frame);
        });
        let breakpoints = vec![("app.js".to_string(), vec![3])];

        // Untrusted: refused, nothing started. A path outside the workspace is refused too.
        assert!(start_debugging(&state, "app.js", &breakpoints, sink.clone()).is_err());
        let gate = state.trust_gate.lock().unwrap().clone().unwrap();
        apply_trust_decision(&gate, true).unwrap();
        assert!(start_debugging(&state, "../app.js", &breakpoints, sink.clone()).is_err());
        assert_eq!(gate.spawned_process_count(), 0);

        start_debugging(&state, "app.js", &breakpoints, sink).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let stopped = loop {
            let left = deadline
                .checked_duration_since(std::time::Instant::now())
                .unwrap_or_default();
            let frame = frames.recv_timeout(left).expect("debug events");
            if let Some(event) = frame.into_iter().find(|event| event.event == "stopped") {
                break event;
            }
        };
        let thread_id = stopped.body["threadId"].as_i64().unwrap();
        let stack = session(&state)
            .unwrap()
            .request(&DebugCommand::StackTrace { thread_id })
            .unwrap();
        assert_eq!(stack["stackFrames"][0]["line"], 3);

        let running = session(&state).unwrap();
        load_workspace(&state, other.path().to_str().unwrap()).unwrap();
        assert!(session(&state).is_err());
        assert!(!running.is_running());
    }
}
