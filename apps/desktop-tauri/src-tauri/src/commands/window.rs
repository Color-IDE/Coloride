//! Closing the window or quitting the app while files have unsaved changes.
//!
//! The UI reports how many files have unsaved changes (it also holds the edits of projects that
//! are not open in the editor). Closing the window, or quitting with Cmd/Ctrl+Q, is then held back
//! and the UI is asked what to do; once it answers, it calls `confirm_exit_command`.

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, State};

use crate::state::DesktopAppState;

/// Event sent to the UI when a close or quit was held back because of unsaved changes.
pub(crate) const CLOSE_REQUESTED_EVENT: &str = "coloride-close-requested";

#[tauri::command]
pub fn report_unsaved_buffers_command(state: State<'_, DesktopAppState>, count: usize) {
    state.unsaved_buffers.store(count, Ordering::SeqCst);
}

/// The user chose to close (saved or discarded): let the exit through.
#[tauri::command]
pub fn confirm_exit_command(app: AppHandle, state: State<'_, DesktopAppState>) {
    state.exit_confirmed.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// Asks the UI to confirm a close that has just been held back.
pub(crate) fn request_close_confirmation(app: &AppHandle) {
    let _ = app.emit(CLOSE_REQUESTED_EVENT, ());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::test_state;

    #[test]
    fn closing_is_held_back_only_while_files_have_unsaved_changes() {
        let data = tempfile::tempdir().unwrap();
        let state = test_state(data.path());
        // Nothing unsaved (also the state before the UI has reported anything): close freely.
        assert!(!state.close_needs_confirmation());

        state.unsaved_buffers.store(2, Ordering::SeqCst);
        assert!(state.close_needs_confirmation());

        // Saved or discarded meanwhile: the UI reports 0 and nothing is held back.
        state.unsaved_buffers.store(0, Ordering::SeqCst);
        assert!(!state.close_needs_confirmation());
    }

    #[test]
    fn once_the_user_has_answered_the_exit_goes_through() {
        let data = tempfile::tempdir().unwrap();
        let state = test_state(data.path());
        state.unsaved_buffers.store(3, Ordering::SeqCst);
        assert!(state.close_needs_confirmation());

        // "Don't save": the UI confirms the exit, which must not be held back again.
        state.exit_confirmed.store(true, Ordering::SeqCst);
        assert!(!state.close_needs_confirmation());
    }
}
