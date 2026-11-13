//! One language server working on the open documents, fed from the `ropey` buffers.
//!
//! The session remembers the exact text (`Rope` clones are cheap) of every revision it sent.
//! A `publishDiagnostics` names the version it was computed for; its positions are converted
//! against **that** text and delivered tagged with that revision, never against whatever the
//! buffer has become meanwhile. Diagnostics that cannot be tied to a known revision are dropped.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ropey::Rope;
use serde_json::{json, Value};

use super::client::{LspClient, LspError};
use super::uri::{file_uri_to_path, path_to_file_uri};
use crate::contracts::{
    DiagnosticEntry, DiagnosticSeverity, DiagnosticSource, DocumentDiagnostics, LineCol,
    TextChange, Utf16Span, CONTRACT_SCHEMA_VERSION,
};
use crate::offsets::{line_col_to_utf16_clamped, utf16_to_char_idx, utf16_to_line_col};
use crate::trust::{GatedCapability, WorkspaceTrustGate};

const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(20);
/// Revisions kept per document while waiting for the server's diagnostics.
const MAX_RETAINED_REVISIONS: usize = 256;
/// Bounds on what one untrusted `publishDiagnostics` may make us keep and render.
const MAX_DIAGNOSTICS_PER_DOCUMENT: usize = 2_000;
const MAX_MESSAGE_CHARS: usize = 4_000;
const MAX_CODE_CHARS: usize = 200;

/// How to launch a server and what its diagnostics are attributed to.
#[derive(Debug, Clone)]
pub struct LanguageServerProfile {
    pub source: DiagnosticSource,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub initialization_options: Value,
}

/// Receives each batch of revision-tagged diagnostics (called on the server's reader thread).
pub type DiagnosticsSink = Arc<dyn Fn(DocumentDiagnostics) + Send + Sync>;

/// An open document as the Host identifies it.
#[derive(Debug, Clone, Copy)]
pub struct DocumentRef<'a> {
    pub document_id: &'a str,
    pub session_generation: u32,
    /// Absolute path of the file (canonical when it exists).
    pub path: &'a Path,
}

#[derive(Debug)]
struct TrackedDocument {
    document_id: String,
    session_generation: u32,
    uri: String,
    /// Text and content hash of each revision sent and not yet superseded by diagnostics.
    revisions: BTreeMap<u32, (Rope, String)>,
}

type DocumentTable = Arc<Mutex<HashMap<PathBuf, TrackedDocument>>>;

#[derive(Debug)]
pub struct LanguageServerSession {
    client: LspClient,
    source: DiagnosticSource,
    documents: DocumentTable,
    incremental_sync: bool,
}

impl LanguageServerSession {
    /// Launches the server through the trust gate and performs the `initialize` handshake.
    pub fn start(
        gate: &WorkspaceTrustGate,
        profile: &LanguageServerProfile,
        sink: DiagnosticsSink,
    ) -> Result<Self, LspError> {
        let mut command =
            gate.command(GatedCapability::WorkspaceLanguageServer, &profile.program)?;
        command
            .command_mut()
            .args(&profile.args)
            .current_dir(gate.workspace_root());

        let documents: DocumentTable = Arc::default();
        let source = profile.source;
        let handler_documents = Arc::clone(&documents);
        let client = LspClient::spawn(
            command,
            Box::new(move |method, params| {
                if method == "textDocument/publishDiagnostics" {
                    if let Some(batch) = resolve_diagnostics(&handler_documents, source, params) {
                        sink(batch);
                    }
                }
            }),
        )?;

        let root_uri = path_to_file_uri(gate.workspace_root());
        let initialized = client.request(
            "initialize",
            json!({
                "processId": std::process::id(),
                "clientInfo": {"name": "Coloride", "version": env!("CARGO_PKG_VERSION")},
                "rootUri": root_uri,
                "workspaceFolders": [{"uri": root_uri, "name": "workspace"}],
                "initializationOptions": profile.initialization_options,
                "capabilities": {
                    "general": {"positionEncodings": ["utf-16"]},
                    "textDocument": {
                        "synchronization": {"dynamicRegistration": false},
                        "publishDiagnostics": {"versionSupport": true},
                    },
                    "workspace": {"configuration": true, "workspaceFolders": true},
                },
            }),
            INITIALIZE_TIMEOUT,
        )?;

        // Every offset we exchange is UTF-16 (the LSP default). A server that insists on
        // another encoding would silently shift every range: refuse it.
        let encoding = initialized
            .pointer("/capabilities/positionEncoding")
            .and_then(Value::as_str)
            .unwrap_or("utf-16");
        if encoding != "utf-16" {
            client.shutdown();
            return Err(LspError::Protocol(format!(
                "server uses position encoding `{encoding}`, only utf-16 is supported"
            )));
        }
        let sync = initialized.pointer("/capabilities/textDocumentSync");
        let sync_kind = sync.and_then(Value::as_u64).or_else(|| {
            sync.and_then(|sync| sync.get("change"))
                .and_then(Value::as_u64)
        });
        client.notify("initialized", json!({}))?;

        Ok(Self {
            client,
            source,
            documents,
            incremental_sync: sync_kind == Some(2),
        })
    }

