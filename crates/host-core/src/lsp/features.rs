//! Language features (completion, definition, references, rename, formatting): building the
//! LSP request and turning the server's untrusted answer into revision-bound results.
//!
//! Positions in the requesting document are converted against the text of the revision the
//! request was made for, never against a later one.

use std::path::Path;

use ropey::Rope;
use serde_json::{json, Value};

use super::client::LspError;
use super::uri::file_uri_to_path;
use crate::contracts::{
    LanguageCompletionItem, LanguageFeature, LanguageFeatureResult, LanguageFileEdit,
    LanguageFileEdits, LanguageLocation, LanguageTextEdit, LineCol, Utf16Span,
};
use crate::offsets::line_col_to_utf16_clamped;

const MAX_COMPLETIONS: usize = 1_000;
const MAX_LOCATIONS: usize = 2_000;
const MAX_EDITS: usize = 20_000;
const MAX_LABEL_CHARS: usize = 500;

/// LSP method and parameters for `feature` at `position` of the document `uri`.
pub(super) fn request_params(
    uri: &str,
    position: LineCol,
    feature: &LanguageFeature,
) -> (&'static str, Value) {
    let at = json!({
        "textDocument": {"uri": uri},
        "position": {"line": position.line, "character": position.col_utf16},
    });
    let with = |mut base: Value, key: &str, value: Value| {
        base[key] = value;
        base
    };
    match feature {
        LanguageFeature::Completion => ("textDocument/completion", at),
        LanguageFeature::Definition => ("textDocument/definition", at),
        LanguageFeature::References => (
            "textDocument/references",
            with(at, "context", json!({"includeDeclaration": true})),
        ),
        LanguageFeature::Rename { new_name } => {
            ("textDocument/rename", with(at, "newName", json!(new_name)))
        }
        LanguageFeature::Formatting => (
            "textDocument/formatting",
            json!({
                "textDocument": {"uri": uri},
                "options": {"tabSize": 2, "insertSpaces": true},
            }),
        ),
    }
}

/// Where a server-provided file is, relative to the workspace when inside it.
struct FileRef {
    file_path: String,
    inside_workspace: bool,
    is_document: bool,
}

fn file_ref(uri: &Value, document_path: &Path, workspace_root: &Path) -> Option<FileRef> {
    let path = file_uri_to_path(uri.as_str()?)?;
    let is_document = path == document_path
        || path
            .canonicalize()
            .is_ok_and(|canonical| canonical == document_path);
    let (file_path, inside_workspace) = match path.strip_prefix(workspace_root) {
        Ok(relative) => (relative.to_string_lossy().replace('\\', "/"), true),
        Err(_) => (path.to_string_lossy().into_owned(), false),
    };
    Some(FileRef {
        file_path,
        inside_workspace,
        is_document,
    })
}

fn line_col(value: &Value) -> Option<LineCol> {
    Some(LineCol::new(
        u32::try_from(value.get("line")?.as_u64()?).ok()?,
        u32::try_from(value.get("character")?.as_u64()?).ok()?,
    ))
}

fn range(value: &Value) -> Option<(LineCol, LineCol)> {
    Some((line_col(value.get("start")?)?, line_col(value.get("end")?)?))
}

fn span(rope: &Rope, (start, end): (LineCol, LineCol)) -> Utf16Span {
    let start = line_col_to_utf16_clamped(rope, start);
    let end = line_col_to_utf16_clamped(rope, end).max(start);
    Utf16Span::new(start, end)
}

fn as_list(value: &Value) -> &[Value] {
    match value {
        Value::Array(items) => items,
        Value::Null => &[],
        single => std::slice::from_ref(single),
    }
}

fn locations(
    answer: &Value,
    rope: &Rope,
    document_path: &Path,
    workspace_root: &Path,
) -> Vec<LanguageLocation> {
    as_list(answer)
        .iter()
        .take(MAX_LOCATIONS)
        .filter_map(|location| {
            // `Location` or `LocationLink`.
            let uri = location.get("uri").or_else(|| location.get("targetUri"))?;
            let target = location
                .get("range")
                .or_else(|| location.get("targetSelectionRange"))
                .or_else(|| location.get("targetRange"))?;
            let file = file_ref(uri, document_path, workspace_root)?;
            let (start, end) = range(target)?;
            Some(LanguageLocation {
                span_utf16: file.is_document.then(|| span(rope, (start, end))),
                file_path: file.file_path,
                inside_workspace: file.inside_workspace,
                start,
                end,
            })
        })
        .collect()
}

/// Edits of the requesting document, sorted; overlapping edits make the answer invalid.
fn document_edits(edits: &[Value], rope: &Rope) -> Result<Vec<LanguageTextEdit>, LspError> {
    if edits.len() > MAX_EDITS {
        return Err(LspError::Protocol("too many edits".into()));
    }
    let mut converted: Vec<LanguageTextEdit> = edits
        .iter()
        .filter_map(|edit| {
            Some(LanguageTextEdit {
                span_utf16: span(rope, range(edit.get("range")?)?),
                new_text: edit.get("newText")?.as_str()?.to_string(),
            })
        })
        .collect();
    converted.sort_by_key(|edit| (edit.span_utf16.start, edit.span_utf16.end));
    if converted
        .windows(2)
        .any(|pair| pair[1].span_utf16.start < pair[0].span_utf16.end)
    {
        return Err(LspError::Protocol("overlapping edits".into()));
    }
    Ok(converted)
}

