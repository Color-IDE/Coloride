//! Workspace Trust: reporting the decision for the open workspace and changing it.
//!
//! Trust is only ever granted from a native OS dialog shown by this process. The webview can ask
//! for that dialog but cannot answer it, so content rendered in the UI (model output, file
//! content, an extension) can never approve a workspace by itself.

use host_core::{WorkspaceTrustGate, WorkspaceTrustState};
use serde::Serialize;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::state::DesktopAppState;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTrustReport {
    state: WorkspaceTrustState,
    /// The open workspace, or `None` when no folder is open.
    workspace_root: Option<String>,
}

fn current_gate(state: &DesktopAppState) -> Result<Option<WorkspaceTrustGate>, String> {
    Ok(state
        .trust_gate
        .lock()
        .map_err(|_| "workspace trust lock poisoned".to_string())?
        .clone())
}

pub(crate) fn workspace_trust(state: &DesktopAppState) -> Result<WorkspaceTrustReport, String> {
    let gate = current_gate(state)?;
    let workspace_root = state
        .workspace_root
        .lock()
        .map_err(|_| "workspace root lock poisoned".to_string())?
        .as_ref()
        .map(|root| root.to_string_lossy().into_owned());
    Ok(WorkspaceTrustReport {
        state: gate.map_or(WorkspaceTrustState::Untrusted, |gate| gate.state()),
        workspace_root,
    })
}

/// Applies the user's answer to the gate that was open when the question was asked. If another
/// workspace was opened meanwhile that gate is closed, and the answer never reaches the new one.
pub(crate) fn apply_trust_decision(
    gate: &WorkspaceTrustGate,
    approved: bool,
) -> Result<(), String> {
    if approved {
        gate.grant().map_err(|error| error.to_string())
    } else {
        Ok(())
    }
}

pub(crate) fn revoke_workspace_trust(
    state: &DesktopAppState,
) -> Result<WorkspaceTrustReport, String> {
    if let Some(gate) = current_gate(state)? {
        // Restricted mode again: the gate denies new launches, and what runs is stopped.
        let revoked = gate.revoke();
        if let Some(services) = state.language_services() {
            services.stop();
        }
        crate::commands::terminal::close_all_terminals(state);
        crate::commands::debug::stop_debugging(state);
        revoked.map_err(|error| error.to_string())?;
    }
    workspace_trust(state)
}

#[tauri::command]
pub fn workspace_trust_command(
    state: tauri::State<'_, DesktopAppState>,
) -> Result<WorkspaceTrustReport, String> {
    workspace_trust(&state)
}

/// Asks the user, in a native dialog, whether to trust the open workspace.
#[tauri::command]
pub async fn request_workspace_trust_command(
    app: tauri::AppHandle,
) -> Result<WorkspaceTrustReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopAppState>();
        let gate = current_gate(&state)?
            .ok_or_else(|| "No workspace that can be trusted is open".to_string())?;
        if !gate.is_trusted() {
            let approved = app
                .dialog()
                .message(format!(
                    "Do you trust the authors of the files in this folder?\n\n{}\n\n\
                     Trusting it lets Coloride run programs from the folder: language servers, \
                     linters, Git hooks, tasks and debuggers. Only trust folders whose content \
                     you know.",
                    gate.workspace_root().display()
                ))
                .title("Trust this folder?")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Trust folder".to_string(),
                    "Stay in restricted mode".to_string(),
                ))
                .blocking_show();
            apply_trust_decision(&gate, approved)?;
        }
        workspace_trust(&state)
    })
    .await
    .map_err(|error| format!("Workspace trust prompt failed: {error}"))?
}

#[tauri::command]
pub fn revoke_workspace_trust_command(
    state: tauri::State<'_, DesktopAppState>,
) -> Result<WorkspaceTrustReport, String> {
    revoke_workspace_trust(&state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::workspace::load_workspace;
    use crate::state::test_state;

    fn open(state: &DesktopAppState, root: &std::path::Path) -> WorkspaceTrustGate {
        load_workspace(state, root.to_str().unwrap()).unwrap();
        current_gate(state).unwrap().unwrap()
    }

    #[test]
    fn no_workspace_and_a_freshly_opened_workspace_are_untrusted() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let state = test_state(data.path());
        let report = workspace_trust(&state).unwrap();
        assert_eq!(report.state, WorkspaceTrustState::Untrusted);
        assert_eq!(report.workspace_root, None);

        open(&state, workspace.path());
        let report = workspace_trust(&state).unwrap();
        assert_eq!(report.state, WorkspaceTrustState::Untrusted);
        assert!(report.workspace_root.is_some());
    }

    #[test]
    fn declining_keeps_restricted_mode_and_approving_survives_a_restart() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let state = test_state(data.path());
        let gate = open(&state, workspace.path());

        apply_trust_decision(&gate, false).unwrap();
        assert_eq!(
            workspace_trust(&state).unwrap().state,
            WorkspaceTrustState::Untrusted
        );

        apply_trust_decision(&gate, true).unwrap();
        assert_eq!(
            workspace_trust(&state).unwrap().state,
            WorkspaceTrustState::Trusted
        );

        // A new process (fresh state, same data directory) reopening the folder finds it trusted.
        let restarted = test_state(data.path());
        open(&restarted, workspace.path());
        assert_eq!(
            workspace_trust(&restarted).unwrap().state,
            WorkspaceTrustState::Trusted
        );

        assert_eq!(
            revoke_workspace_trust(&restarted).unwrap().state,
            WorkspaceTrustState::Untrusted
        );
    }

    #[test]
    fn an_answer_given_after_switching_workspace_never_trusts_the_new_one() {
        let data = tempfile::tempdir().unwrap();
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let state = test_state(data.path());
        // The prompt is shown for the first folder...
        let asked_about = open(&state, first.path());
        // ...the user switches project while it is open, then clicks "Trust folder".
        let now_open = open(&state, second.path());
        apply_trust_decision(&asked_about, true).unwrap();

        assert_eq!(
            workspace_trust(&state).unwrap().state,
            WorkspaceTrustState::Untrusted
        );
        assert!(!now_open.is_trusted());
        // The old gate is closed: whoever still holds it cannot launch anything.
        assert!(asked_about
            .authorize(host_core::GatedCapability::WorkspaceLanguageServer)
            .is_err());
    }

    /// LOT-010 blocking scenario at the level of the desktop shell: opening a repository that
    /// carries trojans, then starting the background services, runs none of them.
    #[cfg(unix)]
    #[test]
    fn opening_an_untrusted_trojan_repository_launches_nothing() {
        use std::os::unix::fs::PermissionsExt;

        let data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let marker = outside.path().join("pwned");
        for relative in [
            "node_modules/.bin/biome",
            "node_modules/.bin/vtsls",
            ".git/hooks/post-checkout",
        ] {
            let path = workspace.path().join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(
                &path,
                format!("#!/bin/sh\necho x > '{}'\n", marker.display()),
            )
            .unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::fs::write(workspace.path().join("main.ts"), "export const a = 1;\n").unwrap();

        let state = test_state(data.path());
        let gate = open(&state, workspace.path());
        assert!(crate::commands::context_index::ensure_context_engine(
            &state
        ));

        assert_eq!(gate.spawned_process_count(), 0);
        assert!(!marker.exists());
        assert_eq!(
            workspace_trust(&state).unwrap().state,
            WorkspaceTrustState::Untrusted
        );
    }
}
