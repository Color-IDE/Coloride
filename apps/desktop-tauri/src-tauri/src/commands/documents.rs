//! Binary document IPC between CodeMirror 6 and `host_core::DocumentService`.

use std::path::Path;

use context_engine::SqliteWalContextEngine;
use host_core::encode_editor_snapshot_ipc;

use crate::bridge::DesktopBinaryEditorBridge;
use crate::commands::workspace::resolve_authorized_workspace_file;
use crate::state::DesktopAppState;

#[tauri::command]
pub fn open_document_binary_command(
    state: tauri::State<'_, DesktopAppState>,
    document_id: String,
    session_generation: u32,
    initial_text: String,
) -> Result<Vec<u8>, String> {
    open_document(&state, document_id, session_generation, &initial_text)
}

pub(crate) fn open_document(
    state: &DesktopAppState,
    document_id: String,
    session_generation: u32,
    initial_text: &str,
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
    let opened_id = document_id.clone();
    let encoded = match workspace_root {
        _ if document_id.starts_with("untitled:") => {
            bridge.open_document_binary(document_id, session_generation, initial_text)
        }
        Some(root) => {
            let path = resolve_authorized_workspace_file(&root, &document_id)?;
            bridge.open_document_with_editor_text_binary(
                document_id,
                session_generation,
                path,
                initial_text,
            )
        }
        None => bridge.open_document_binary(document_id, session_generation, initial_text),
    }
    .map_err(|error| error.to_string())?;
    // Language servers follow the buffer from here on (they only run in a trusted workspace).
    if let Some(services) = state.language_services() {
        if let Ok(session) = bridge
            .document_service()
            .session(&opened_id, session_generation)
        {
            services.document_opened(session);
        }
    }
    Ok(encoded)
}

#[tauri::command]
pub fn apply_binary_transaction_command(
    state: tauri::State<'_, DesktopAppState>,
    payload: Vec<u8>,
) -> Result<Vec<u8>, String> {
    apply_transaction(&state, &payload)
}