fn rename(
    answer: &Value,
    rope: &Rope,
    document_path: &Path,
    workspace_root: &Path,
) -> Result<LanguageFeatureResult, LspError> {
    // `WorkspaceEdit.changes` ({uri: TextEdit[]}) or `documentChanges` (TextDocumentEdit[]).
    let mut per_file: Vec<(Value, &[Value])> = Vec::new();
    if let Some(changes) = answer.get("changes").and_then(Value::as_object) {
        for (uri, edits) in changes {
            per_file.push((Value::String(uri.clone()), as_list(edits)));
        }
    }
    if let Some(document_changes) = answer.get("documentChanges").and_then(Value::as_array) {
        for change in document_changes {
            // File creations, renames and deletions are not applied from a rename.
            let (Some(uri), Some(edits)) = (
                change.pointer("/textDocument/uri"),
                change.get("edits").and_then(Value::as_array),
            ) else {
                continue;
            };
            per_file.push((uri.clone(), edits));
        }
    }
    let mut edits = Vec::new();
    let mut other_files = Vec::new();
    for (uri, file_edits) in per_file {
        let Some(file) = file_ref(&uri, document_path, workspace_root) else {
            continue;
        };
        if file.is_document {
            edits.extend(document_edits(file_edits, rope)?);
        } else {
            other_files.push(LanguageFileEdits {
                file_path: file.file_path,
                inside_workspace: file.inside_workspace,
                edits: file_edits
                    .iter()
                    .take(MAX_EDITS)
                    .filter_map(|edit| {
                        let (start, end) = range(edit.get("range")?)?;
                        Some(LanguageFileEdit {
                            start,
                            end,
                            new_text: edit.get("newText")?.as_str()?.to_string(),
                        })
                    })
                    .collect(),
            });
        }
    }
    edits.sort_by_key(|edit| (edit.span_utf16.start, edit.span_utf16.end));
    if edits
        .windows(2)
        .any(|pair| pair[1].span_utf16.start < pair[0].span_utf16.end)
    {
        return Err(LspError::Protocol("overlapping rename edits".into()));
    }
    Ok(LanguageFeatureResult::Rename { edits, other_files })
}

fn completion_kind(kind: Option<u64>) -> &'static str {
    match kind {
        Some(2) => "method",
        Some(3) => "function",
        Some(4) => "constructor",
        Some(5) => "field",
        Some(6) => "variable",
        Some(7) => "class",
        Some(8) => "interface",
        Some(9) => "module",
        Some(10) => "property",
        Some(12) => "value",
        Some(13) => "enum",
        Some(14) => "keyword",
        Some(15) => "snippet",
        Some(17) => "file",
        Some(19) => "folder",
        Some(20) => "enum-member",
        Some(21) => "constant",
        Some(22) => "struct",
        Some(23) => "event",
        Some(24) => "operator",
        Some(25) => "type-parameter",
        _ => "text",
    }
}

