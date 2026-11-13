//! One language server working on the open documents, fed from the `ropey` buffers.
//!
//! The session remembers the exact text (`Rope` clones are cheap) of every revision it sent.
//! Diagnostics are delivered tagged with the revision they were computed for, their positions
//! converted against **that** text, never against whatever the buffer has become meanwhile.
//! How the revision is established depends on the server ([`DiagnosticsMode`]); diagnostics
//! that cannot be tied to a known revision are dropped.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use ropey::Rope;
use serde_json::{json, Value};

use super::client::{LspClient, LspError};
use super::features;
use super::uri::{file_uri_to_path, path_to_file_uri};
use crate::contracts::{
    DiagnosticEntry, DiagnosticSeverity, DiagnosticSource, DocumentDiagnostics,
    LanguageFeatureRequest, LanguageFeatureResponse, LineCol, TextChange, Utf16Span,
    CONTRACT_SCHEMA_VERSION,
};
use crate::offsets::{line_col_to_utf16_clamped, utf16_to_char_idx, utf16_to_line_col};
use crate::trust::{GatedCapability, WorkspaceTrustGate};

const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(20);
/// Pulled diagnostics wait for typing to pause, then for the server to answer.
const PULL_DEBOUNCE: Duration = Duration::from_millis(120);
const PULL_TIMEOUT: Duration = Duration::from_secs(30);
/// Revisions kept per document while waiting for the server's diagnostics.
const MAX_RETAINED_REVISIONS: usize = 256;
/// Bounds on what one untrusted `publishDiagnostics` may make us keep and render.
const MAX_DIAGNOSTICS_PER_DOCUMENT: usize = 2_000;
const MAX_MESSAGE_CHARS: usize = 4_000;
const MAX_CODE_CHARS: usize = 200;

/// How the revision of a server's diagnostics is established.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagnosticsMode {
    /// The server pushes `publishDiagnostics` carrying the document `version` (Biome).
    /// A push without a version is dropped.
    Push,
    /// The server pushes diagnostics without a version (`vtsls`), so pushes are ignored and
    /// diagnostics are requested instead, through `typescript.tsserverRequest`. An answer is
    /// attributed to revision V only if V was the last revision sent when the request was
    /// queued and still is when the answer arrives: the server then saw no other text between
    /// the two. Otherwise the answer is dropped and asked again.
    TsserverPull,
    /// Same rule, with the standard LSP 3.17 `textDocument/diagnostic` request (`tsgo`).
    LspPull,
}

/// How to launch a server and what its diagnostics are attributed to.
#[derive(Debug, Clone)]
pub struct LanguageServerProfile {
    pub source: DiagnosticSource,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub initialization_options: Value,
    pub diagnostics: DiagnosticsMode,
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
    /// The last revision sent to the server: the only text it can be working on.
    latest: u32,
    /// Text and content hash of each revision sent and not yet superseded by diagnostics.
    revisions: BTreeMap<u32, (Rope, String)>,
}

type DocumentTable = Arc<Mutex<HashMap<PathBuf, TrackedDocument>>>;

#[derive(Debug)]
pub struct LanguageServerSession {
    client: Arc<LspClient>,
    source: DiagnosticSource,
    documents: DocumentTable,
    incremental_sync: bool,
    /// Pull modes: paths whose diagnostics must be requested (again).
    pull_queue: Option<mpsc::Sender<PathBuf>>,
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
        let mode = profile.diagnostics;
        let handler_documents = Arc::clone(&documents);
        let handler_sink = Arc::clone(&sink);
        let client = Arc::new(LspClient::spawn(
            command,
            Box::new(move |method, params| {
                if mode == DiagnosticsMode::Push && method == "textDocument/publishDiagnostics" {
                    if let Some(batch) =
                        resolve_pushed_diagnostics(&handler_documents, source, params)
                    {
                        handler_sink(batch);
                    }
                }
            }),
        )?);

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
                        "completion": {"completionItem": {"snippetSupport": false}},
                        "definition": {"linkSupport": true},
                        "rename": {"prepareSupport": false},
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

        let pull_queue = (mode != DiagnosticsMode::Push).then(|| {
            let (queue, dirty) = mpsc::channel();
            let worker = PullWorker {
                client: Arc::clone(&client),
                documents: Arc::clone(&documents),
                source,
                mode,
                sink,
            };
            std::thread::spawn(move || worker.run(&dirty));
            queue
        });

