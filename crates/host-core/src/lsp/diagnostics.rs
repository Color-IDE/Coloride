//! Turns what a language server says about a document into revision-tagged diagnostics.
//!
//! Everything here is untrusted input: positions are converted against the text of the revision
//! the diagnostics were computed for (never the current buffer), fields are length-capped, and
//! anything that cannot be tied to a known revision is dropped.

use ropey::Rope;
use serde_json::Value;

use super::session::{lock, DocumentTable, TrackedDocument};
use super::uri::file_uri_to_path;
use crate::contracts::{
    DiagnosticEntry, DiagnosticSeverity, DiagnosticSource, DocumentDiagnostics, LineCol, Utf16Span,
    CONTRACT_SCHEMA_VERSION,
};
use crate::offsets::{line_col_to_utf16_clamped, utf16_to_line_col};

/// Bounds on what one untrusted `publishDiagnostics` may make us keep and render.
const MAX_DIAGNOSTICS_PER_DOCUMENT: usize = 2_000;
pub(super) const MAX_MESSAGE_CHARS: usize = 4_000;
const MAX_CODE_CHARS: usize = 200;

/// Turns an untrusted `publishDiagnostics` into a revision-tagged batch, or drops it.
pub(super) fn resolve_pushed_diagnostics(
    documents: &DocumentTable,
    source: DiagnosticSource,
    params: &Value,
) -> Option<DocumentDiagnostics> {
    let path = file_uri_to_path(params.get("uri")?.as_str()?)?;
    // Without a version there is no way to know which text the ranges refer to.
    let version = u32::try_from(params.get("version")?.as_u64()?).ok()?;
    let mut documents = lock(documents);
    let tracked = documents.get_mut(&path)?;
    let diagnostics = params.get("diagnostics").and_then(Value::as_array);
    batch_for_revision(
        tracked,
        source,
        version,
        diagnostics.map_or(&[], Vec::as_slice),
        lsp_range,
    )
}

/// Builds the batch for `version` from raw diagnostics, converting positions against the text
/// of that revision. `None` if that text is no longer known.
pub(super) fn batch_for_revision(
    tracked: &mut TrackedDocument,
    source: DiagnosticSource,
    version: u32,
    diagnostics: &[Value],
    range_of: fn(&Value) -> Option<(LineCol, LineCol)>,
) -> Option<DocumentDiagnostics> {
    let (rope, hash) = tracked.revisions.get(&version)?.clone();
    // Diagnostics for older revisions can no longer be the latest word: forget those texts.
    tracked.revisions = tracked.revisions.split_off(&version);
    let items = diagnostics
        .iter()
        .take(MAX_DIAGNOSTICS_PER_DOCUMENT)
        .filter_map(|diagnostic| {
            diagnostic_entry(&tracked.document_id, source, &rope, diagnostic, range_of)
        })
        .collect();
    Some(DocumentDiagnostics {
        schema_version: CONTRACT_SCHEMA_VERSION,
        document_id: tracked.document_id.clone(),
        session_generation: tracked.session_generation,
        base_revision: version,
        content_blake3_hash: hash,
        source,
        items,
    })
}

fn position(value: &Value, line_key: &str, column_key: &str, base: u64) -> Option<LineCol> {
    Some(LineCol::new(
        u32::try_from(value.get(line_key)?.as_u64()?.checked_sub(base)?).ok()?,
        u32::try_from(value.get(column_key)?.as_u64()?.checked_sub(base)?).ok()?,
    ))
}

/// LSP: `range.start` / `range.end`, zero-based `line` and `character`.
pub(super) fn lsp_range(diagnostic: &Value) -> Option<(LineCol, LineCol)> {
    Some((
        position(diagnostic.pointer("/range/start")?, "line", "character", 0)?,
        position(diagnostic.pointer("/range/end")?, "line", "character", 0)?,
    ))
}

/// tsserver: `start` / `end`, one-based `line` and `offset` (UTF-16 units).
pub(super) fn tsserver_range(diagnostic: &Value) -> Option<(LineCol, LineCol)> {
    Some((
        position(diagnostic.get("start")?, "line", "offset", 1)?,
        position(diagnostic.get("end")?, "line", "offset", 1)?,
    ))
}

fn diagnostic_entry(
    document_id: &str,
    source: DiagnosticSource,
    rope: &Rope,
    diagnostic: &Value,
    range_of: fn(&Value) -> Option<(LineCol, LineCol)>,
) -> Option<DiagnosticEntry> {
    let (start, end) = range_of(diagnostic)?;
    let start = line_col_to_utf16_clamped(rope, start);
    let end = line_col_to_utf16_clamped(rope, end).max(start);
    // LSP numbers severities; tsserver names categories.
    let severity = match diagnostic
        .get("severity")
        .or_else(|| diagnostic.get("category"))
    {
        Some(Value::Number(severity)) => match severity.as_u64() {
            Some(1) => DiagnosticSeverity::Error,
            Some(2) => DiagnosticSeverity::Warning,
            _ => DiagnosticSeverity::Information,
        },
        Some(Value::String(category)) => match category.as_str() {
            "error" => DiagnosticSeverity::Error,
            "warning" => DiagnosticSeverity::Warning,
            _ => DiagnosticSeverity::Information,
        },
        _ => DiagnosticSeverity::Error,
    };
    let code = match diagnostic.get("code") {
        Some(Value::String(code)) => code.chars().take(MAX_CODE_CHARS).collect(),
        Some(Value::Number(code)) => code.to_string(),
        _ => String::new(),
    };
    let message = diagnostic
        .get("message")
        .or_else(|| diagnostic.get("text"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .chars()
        .take(MAX_MESSAGE_CHARS)
        .collect();
    Some(DiagnosticEntry {
        file_path: document_id.to_string(),
        span_utf16: Utf16Span::new(start, end),
        line_col: utf16_to_line_col(rope, start).ok()?,
        source,
        severity,
        code,
        message,
    })
}