    #[must_use]
    pub fn source(&self) -> DiagnosticSource {
        self.source
    }

    #[must_use]
    pub fn is_alive(&self) -> bool {
        self.client.is_alive()
    }

    /// OS process id of the server.
    #[must_use]
    pub fn process_id(&self) -> u32 {
        self.client.process_id()
    }

    #[must_use]
    pub fn client(&self) -> &LspClient {
        &self.client
    }

    /// Sends the full text of a document at `revision` (also used when a document is reopened
    /// under a new session generation).
    pub fn open_document(
        &self,
        document: DocumentRef<'_>,
        language_id: &str,
        revision: u32,
        rope: &Rope,
        content_blake3_hash: &str,
    ) -> Result<(), LspError> {
        let uri = path_to_file_uri(document.path);
        let previous = lock(&self.documents).insert(
            document.path.to_path_buf(),
            TrackedDocument {
                document_id: document.document_id.to_string(),
                session_generation: document.session_generation,
                uri: uri.clone(),
                revisions: BTreeMap::from([(
                    revision,
                    (rope.clone(), content_blake3_hash.to_string()),
                )]),
            },
        );
        if previous.is_some() {
            self.client.notify(
                "textDocument/didClose",
                json!({"textDocument": {"uri": uri}}),
            )?;
        }
        self.client.notify(
            "textDocument/didOpen",
            json!({"textDocument": {
                "uri": uri,
                "languageId": language_id,
                "version": revision,
                "text": rope.to_string(),
            }}),
        )
    }

    /// Forwards one applied `EditorTransaction`: `changes` turned `rope_before` into
    /// `rope_after`, which is revision `revision`. Returns `Ok(false)` if the document is not
    /// open on this server (or belongs to another session generation).
    pub fn change_document(
        &self,
        document: DocumentRef<'_>,
        revision: u32,
        rope_before: &Rope,
        changes: &[TextChange],
        rope_after: &Rope,
        content_blake3_hash: &str,
    ) -> Result<bool, LspError> {
        let uri = {
            let mut documents = lock(&self.documents);
            let Some(tracked) = documents.get_mut(document.path) else {
                return Ok(false);
            };
            if tracked.session_generation != document.session_generation {
                return Ok(false);
            }
            tracked.revisions.insert(
                revision,
                (rope_after.clone(), content_blake3_hash.to_string()),
            );
            while tracked.revisions.len() > MAX_RETAINED_REVISIONS {
                tracked.revisions.pop_first();
            }
            tracked.uri.clone()
        };
        let content_changes = if self.incremental_sync {
            incremental_content_changes(rope_before, changes)
        } else {
            None
        }
        .unwrap_or_else(|| vec![json!({"text": rope_after.to_string()})]);
        self.client.notify(
            "textDocument/didChange",
            json!({
                "textDocument": {"uri": uri, "version": revision},
                "contentChanges": content_changes,
            }),
        )?;
        Ok(true)
    }

    pub fn close_document(&self, path: &Path) -> Result<(), LspError> {
        let Some(tracked) = lock(&self.documents).remove(path) else {
            return Ok(());
        };
        self.client.notify(
            "textDocument/didClose",
            json!({"textDocument": {"uri": tracked.uri}}),
        )
    }