        Ok(Self {
            client,
            source,
            documents,
            incremental_sync: sync_kind == Some(2),
            pull_queue,
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
        // Messages are queued while the table is locked, so the order in which revisions are
        // recorded here is the order in which the server receives them.
        let mut documents = lock(&self.documents);
        let previous = documents.insert(
            document.path.to_path_buf(),
            TrackedDocument {
                document_id: document.document_id.to_string(),
                session_generation: document.session_generation,
                uri: uri.clone(),
                latest: revision,
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
        )?;
        drop(documents);
        self.request_pull(document.path);
        Ok(())
    }

    fn request_pull(&self, path: &Path) {
        if let Some(queue) = &self.pull_queue {
            let _ = queue.send(path.to_path_buf());
        }
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
        let mut documents = lock(&self.documents);
        let Some(tracked) = documents.get_mut(document.path) else {
            return Ok(false);
        };
        if tracked.session_generation != document.session_generation {
            return Ok(false);
        }
        tracked.latest = revision;
        tracked.revisions.insert(
            revision,
            (rope_after.clone(), content_blake3_hash.to_string()),
        );
        while tracked.revisions.len() > MAX_RETAINED_REVISIONS {
            tracked.revisions.pop_first();
        }
        let content_changes = if self.incremental_sync {
            incremental_content_changes(rope_before, changes)
        } else {
            None
        }
        .unwrap_or_else(|| vec![json!({"text": rope_after.to_string()})]);
        // Queued under the lock: see `open_document`.
        self.client.notify(
            "textDocument/didChange",
            json!({
                "textDocument": {"uri": tracked.uri, "version": revision},
                "contentChanges": content_changes,
            }),
        )?;
        drop(documents);
        self.request_pull(document.path);
        Ok(true)
    }

    /// Answers a feature request about revision `request.revision` of the document at `path`.
    ///
    /// The request is refused unless that revision is the last one sent to the server, and it
    /// is queued behind that revision's `didChange`, so the server answers about exactly that
    /// text. The answer is converted against that text and tagged with that revision; the
    /// caller discards it if its own text has moved on meanwhile.
    pub fn request_feature(
        &self,
        path: &Path,
        workspace_root: &Path,
        request: &LanguageFeatureRequest,
        timeout: Duration,
    ) -> Result<LanguageFeatureResponse, LspError> {
        let (rope, hash, pending) = {
            let documents = lock(&self.documents);
            let tracked = documents.get(path).ok_or(LspError::NoServer)?;
            if tracked.document_id != request.document_id
                || tracked.session_generation != request.session_generation
                || tracked.latest != request.revision
            {
                return Err(LspError::StaleRevision {
                    requested: request.revision,
                    current: tracked.latest,
                });
            }
            let (rope, hash) = tracked.revisions.get(&request.revision).cloned().ok_or(
                LspError::StaleRevision {
                    requested: request.revision,
                    current: tracked.latest,
                },
            )?;
            let position = utf16_to_line_col(&rope, request.position_utf16)
                .map_err(|error| LspError::Protocol(error.to_string()))?;
            let (method, params) =
                features::request_params(&tracked.uri, position, &request.feature);
            (rope, hash, self.client.begin_request(method, params)?)
        };
        let answer = pending.wait(timeout)?;
        let result =
            features::convert_result(&request.feature, &answer, &rope, path, workspace_root)?;
        Ok(LanguageFeatureResponse {
            schema_version: CONTRACT_SCHEMA_VERSION,
            document_id: request.document_id.clone(),
            session_generation: request.session_generation,
            base_revision: request.revision,
            content_blake3_hash: hash,
            result,
        })
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
fn resolve_pushed_diagnostics(
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
fn batch_for_revision(
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
fn lsp_range(diagnostic: &Value) -> Option<(LineCol, LineCol)> {
    Some((
        position(diagnostic.pointer("/range/start")?, "line", "character", 0)?,
        position(diagnostic.pointer("/range/end")?, "line", "character", 0)?,
    ))
}

/// tsserver: `start` / `end`, one-based `line` and `offset` (UTF-16 units).
fn tsserver_range(diagnostic: &Value) -> Option<(LineCol, LineCol)> {
    Some((
        position(diagnostic.get("start")?, "line", "offset", 1)?,
        position(diagnostic.get("end")?, "line", "offset", 1)?,
    ))
}

/// Requests diagnostics from a server that cannot say which revision its pushes are for.
struct PullWorker {
    client: Arc<LspClient>,
    documents: DocumentTable,
    source: DiagnosticSource,
    mode: DiagnosticsMode,
    sink: DiagnosticsSink,
}

impl PullWorker {
    fn run(&self, dirty: &mpsc::Receiver<PathBuf>) {
        while let Ok(first) = dirty.recv() {
            // Let a burst of keystrokes settle: only the last revision is worth asking about.
            let mut paths = vec![first];
            while let Ok(next) = dirty.recv_timeout(PULL_DEBOUNCE) {
                if !paths.contains(&next) {
                    paths.push(next);
                }
            }
            for path in paths {
                if !self.client.is_alive() {
                    return;
                }
                self.pull(&path);
            }
        }
    }

    fn pull(&self, path: &Path) {
        // Queue the requests while the table is locked: they follow the `didChange` of
        // `version` in the stream, and no later change can slip in between.
        let (version, pending) = {
            let documents = lock(&self.documents);
            let Some(tracked) = documents.get(path) else {
                return;
            };
            let requests: Vec<(&str, Value)> = match self.mode {
                DiagnosticsMode::TsserverPull => [
                    "syntacticDiagnosticsSync",
                    "semanticDiagnosticsSync",
                    "suggestionDiagnosticsSync",
                ]
                .into_iter()
                .map(|command| {
                    (
                        "workspace/executeCommand",
                        json!({
                            "command": "typescript.tsserverRequest",
                            "arguments": [command, {"file": path.to_string_lossy()}],
                        }),
                    )
                })
                .collect(),
                DiagnosticsMode::LspPull => vec![(
                    "textDocument/diagnostic",
                    json!({"textDocument": {"uri": tracked.uri}}),
                )],
                DiagnosticsMode::Push => return,
            };
            let pending: Vec<_> = requests
                .into_iter()
                .filter_map(|(method, params)| self.client.begin_request(method, params).ok())
                .collect();
            (tracked.latest, pending)
        };

        let mut diagnostics = Vec::new();
        for request in pending {
            let Ok(answer) = request.wait(PULL_TIMEOUT) else {
                return; // an incomplete picture is not published
            };
            let items = match self.mode {
                DiagnosticsMode::TsserverPull => answer.get("body"),
                _ => answer.get("items"),
            };
            if let Some(items) = items.and_then(Value::as_array) {
                diagnostics.extend(items.iter().cloned());
            }
        }

        let batch = {
            let mut documents = lock(&self.documents);
            let Some(tracked) = documents.get_mut(path) else {
                return;
            };
            // A change was sent while the server was answering: it may have seen either text.
            // Drop the answer; that change has queued another pull.
            if tracked.latest != version {
                return;
            }
            let range_of = match self.mode {
                DiagnosticsMode::TsserverPull => tsserver_range,
                _ => lsp_range,
            };
            batch_for_revision(tracked, self.source, version, &diagnostics, range_of)
        };
        if let Some(batch) = batch {
            (self.sink)(batch);
        }
    }
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
            latest: revisions.last().map_or(0, |(revision, _)| *revision),
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
        let batch = resolve_pushed_diagnostics(
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
        assert!(resolve_pushed_diagnostics(
            &documents,
            DiagnosticSource::Biome,
            &publish(path, None, 0, 0, 1)
        )
        .is_none());
        // A version we never sent.
        assert!(resolve_pushed_diagnostics(
            &documents,
            DiagnosticSource::Biome,
            &publish(path, Some(9), 0, 0, 1)
        )
        .is_none());
        // A document we do not track, and a non-file URI.
        assert!(resolve_pushed_diagnostics(
            &documents,
            DiagnosticSource::Biome,
            &publish(Path::new("/w/other.ts"), Some(4), 0, 0, 1)
        )
        .is_none());
        assert!(resolve_pushed_diagnostics(
            &documents,
            DiagnosticSource::Biome,
            &json!({"uri": "https://x/a.ts", "version": 4, "diagnostics": []})
        )
        .is_none());

        // Once R5 diagnostics arrived, a late batch for R4 can no longer be resolved.
        assert!(resolve_pushed_diagnostics(
            &documents,
            DiagnosticSource::Biome,
            &publish(path, Some(5), 0, 0, 1)
        )
        .is_some());
        assert!(resolve_pushed_diagnostics(
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
        let batch =
            resolve_pushed_diagnostics(&documents, DiagnosticSource::Biome, &params).unwrap();
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
