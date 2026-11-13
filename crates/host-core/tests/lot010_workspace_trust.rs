//! LOT-010 — Untrusted Workspace Security Test (Blocking).
//!
//! A real repository on disk carries real executable trojans (`node_modules/.bin/biome`,
//! `node_modules/.bin/vtsls`, `.git/hooks/*`, a folder-open startup script). Each trojan, if it
//! ever runs, writes a marker file outside the repository. While the workspace is untrusted the
//! Host must launch 0 processes and no marker may appear. A positive control then grants trust
//! and shows that the very same launch does run the trojan, so the test cannot pass vacuously.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use host_core::{
    GatedCapability, TrustError, WorkspaceTrustGate, WorkspaceTrustState,
    WORKSPACE_TRUST_STORE_FILENAME,
};

/// (path inside the repository, capability a launch of it would need)
const TROJANS: &[(&str, GatedCapability)] = &[
    (
        "node_modules/.bin/biome",
        GatedCapability::WorkspaceLanguageServer,
    ),
    (
        "node_modules/.bin/vtsls",
        GatedCapability::WorkspaceLanguageServer,
    ),
    (
        "node_modules/.bin/eslint",
        GatedCapability::WorkspaceLocalBinary,
    ),
    (".git/hooks/post-checkout", GatedCapability::GitHook),
    (".git/hooks/pre-commit", GatedCapability::GitHook),
    (".vscode/on-folder-open.sh", GatedCapability::StartupScript),
    (
        "node_modules/.bin/js-debug-adapter",
        GatedCapability::DebugAdapter,
    ),
    (
        "extensions/evil/activate.sh",
        GatedCapability::ActiveExtension,
    ),
];

struct TrojanRepo {
    _dir: tempfile::TempDir,
    root: PathBuf,
    markers: PathBuf,
    store: PathBuf,
}

impl TrojanRepo {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        let markers = dir.path().join("markers");
        fs::create_dir_all(&markers).unwrap();
        for (relative, _) in TROJANS {
            let path = root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let marker = markers.join(relative.replace('/', "_"));
            fs::write(
                &path,
                format!("#!/bin/sh\necho pwned > '{}'\n", marker.display()),
            )
            .unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.ts"), "export const ready = true;\n").unwrap();
        fs::write(
            root.join(".vscode/tasks.json"),
            r#"{"tasks":[{"command":".vscode/on-folder-open.sh","runOptions":{"runOn":"folderOpen"}}]}"#,
        )
        .unwrap();
        let store = dir
            .path()
            .join("app-data")
            .join(WORKSPACE_TRUST_STORE_FILENAME);
        Self {
            _dir: dir,
            root,
            markers,
            store,
        }
    }

    fn gate(&self) -> WorkspaceTrustGate {
        WorkspaceTrustGate::open(&self.store, &self.root).unwrap()
    }

    fn markers_written(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(&self.markers)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

/// Tries to launch `relative` through the gate, the only launch path `host-core` has.
fn launch(
    gate: &WorkspaceTrustGate,
    root: &Path,
    relative: &str,
    capability: GatedCapability,
) -> Result<(), TrustError> {
    let mut command = gate.command(capability, root.join(relative))?;
    command.command_mut().current_dir(root);
    let status = command.spawn()?.wait().expect("trojan exit status");
    assert!(status.success());
    Ok(())
}

#[test]
fn untrusted_repository_with_trojans_launches_zero_processes() {
    let repo = TrojanRepo::new();
    let gate = repo.gate();
    assert_eq!(gate.state(), WorkspaceTrustState::Untrusted);

    for (relative, capability) in TROJANS {
        let denied = launch(&gate, &repo.root, relative, *capability);
        assert!(
            matches!(denied, Err(TrustError::Untrusted { .. })),
            "{relative} must be blocked, got {denied:?}"
        );
        // A trojan cannot get through by claiming another capability either.
        for (_, other) in TROJANS {
            assert!(launch(&gate, &repo.root, relative, *other).is_err());
        }
    }

    assert_eq!(gate.spawned_process_count(), 0);
    assert_eq!(repo.markers_written(), Vec::<String>::new());
    // Reading the repository (indexing, highlighting) stays possible: only execution is gated.
    assert_eq!(
        fs::read_to_string(repo.root.join("src/main.ts")).unwrap(),
        "export const ready = true;\n"
    );
}

#[test]
fn positive_control_the_same_launch_runs_once_the_user_grants_trust() {
    let repo = TrojanRepo::new();
    let gate = repo.gate();
    gate.grant().unwrap();
    launch(
        &gate,
        &repo.root,
        "node_modules/.bin/biome",
        GatedCapability::WorkspaceLanguageServer,
    )
    .unwrap();
    assert_eq!(gate.spawned_process_count(), 1);
    assert_eq!(repo.markers_written(), ["node_modules_.bin_biome"]);
}

#[test]
fn trust_survives_a_restart_and_revocation_blocks_again() {
    let repo = TrojanRepo::new();
    {
        let gate = repo.gate();
        gate.grant().unwrap();
    }
    // "Restart": nothing is kept in memory, only the store file on disk.
    let reopened = repo.gate();
    assert_eq!(reopened.state(), WorkspaceTrustState::Trusted);

    reopened.revoke().unwrap();
    let denied = launch(
        &reopened,
        &repo.root,
        ".git/hooks/pre-commit",
        GatedCapability::GitHook,
    );
    assert!(matches!(denied, Err(TrustError::Untrusted { .. })));
    assert_eq!(repo.gate().state(), WorkspaceTrustState::Untrusted);
    assert_eq!(repo.markers_written(), Vec::<String>::new());
}

#[test]
fn a_command_built_while_trusted_cannot_be_spawned_after_revocation() {
    let repo = TrojanRepo::new();
    let gate = repo.gate();
    gate.grant().unwrap();
    let command = gate
        .command(
            GatedCapability::WorkspaceLanguageServer,
            repo.root.join("node_modules/.bin/vtsls"),
        )
        .unwrap();
    gate.revoke().unwrap();
    assert!(matches!(command.spawn(), Err(TrustError::Untrusted { .. })));

    gate.grant().unwrap();
    let command = gate
        .command(
            GatedCapability::WorkspaceLanguageServer,
            repo.root.join("node_modules/.bin/vtsls"),
        )
        .unwrap();
    gate.close();
    assert!(matches!(
        command.spawn(),
        Err(TrustError::GateClosed { .. })
    ));

    assert_eq!(gate.spawned_process_count(), 0);
    assert_eq!(repo.markers_written(), Vec::<String>::new());
}

#[test]
fn a_copied_or_symlinked_repository_does_not_inherit_or_split_trust() {
    let repo = TrojanRepo::new();
    repo.gate().grant().unwrap();

    // A symlink to the trusted folder is the same workspace.
    let link = repo.root.parent().unwrap().join("link");
    std::os::unix::fs::symlink(&repo.root, &link).unwrap();
    let through_link = WorkspaceTrustGate::open(&repo.store, &link).unwrap();
    assert!(through_link.is_trusted());
    assert!(through_link.is_inside_workspace(&link.join("node_modules/.bin/biome")));

    // A different folder with the same content is a different workspace.
    let copy = repo.root.parent().unwrap().join("copy");
    fs::create_dir_all(copy.join("node_modules/.bin")).unwrap();
    assert!(!WorkspaceTrustGate::open(&repo.store, &copy)
        .unwrap()
        .is_trusted());
}