/// Plain text of an LSP snippet: tab stops removed, placeholders and first choices kept.
fn strip_snippet(snippet: &str) -> String {
    let chars: Vec<char> = snippet.chars().collect();
    let mut out = String::with_capacity(snippet.len());
    let mut open_placeholders = 0_usize;
    let mut i = 0;
    while i < chars.len() {
        let next = chars.get(i + 1).copied();
        match chars[i] {
            '\\' if next.is_some() => {
                out.extend(next);
                i += 2;
            }
            '$' if next.is_some_and(|c| c.is_ascii_digit()) => {
                i += 1;
                while chars.get(i).is_some_and(char::is_ascii_digit) {
                    i += 1;
                }
            }
            '$' if next == Some('{') => {
                let mut j = i + 2;
                while chars.get(j).is_some_and(char::is_ascii_digit) {
                    j += 1;
                }
                match chars.get(j) {
                    Some(':') => {
                        open_placeholders += 1;
                        i = j + 1;
                    }
                    Some('|') => {
                        // ${1|first,second|}: keep the first choice.
                        let rest: String = chars[j + 1..].iter().collect();
                        let end = rest.find("|}").unwrap_or(rest.len());
                        let choices = &rest[..end];
                        out.push_str(choices.split(',').next().unwrap_or_default());
                        i = j + 1 + rest[..end].chars().count() + 2;
                    }
                    Some('}') => i = j + 1,
                    _ => {
                        out.push('$');
                        i += 1;
                    }
                }
            }
            '}' if open_placeholders > 0 => {
                open_placeholders -= 1;
                i += 1;
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    out
}

fn capped(text: &str) -> String {
    text.chars().take(MAX_LABEL_CHARS).collect()
}

fn completions(answer: &Value, rope: &Rope) -> LanguageFeatureResult {
    let (items, is_incomplete) = match answer {
        Value::Object(list) => (
            list.get("items").map_or(&[][..], as_list),
            list.get("isIncomplete")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
        other => (as_list(other), false),
    };
    let items = items
        .iter()
        .take(MAX_COMPLETIONS)
        .filter_map(|item| {
            let label = capped(item.get("label")?.as_str()?);
            let text_edit = item.get("textEdit");
            let raw_insert = text_edit
                .and_then(|edit| edit.get("newText"))
                .or_else(|| item.get("insertText"))
                .and_then(Value::as_str)
                .unwrap_or(&label);
            let insert_text = if item.get("insertTextFormat").and_then(Value::as_u64) == Some(2) {
                strip_snippet(raw_insert)
            } else {
                raw_insert.to_string()
            };
            let replace = text_edit
                .and_then(|edit| edit.get("range").or_else(|| edit.get("replace")))
                .and_then(range)
                .map(|bounds| span(rope, bounds));
            Some(LanguageCompletionItem {
                kind: completion_kind(item.get("kind").and_then(Value::as_u64)).to_string(),
                detail: item.get("detail").and_then(Value::as_str).map(capped),
                sort_text: item
                    .get("sortText")
                    .and_then(Value::as_str)
                    .map_or_else(|| label.clone(), capped),
                filter_text: item
                    .get("filterText")
                    .and_then(Value::as_str)
                    .map_or_else(|| label.clone(), capped),
                insert_text,
                replace_span_utf16: replace,
                label,
            })
        })
        .collect();
    LanguageFeatureResult::Completions {
        items,
        is_incomplete,
    }
}

/// Converts the server's answer, against the text of the revision the request was made for.
pub(super) fn convert_result(
    feature: &LanguageFeature,
    answer: &Value,
    rope: &Rope,
    document_path: &Path,
    workspace_root: &Path,
) -> Result<LanguageFeatureResult, LspError> {
    Ok(match feature {
        LanguageFeature::Completion => completions(answer, rope),
        LanguageFeature::Definition | LanguageFeature::References => {
            LanguageFeatureResult::Locations {
                locations: locations(answer, rope, document_path, workspace_root),
            }
        }
        LanguageFeature::Formatting => LanguageFeatureResult::Edits {
            edits: document_edits(as_list(answer), rope)?,
        },
        LanguageFeature::Rename { .. } => rename(answer, rope, document_path, workspace_root)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippets_become_plain_text() {
        assert_eq!(strip_snippet("log($1)$0"), "log()");
        assert_eq!(
            strip_snippet("for (${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++)"),
            "for (i = 0; i < n; i++)"
        );
        assert_eq!(strip_snippet("${1|let,const|} x"), "let x");
        assert_eq!(
            strip_snippet("a\\$b ${1:outer ${2:inner}} $"),
            "a$b outer inner $"
        );
    }

    #[test]
    fn overlapping_or_out_of_range_edits_are_handled_safely() {
        let rope = Rope::from_str("abc\ndef\n");
        let edit = |l0: u64, c0: u64, l1: u64, c1: u64| json!({"range": {"start": {"line": l0, "character": c0}, "end": {"line": l1, "character": c1}}, "newText": "x"});
        let overlapping = [edit(0, 0, 0, 2), edit(0, 1, 0, 3)];
        assert!(document_edits(&overlapping, &rope).is_err());
        // Past the end: clamped to the document, not out of bounds.
        let converted = document_edits(&[edit(9, 0, 9, 9), edit(0, 0, 0, 1)], &rope).unwrap();
        assert_eq!(converted[0].span_utf16.start.as_u32(), 0);
        assert_eq!(converted[1].span_utf16.start.as_u32(), 8);
    }

    #[test]
    fn locations_in_the_document_get_spans_others_are_relative_to_the_workspace() {
        let rope = Rope::from_str("let 𝄞 = a;\n");
        let root = Path::new("/w");
        let document = Path::new("/w/src/a.ts");
        let answer = json!([
            {"uri": "file:///w/src/a.ts", "range": {"start": {"line": 0, "character": 9}, "end": {"line": 0, "character": 10}}},
            {"targetUri": "file:///w/src/b.ts", "targetSelectionRange": {"start": {"line": 3, "character": 1}, "end": {"line": 3, "character": 2}}},
            {"uri": "file:///lib/x.d.ts", "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 1}}},
            {"uri": "https://evil", "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 1}}},
        ]);
        let found = locations(&answer, &rope, document, root);
        assert_eq!(found.len(), 3);
        assert_eq!(
            found[0]
                .span_utf16
                .map(|s| (s.start.as_u32(), s.end.as_u32())),
            Some((9, 10))
        );
        assert_eq!(
            (
                found[1].file_path.as_str(),
                found[1].inside_workspace,
                found[1].span_utf16
            ),
            ("src/b.ts", true, None)
        );
        assert_eq!(
            (found[2].file_path.as_str(), found[2].inside_workspace),
            ("/lib/x.d.ts", false)
        );
    }
}