    /// Stops the server and kills its process group.
    pub fn shutdown(&self) {
        self.client.shutdown();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// LSP applies content changes one after the other, exactly as `EditorTransaction` changes are
/// applied to the rope, so each range is expressed against the text left by the previous one.
/// `None` if a range does not fit the text (the caller then sends the full text instead).
fn incremental_content_changes(rope_before: &Rope, changes: &[TextChange]) -> Option<Vec<Value>> {
    let mut staged = rope_before.clone();
    let mut content_changes = Vec::with_capacity(changes.len());
    for change in changes {
        let start = utf16_to_line_col(&staged, change.range_utf16.start).ok()?;
        let end = utf16_to_line_col(&staged, change.range_utf16.end).ok()?;
        content_changes.push(json!({
            "range": {
                "start": {"line": start.line, "character": start.col_utf16},
                "end": {"line": end.line, "character": end.col_utf16},
            },
            "text": change.inserted_text,
        }));
        let start_char = utf16_to_char_idx(&staged, change.range_utf16.start).ok()?;
        let end_char = utf16_to_char_idx(&staged, change.range_utf16.end).ok()?;
        if start_char > end_char {
            return None;
        }
        staged.remove(start_char..end_char);
        staged.insert(start_char, &change.inserted_text);
    }
    Some(content_changes)
}

/// Turns an untrusted `publishDiagnostics` into a revision-tagged batch, or drops it.
fn resolve_diagnostics(
    documents: &DocumentTable,
    source: DiagnosticSource,
    params: &Value,
) -> Option<DocumentDiagnostics> {
    let path = file_uri_to_path(params.get("uri")?.as_str()?)?;
    // Without a version there is no way to know which text the ranges refer to.
    let version = u32::try_from(params.get("version")?.as_u64()?).ok()?;
    let mut documents = lock(documents);
    let tracked = documents.get_mut(&path)?;
    let (rope, hash) = tracked.revisions.get(&version)?.clone();
    // Diagnostics for older revisions can no longer be the latest word: forget those texts.
    tracked.revisions = tracked.revisions.split_off(&version);

    let items = params
        .get("diagnostics")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .take(MAX_DIAGNOSTICS_PER_DOCUMENT)
        .filter_map(|diagnostic| diagnostic_entry(&tracked.document_id, source, &rope, diagnostic))
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

fn diagnostic_entry(
    document_id: &str,
    source: DiagnosticSource,
    rope: &Rope,
    diagnostic: &Value,
) -> Option<DiagnosticEntry> {
    let position = |pointer: &str| -> Option<LineCol> {
        let position = diagnostic.pointer(pointer)?;
        Some(LineCol::new(
            u32::try_from(position.get("line")?.as_u64()?).ok()?,
            u32::try_from(position.get("character")?.as_u64()?).ok()?,
        ))
    };
    let start = line_col_to_utf16_clamped(rope, position("/range/start")?);
    let end = line_col_to_utf16_clamped(rope, position("/range/end")?).max(start);
    let severity = match diagnostic.get("severity").and_then(Value::as_u64) {
        Some(1) | None => DiagnosticSeverity::Error,
        Some(2) => DiagnosticSeverity::Warning,
        Some(_) => DiagnosticSeverity::Information,
    };
    let code = match diagnostic.get("code") {
        Some(Value::String(code)) => code.chars().take(MAX_CODE_CHARS).collect(),
        Some(Value::Number(code)) => code.to_string(),
        _ => String::new(),
    };
    let message = diagnostic
        .get("message")
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::Utf16CodeUnitOffset;

    fn change(start: u32, end: u32, text: &str) -> TextChange {
        TextChange {
            range_utf16: Utf16Span::new(
                Utf16CodeUnitOffset::new(start),
                Utf16CodeUnitOffset::new(end),
            ),
            range_utf8: None,
            inserted_text: text.to_string(),
        }
    }

    fn table(path: &Path, revisions: &[(u32, &str)]) -> DocumentTable {
        let tracked = TrackedDocument {
            document_id: "src/a.ts".into(),
            session_generation: 7,
            uri: path_to_file_uri(path),
            revisions: revisions
                .iter()
                .map(|(revision, text)| {
                    (
                        *revision,
                        (Rope::from_str(text), format!("hash-{revision}")),
                    )
                })
                .collect(),
        };
        Arc::new(Mutex::new(HashMap::from([(path.to_path_buf(), tracked)])))
    }

    fn publish(path: &Path, version: Option<u32>, line: u32, from: u32, to: u32) -> Value {
        let mut params = json!({
            "uri": path_to_file_uri(path),
            "diagnostics": [{
                "range": {"start": {"line": line, "character": from}, "end": {"line": line, "character": to}},
                "severity": 2, "code": 2304, "message": "m",
            }],
        });
        if let Some(version) = version {
            params["version"] = json!(version);
        }
        params
    }

    #[test]
    fn sequential_changes_are_expressed_against_the_text_left_by_the_previous_one() {
        // "𝄞" is one char, two UTF-16 units: columns after it must count two.
        let before = Rope::from_str("a𝄞b\nsecond\n");
        let changes = [change(0, 1, "XY\n"), change(5, 6, "")];
        let sent = incremental_content_changes(&before, &changes).unwrap();
        assert_eq!(
            sent[0]["range"],
            json!({"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 1}})
        );
        // After the first change the text is "XY\n𝄞b\nsecond\n": offset 5..6 is "b" on line 1.
        assert_eq!(
            sent[1]["range"],
            json!({"start": {"line": 1, "character": 2}, "end": {"line": 1, "character": 3}})
        );
        // A range that does not fit the text falls back to full sync.
        assert!(incremental_content_changes(&before, &[change(2, 3, "")]).is_none());
        assert!(incremental_content_changes(&before, &[change(90, 91, "")]).is_none());
    }

    #[test]
    fn diagnostics_are_converted_against_the_text_of_their_own_revision() {
        let path = Path::new("/w/src/a.ts");
        // R4: the flagged token `x` is on line 0. R5 inserted a line above it.
        let documents = table(path, &[(4, "let 𝄞 = x;\n"), (5, "// new\nlet 𝄞 = x;\n")]);
        let batch = resolve_diagnostics(
            &documents,
            DiagnosticSource::Vtsls,
            &publish(path, Some(4), 0, 9, 10),
        )
        .unwrap();
        assert_eq!(batch.base_revision, 4);
        assert_eq!(batch.content_blake3_hash, "hash-4");
        assert_eq!(batch.session_generation, 7);
        let item = &batch.items[0];
        // Offsets in the R4 text, not shifted by the R5 insertion.
        assert_eq!(
            (item.span_utf16.start.as_u32(), item.span_utf16.end.as_u32()),
            (9, 10)
        );
        assert_eq!(item.severity, DiagnosticSeverity::Warning);
        assert_eq!(item.code, "2304");
        assert_eq!(item.file_path, "src/a.ts");
    }

    #[test]
    fn diagnostics_without_a_known_revision_are_dropped() {
        let path = Path::new("/w/src/a.ts");
        let documents = table(path, &[(4, "let a;\n"), (5, "let ab;\n")]);
        // No version at all.
        assert!(resolve_diagnostics(
            &documents,
            DiagnosticSource::Biome,
            &publish(path, None, 0, 0, 1)
        )
        .is_none());
        // A version we never sent.
        assert!(resolve_diagnostics(
            &documents,
            DiagnosticSource::Biome,
            &publish(path, Some(9), 0, 0, 1)
        )
        .is_none());
        // A document we do not track, and a non-file URI.
        assert!(resolve_diagnostics(
            &documents,
            DiagnosticSource::Biome,
            &publish(Path::new("/w/other.ts"), Some(4), 0, 0, 1)
        )
        .is_none());
        assert!(resolve_diagnostics(
            &documents,
            DiagnosticSource::Biome,
            &json!({"uri": "https://x/a.ts", "version": 4, "diagnostics": []})
        )
        .is_none());

        // Once R5 diagnostics arrived, a late batch for R4 can no longer be resolved.
        assert!(resolve_diagnostics(
            &documents,
            DiagnosticSource::Biome,
            &publish(path, Some(5), 0, 0, 1)
        )
        .is_some());
        assert!(resolve_diagnostics(
            &documents,
            DiagnosticSource::Biome,
            &publish(path, Some(4), 0, 0, 1)
        )
        .is_none());
    }

    #[test]
    fn hostile_ranges_and_payloads_are_clamped_never_out_of_bounds() {
        let path = Path::new("/w/src/a.ts");
        let text = "ab𝄞\ncd\n";
        let documents = table(path, &[(1, text)]);
        let len = Rope::from_str(text).len_utf16_cu() as u32;
        let huge = "x".repeat(MAX_MESSAGE_CHARS * 2);
        let params = json!({
            "uri": path_to_file_uri(path), "version": 1,
            "diagnostics": [
                {"range": {"start": {"line": 0, "character": 3}, "end": {"line": 0, "character": 999}}, "message": huge},
                {"range": {"start": {"line": 500, "character": 0}, "end": {"line": 900, "character": 4}}, "message": "past the end"},
                {"range": {"start": {"line": 1, "character": 2}, "end": {"line": 0, "character": 0}}, "message": "inverted"},
                {"range": {"start": {"line": -1, "character": 0}, "end": {"line": 0, "character": 0}}, "message": "negative"},
                {"message": "no range"},
                "not an object",
            ],
        });
        let batch = resolve_diagnostics(&documents, DiagnosticSource::Biome, &params).unwrap();
        let spans: Vec<(u32, u32)> = batch
            .items
            .iter()
            .map(|item| (item.span_utf16.start.as_u32(), item.span_utf16.end.as_u32()))
            .collect();
        // Column 3 is inside the surrogate pair of 𝄞 (units 2..4): snapped back to 2; the end is
        // clamped to the end of line 0.
        assert_eq!(spans, [(2, 4), (len, len), (7, 7)]);
        assert_eq!(batch.items[0].message.chars().count(), MAX_MESSAGE_CHARS);
    }
}
