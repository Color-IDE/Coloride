//! Semantic enrichment of the dependency graph (`LOT-010`): an import edge the index resolved
//! syntactically becomes `ExactSemantic` once `vtsls` resolves the same module specifier, in the
//! live buffer, to the same file.

use std::time::Duration;

use host_core::{
    utf8_to_utf16, LanguageFeature, LanguageFeatureRequest, LanguageFeatureResult, Utf8ByteOffset,
};

use crate::state::DesktopAppState;

const ANSWER_TIMEOUT: Duration = Duration::from_secs(10);

/// Confirms the import edges of one open document; returns how many became `ExactSemantic`.
/// Does nothing without a running TypeScript server (untrusted workspace, or none installed).
/// Every question names the buffer's revision: if the user edits meanwhile, the server refuses
/// the rest and nothing is confirmed from a text that no longer exists.
pub(crate) fn enrich_import_edges(
    state: &DesktopAppState,
    document_id: &str,
    session_generation: u32,
) -> usize {
    let Some(services) = state.language_services() else {
        return 0;
    };
    let Some(root) = state
        .workspace_root
        .lock()
        .ok()
        .and_then(|root| root.clone())
    else {
        return 0;
    };
    let Some(document) = state
        .bridge
        .lock()
        .ok()
        .and_then(|bridge| bridge.document_imports(document_id, session_generation))
    else {
        return 0;
    };
    let Ok(relative) = document.disk_path.strip_prefix(&root) else {
        return 0;
    };
    let importer = relative.to_string_lossy().replace('\\', "/");
    let candidates: Vec<String> = state
        .context_engine
        .lock()
        .ok()
        .and_then(|engine| {
            engine.as_ref().map(|engine| {
                engine
                    .symbol_edges_table()
                    .iter()
                    .filter(|edge| {
                        edge.importer_file == importer
                            && edge.confidence == context_engine::GraphEdgeConfidence::SyntacticAst
                    })
                    .map(|edge| edge.target_file.clone())
                    .collect()
            })
        })
        .unwrap_or_default();
    if candidates.is_empty() {
        return 0;
    }

    let mut confirmed = Vec::new();
    for import in &document.imports {
        let start = import.span_utf8.start.as_usize();
        let end = import
            .span_utf8
            .end
            .as_usize()
            .min(document.rope.len_bytes());
        let Some(statement) = document.rope.get_byte_slice(start..end) else {
            continue;
        };
        let statement = statement.to_string();
        // The specifier inside its quotes (a bare name could also appear before it).
        let Some(quoted) = ['"', '\''].iter().find_map(|quote| {
            statement.find(&format!("{quote}{}{quote}", import.source_specifier))
        }) else {
            continue;
        };
        let Ok(position) = utf8_to_utf16(
            &document.rope,
            Utf8ByteOffset::new((start + quoted + 1) as u32),
        ) else {
            continue;
        };
        let request = LanguageFeatureRequest {
            document_id: document_id.to_string(),
            session_generation,
            revision: document.revision,
            position_utf16: position,
            feature: LanguageFeature::Definition,
        };
        let Ok(response) = services.request_feature(&document.disk_path, &request, ANSWER_TIMEOUT)
        else {
            return 0;
        };
        if let LanguageFeatureResult::Locations { locations } = response.result {
            confirmed.extend(
                locations
                    .into_iter()
                    .filter(|location| {
                        location.inside_workspace && candidates.contains(&location.file_path)
                    })
                    .map(|location| location.file_path),
            );
        }
    }
    let Ok(mut engine) = state.context_engine.lock() else {
        return 0;
    };
    let Some(engine) = engine.as_mut() else {
        return 0;
    };
    confirmed.sort();
    confirmed.dedup();
    confirmed
        .iter()
        .filter(|target| engine.confirm_semantic_edge(&importer, target))
        .count()
}