/// Applies an editor transaction to the authoritative rope and forwards the delta to the
/// language servers. Forwarding only enqueues messages: it never waits for a server.
pub(crate) fn apply_transaction(
    state: &DesktopAppState,
    payload: &[u8],
) -> Result<Vec<u8>, String> {
    let services = state.language_services();
    state
        .bridge
        .lock()
        .map_err(|_| "desktop document bridge lock poisoned".to_string())?
        .apply_binary_transaction_observed(payload, |rope_before, changes, session| {
            if let Some(services) = &services {
                services.transaction_applied(rope_before, changes, session);
            }
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_document_binary_command(
    state: tauri::State<'_, DesktopAppState>,
    document_id: String,
    session_generation: u32,
) -> Result<Vec<u8>, String> {
    save_document(&state, &document_id, session_generation)
}

/// Saves a document atomically and re-indexes it for search.
pub(crate) fn save_document(
    state: &DesktopAppState,
    document_id: &str,
    session_generation: u32,
) -> Result<Vec<u8>, String> {
    let workspace_root = state
        .workspace_root
        .lock()
        .map_err(|_| "workspace root lock poisoned".to_string())?
        .clone();
    // Lock order: bridge, then context engine (as in search).
    let mut bridge = state
        .bridge
        .lock()
        .map_err(|_| "desktop document bridge lock poisoned".to_string())?;
    let snapshot = bridge
        .documents_mut()
        .save_document_atomic(document_id, session_generation)
        .map_err(|error| error.to_string())?;
    if let Some(root) = workspace_root {
        if let Ok(mut context) = state.context_engine.lock() {
            if let Some(context) = context.as_mut() {
                reindex_saved_document(&bridge, context, &root, document_id, session_generation);
            }
        }
    }
    encode_editor_snapshot_ipc(&snapshot).map_err(|error| error.to_string())
}

/// A save takes the buffer out of the unsaved overlay, so the index must hold the new disk text
/// or search would serve the content from when the project was indexed. Best effort: a failure
/// only leaves search stale until the next rebuild.
fn reindex_saved_document(
    bridge: &DesktopBinaryEditorBridge,
    context: &mut SqliteWalContextEngine,
    workspace_root: &Path,
    document_id: &str,
    session_generation: u32,
) {
    let Ok(session) = bridge
        .document_service()
        .session(document_id, session_generation)
    else {
        return;
    };
    // Only files of the indexed workspace (a session may belong to a project left meanwhile).
    let Some(relative) = session
        .disk_path()
        .and_then(|path| path.strip_prefix(workspace_root).ok())
    else {
        return;
    };
    let _ = context.index_file(
        &relative.to_string_lossy(),
        session.disk_saved_revision(),
        &session.text(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::context_index::ensure_context_engine;
    use crate::commands::workspace::load_workspace;
    use crate::state::test_state;
    use host_core::{
        EditorSelection, EditorTransaction, TextChange, TransactionOrigin, Utf16CodeUnitOffset,
        Utf16Span, CONTRACT_SCHEMA_VERSION,
    };

    #[test]
    fn saving_reindexes_the_file_so_search_finds_the_new_text() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(
            workspace.path().join("main.ts"),
            "export const oldName = 1;\n",
        )
        .unwrap();
        let state = test_state(data.path());
        load_workspace(&state, workspace.path().to_str().unwrap()).unwrap();
        assert!(ensure_context_engine(&state));

        let root = state.workspace_root.lock().unwrap().clone().unwrap();
        {
            let mut bridge = state.bridge.lock().unwrap();
            bridge
                .open_document_with_editor_text_binary(
                    "main.ts",
                    1,
                    root.join("main.ts"),
                    "export const oldName = 1;\n",
                )
                .unwrap();
            bridge
                .documents_mut()
                .apply_transaction(EditorTransaction {
                    schema_version: CONTRACT_SCHEMA_VERSION,
                    document_id: "main.ts".to_string(),
                    session_generation: 1,
                    base_revision: 0,
                    op_id: "op-1".to_string(),
                    changes: vec![TextChange {
                        range_utf16: Utf16Span::new(
                            Utf16CodeUnitOffset::new(13),
                            Utf16CodeUnitOffset::new(20),
                        ),
                        range_utf8: None,
                        inserted_text: "renamedSymbol".to_string(),
                    }],
                    selection: EditorSelection::default(),
                    origin: TransactionOrigin::User,
                    ime_composing: false,
                })
                .unwrap();
        }
        save_document(&state, "main.ts", 1).unwrap();

        let bridge = state.bridge.lock().unwrap();
        let mut context = state.context_engine.lock().unwrap();
        let context = context.as_mut().unwrap();
        let hits = bridge.search_workspace_hybrid(context, Some(&root), "renamedSymbol", 10);
        assert!(hits.iter().any(|hit| hit.excerpt.source_path == "main.ts"));
        assert!(!hits.iter().any(|hit| hit.unsaved_buffer));
    }

    #[test]
    fn a_tab_reopened_with_unsaved_edits_is_searched_as_unsaved() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(
            workspace.path().join("lib.ts"),
            "export const onDisk = 1;\n",
        )
        .unwrap();
        let state = test_state(data.path());
        load_workspace(&state, workspace.path().to_str().unwrap()).unwrap();
        assert!(ensure_context_engine(&state));
        let root = state.workspace_root.lock().unwrap().clone().unwrap();

        let mut bridge = state.bridge.lock().unwrap();
        bridge
            .open_document_with_editor_text_binary(
                "lib.ts",
                3,
                root.join("lib.ts"),
                "export const onlyInEditor = 1;\n",
            )
            .unwrap();
        let mut context = state.context_engine.lock().unwrap();
        let hits = bridge.search_workspace_hybrid(
            context.as_mut().unwrap(),
            Some(&root),
            "onlyInEditor",
            10,
        );
        assert!(hits
            .iter()
            .any(|hit| hit.unsaved_buffer && hit.excerpt.source_path == "lib.ts"));
    }
}
