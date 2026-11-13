//! Integrated terminals: shells on pseudo-terminals in the open (trusted) workspace, streamed
//! to xterm.js over a binary Tauri `Channel` in frames of at most one every 16 ms.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use host_core::{TerminalEvent, TerminalLaunch, TerminalSession, TerminalSink, TerminalSize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::Manager;

use crate::state::DesktopAppState;

/// Starts a terminal; `output` receives raw frames, then one empty message when the shell
/// exits (a real frame always holds at least one byte).
pub(crate) fn open_terminal(
    state: &DesktopAppState,
    size: TerminalSize,
    sink: TerminalSink,
) -> Result<u32, String> {
    let gate = state
        .trust_gate
        .lock()
        .map_err(|_| "workspace trust lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "No workspace is open".to_string())?;
    let session = TerminalSession::spawn(&gate, &TerminalLaunch::default(), size, sink)
        .map_err(|error| error.to_string())?;
    let id = state.next_terminal_id.fetch_add(1, Ordering::SeqCst);
    state
        .terminals
        .lock()
        .map_err(|_| "terminals lock poisoned".to_string())?
        .insert(id, Arc::new(session));
    Ok(id)
}

fn terminal(state: &DesktopAppState, id: u32) -> Result<Arc<TerminalSession>, String> {
    state
        .terminals
        .lock()
        .map_err(|_| "terminals lock poisoned".to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| "This terminal is closed".to_string())
}

/// Kills every terminal (the workspace was closed, or its trust revoked).
pub(crate) fn close_all_terminals(state: &DesktopAppState) {
    let sessions: Vec<_> = state
        .terminals
        .lock()
        .map(|mut terminals| terminals.drain().map(|(_, session)| session).collect())
        .unwrap_or_default();
    for session in sessions {
        session.kill();
    }
}

#[tauri::command]
pub async fn terminal_open_command(
    app: tauri::AppHandle,
    cols: u16,
    rows: u16,
    output: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sink: TerminalSink = Arc::new(move |event| {
            let bytes = match event {
                TerminalEvent::Output(bytes) => bytes,
                TerminalEvent::Exited => Vec::new(),
            };
            let _ = output.send(InvokeResponseBody::Raw(bytes));
        });
        open_terminal(
            &app.state::<DesktopAppState>(),
            TerminalSize { cols, rows },
            sink,
        )
    })
    .await
    .map_err(|error| format!("Terminal task failed: {error}"))?
}

#[tauri::command]
pub fn terminal_write_command(
    state: tauri::State<'_, DesktopAppState>,
    id: u32,
    data: String,
) -> Result<(), String> {
    terminal(&state, id)?
        .write(data.as_bytes())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn terminal_resize_command(
    state: tauri::State<'_, DesktopAppState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    terminal(&state, id)?
        .resize(TerminalSize { cols, rows })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn terminal_close_command(state: tauri::State<'_, DesktopAppState>, id: u32) {
    let session = state
        .terminals
        .lock()
        .ok()
        .and_then(|mut terminals| terminals.remove(&id));
    if let Some(session) = session {
        session.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::trust::{apply_trust_decision, revoke_workspace_trust};
    use crate::commands::workspace::load_workspace;
    use crate::state::test_state;

    #[test]
    fn terminals_need_trust_and_die_with_their_workspace_or_trust() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let state = test_state(data.path());
        let size = TerminalSize { cols: 80, rows: 24 };
        // No workspace, then an untrusted one: refused.
        assert!(open_terminal(&state, size, Arc::new(|_| {})).is_err());
        load_workspace(&state, workspace.path().to_str().unwrap()).unwrap();
        assert!(open_terminal(&state, size, Arc::new(|_| {})).is_err());

        let gate = state.trust_gate.lock().unwrap().clone().unwrap();
        apply_trust_decision(&gate, true).unwrap();
        let first = open_terminal(&state, size, Arc::new(|_| {})).unwrap();
        let shell = terminal(&state, first).unwrap();
        // Revoking trust kills it.
        revoke_workspace_trust(&state).unwrap();
        assert!(terminal(&state, first).is_err());
        assert!(shell.has_exited());

        apply_trust_decision(&gate, true).unwrap();
        let second = open_terminal(&state, size, Arc::new(|_| {})).unwrap();
        let shell = terminal(&state, second).unwrap();
        // Opening another folder kills it too.
        load_workspace(&state, other.path().to_str().unwrap()).unwrap();
        assert!(terminal(&state, second).is_err());
        assert!(shell.has_exited());
    }
}
