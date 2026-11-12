use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use ropey::Rope;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::contracts::{
    ColorideValidationState, EditorSelection, EditorSnapshot, EditorTransaction, TextChange,
    TransactionOrigin, Utf16Span, Utf8ByteOffset, Utf8Span, CONTRACT_SCHEMA_VERSION,
};
use crate::journal::{JournalError, JournalRecord, WriteAheadJournal};
use crate::offsets::{
    compute_rope_blake3_hex, utf16_span_to_utf8, utf16_to_char_idx, utf16_to_line_col,
    utf8_span_to_utf16, OffsetConversionError,
};

static ATOMIC_TMP_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Composite key uniquely identifying an active document buffer session.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct DocumentSessionKey {
    pub document_id: String,
    pub session_generation: u32,
}

impl DocumentSessionKey {
    #[must_use]
    pub fn new(document_id: impl Into<String>, session_generation: u32) -> Self {
        Self {
            document_id: document_id.into(),
            session_generation,
        }
    }
}

/// Validation range tracked on a `DocumentSession` with synchronous `🟢 → 🟠` downgrade on local edit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentValidationRange {
    pub span_utf8: Utf8Span,
    pub span_utf16: Utf16Span,
    pub state: ColorideValidationState,
}

/// Details of an external modification detected on disk outside of Coloride.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalDiskConflict {
    pub document_id: String,
    pub disk_path: PathBuf,
    pub expected_disk_blake3_hash: String,
    pub actual_disk_blake3_hash: String,
}

/// Errors produced by `DocumentSession` and `DocumentService`.
#[derive(Debug, Error)]
pub enum DocumentError {
    #[error("Unsupported contract schema version {actual} (expected {expected})")]
    UnsupportedSchemaVersion { expected: u16, actual: u16 },
    #[error("Document session not found for document_id='{document_id}', generation={session_generation}")]
    SessionNotFound {
        document_id: String,
        session_generation: u32,
    },
    #[error(
        "Stale session generation for document '{document_id}': expected {expected}, got {actual}"
    )]
    StaleSessionGeneration {
        document_id: String,
        expected: u32,
        actual: u32,
    },
    #[error("Revision mismatch for document '{document_id}': expected base_revision {expected}, got {actual}")]
    RevisionMismatch {
        document_id: String,
        expected: u32,
        actual: u32,
    },
    #[error(
        "UTF-8 span mismatch on change: provided {provided:?} does not match computed {computed:?}"
    )]
    Utf8SpanMismatch {
        provided: Utf8Span,
        computed: Utf8Span,
    },
    #[error("Document '{document_id}' does not have an associated disk path")]
    MissingDiskPath { document_id: String },
    #[error("External disk conflict on '{document_id}' at {disk_path}: expected hash {expected_hash}, found {actual_hash}")]
    ExternalDiskConflict {
        document_id: String,
        disk_path: PathBuf,
        expected_hash: String,
        actual_hash: String,
    },
    #[error("Offset conversion error: {0}")]
    Offset(#[from] OffsetConversionError),
    #[error("WAL journal error: {0}")]
    Journal(#[from] JournalError),
    #[error("Editor IPC codec error: {0}")]
    EditorIpc(String),
    #[error("Disk I/O error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// In-flight atomic disk save snapshot capturing the exact revision `T` being flushed to disk.
#[derive(Debug, Clone)]
pub struct PendingDiskSave {
    pub document_id: String,
    pub session_generation: u32,
    pub target_revision: u32,
    pub target_blake3_hash: String,
    pub disk_path: PathBuf,
    pub expected_disk_hash: Option<String>,
    rope_snapshot: Rope,
}

impl PendingDiskSave {
    /// Flush the captured `rope_snapshot` for `target_revision` atomically to disk via a temporary
    /// sibling file + `sync_data()` + atomic `rename`, after checking for external disk conflicts.
    pub fn flush_to_disk(&self) -> Result<String, DocumentError> {
        if let Some(expected_hash) = &self.expected_disk_hash {
            if self.disk_path.exists() {
                let current_disk_hash = compute_file_blake3_hex(&self.disk_path)?;
                if &current_disk_hash != expected_hash {
                    return Err(DocumentError::ExternalDiskConflict {
                        document_id: self.document_id.clone(),
                        disk_path: self.disk_path.clone(),
                        expected_hash: expected_hash.clone(),
                        actual_hash: current_disk_hash,
                    });
                }
            }
        }

        if let Some(parent) = self.disk_path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|source| DocumentError::Io {
                    path: parent.to_path_buf(),
                    source,
                })?;
            }
        }

        let seq = ATOMIC_TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let file_name = self
            .disk_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("document");
        let tmp_name = format!(
            ".{file_name}.coloride-atomic-{}-{seq}.tmp",
            std::process::id()
        );
        let tmp_path = self.disk_path.with_file_name(tmp_name);

        {
            let tmp_file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&tmp_path)
                .map_err(|source| DocumentError::Io {
                    path: tmp_path.clone(),
                    source,
                })?;
            let mut writer = BufWriter::new(tmp_file);
            for chunk in self.rope_snapshot.chunks() {
                writer
                    .write_all(chunk.as_bytes())
                    .map_err(|source| DocumentError::Io {
                        path: tmp_path.clone(),
                        source,
                    })?;
            }
            writer.flush().map_err(|source| DocumentError::Io {
                path: tmp_path.clone(),
                source,
            })?;
            let inner_file = writer.into_inner().map_err(|err| DocumentError::Io {
                path: tmp_path.clone(),
                source: err.into_error(),
            })?;
            inner_file.sync_data().map_err(|source| DocumentError::Io {
                path: tmp_path.clone(),
                source,
            })?;
        }

        std::fs::rename(&tmp_path, &self.disk_path).map_err(|source| DocumentError::Io {
            path: self.disk_path.clone(),
            source,
        })?;

        Ok(self.target_blake3_hash.clone())
    }
}

/// Authoritative in-memory document session backed by `ropey::Rope`.
#[derive(Debug, Clone)]
pub struct DocumentSession {
    document_id: String,
    session_generation: u32,
    disk_path: Option<PathBuf>,
    rope: Rope,
    interactive_revision: u32,
    journaled_revision: u32,
    disk_saved_revision: u32,
    content_blake3_hash: String,
    last_known_disk_hash: Option<String>,
    selection: EditorSelection,
    ime_composing: bool,
    validation_ranges: Vec<DocumentValidationRange>,
}

impl DocumentSession {
    /// Create a new `DocumentSession` from an existing `Rope`.
    #[must_use]
    pub fn from_rope(
        key: DocumentSessionKey,
        disk_path: Option<PathBuf>,
        rope: Rope,
        initial_revision: u32,
        journaled_revision: u32,
        disk_saved_revision: u32,
        last_known_disk_hash: Option<String>,
    ) -> Self {
        let content_blake3_hash = compute_rope_blake3_hex(&rope);
        Self {
            document_id: key.document_id,
            session_generation: key.session_generation,
            disk_path,
            rope,
            interactive_revision: initial_revision,
            journaled_revision,
            disk_saved_revision,
            content_blake3_hash,
            last_known_disk_hash,
            selection: EditorSelection::default(),
            ime_composing: false,
            validation_ranges: Vec::new(),
        }
    }

    #[must_use]
    pub fn document_id(&self) -> &str {
        &self.document_id
    }

    #[must_use]
    pub const fn session_generation(&self) -> u32 {
        self.session_generation
    }

    #[must_use]
    pub fn disk_path(&self) -> Option<&Path> {
        self.disk_path.as_deref()
    }

    #[must_use]
    pub const fn rope(&self) -> &Rope {
        &self.rope
    }

    #[must_use]
    pub fn text(&self) -> String {
        self.rope.to_string()
    }

    #[must_use]
    pub const fn interactive_revision(&self) -> u32 {
        self.interactive_revision
    }

    #[must_use]
    pub const fn journaled_revision(&self) -> u32 {
        self.journaled_revision
    }

    #[must_use]
    pub const fn disk_saved_revision(&self) -> u32 {
        self.disk_saved_revision
    }

    #[must_use]
    pub fn content_blake3_hash(&self) -> &str {
        &self.content_blake3_hash
    }

    #[must_use]
    pub fn last_known_disk_hash(&self) -> Option<&str> {
        self.last_known_disk_hash.as_deref()
    }

    #[must_use]
    pub const fn selection(&self) -> EditorSelection {
        self.selection
    }

    #[must_use]
    pub const fn ime_composing(&self) -> bool {
        self.ime_composing
    }

    #[must_use]
    pub const fn has_unsaved_changes(&self) -> bool {
        self.interactive_revision != self.disk_saved_revision
    }

    #[must_use]
    pub fn validation_ranges(&self) -> &[DocumentValidationRange] {
        &self.validation_ranges
    }

    /// Produce the immutable `EditorSnapshot` contract for this session.
    #[must_use]
    pub fn snapshot(&self) -> EditorSnapshot {
        EditorSnapshot::new(
            self.document_id.clone(),
            self.session_generation,
            self.interactive_revision,
            self.journaled_revision,
            self.disk_saved_revision,
            self.content_blake3_hash.clone(),
        )
    }

    /// Register or replace Coloride validation ranges on this document session.
    pub fn set_validation_ranges(
        &mut self,
        ranges_utf16: Vec<(Utf16Span, ColorideValidationState)>,
    ) -> Result<(), DocumentError> {
        let mut validated = Vec::with_capacity(ranges_utf16.len());
        for (span_utf16, state) in ranges_utf16 {
            let span_utf8 = utf16_span_to_utf8(&self.rope, span_utf16)?;
            validated.push(DocumentValidationRange {
                span_utf8,
                span_utf16,
                state,
            });
        }
        self.validation_ranges = validated;
        Ok(())
    }

    /// Apply an `EditorTransaction` atomically in memory without touching the WAL.
    /// Used internally before WAL persistence and during WAL crash replay.
    pub(crate) fn apply_transaction_in_memory(
        &mut self,
        tx: &EditorTransaction,
    ) -> Result<Vec<TextChange>, DocumentError> {
        if tx.schema_version != CONTRACT_SCHEMA_VERSION {
            return Err(DocumentError::UnsupportedSchemaVersion {
                expected: CONTRACT_SCHEMA_VERSION,
                actual: tx.schema_version,
            });
        }
        if tx.session_generation != self.session_generation {
            return Err(DocumentError::StaleSessionGeneration {
                document_id: self.document_id.clone(),
                expected: self.session_generation,
                actual: tx.session_generation,
            });
        }
        if tx.base_revision != self.interactive_revision {
            return Err(DocumentError::RevisionMismatch {
                document_id: self.document_id.clone(),
                expected: self.interactive_revision,
                actual: tx.base_revision,
            });
        }

        // Clone the Rope (O(1) Arc tree clone) so that if any change in the batch is invalid,
        // the session remains completely untouched.
        let mut staged_rope = self.rope.clone();
        let mut staged_ranges = self.validation_ranges.clone();
        let mut normalized_changes = Vec::with_capacity(tx.changes.len());
        let is_local_user_edit = matches!(tx.origin, TransactionOrigin::User);

        for change in &tx.changes {
            let computed_utf8 = utf16_span_to_utf8(&staged_rope, change.range_utf16)?;
            if let Some(provided_utf8) = change.range_utf8 {
                if provided_utf8 != computed_utf8 {
                    return Err(DocumentError::Utf8SpanMismatch {
                        provided: provided_utf8,
                        computed: computed_utf8,
                    });
                }
            }

            let start_char = utf16_to_char_idx(&staged_rope, change.range_utf16.start)?;
            let end_char = utf16_to_char_idx(&staged_rope, change.range_utf16.end)?;

            staged_rope.remove(start_char..end_char);
            if !change.inserted_text.is_empty() {
                staged_rope.insert(start_char, &change.inserted_text);
            }

            let inserted_utf8_len = change.inserted_text.len() as u32;
            update_validation_ranges_after_edit(
                &staged_rope,
                &mut staged_ranges,
                computed_utf8,
                inserted_utf8_len,
                is_local_user_edit,
            )?;

            normalized_changes.push(TextChange {
                range_utf16: change.range_utf16,
                range_utf8: Some(computed_utf8),
                inserted_text: change.inserted_text.clone(),
            });
        }

        // Validate the updated selection offsets against the new Rope state.
        let _ = utf16_to_char_idx(&staged_rope, tx.selection.anchor)?;
        let _ = utf16_to_char_idx(&staged_rope, tx.selection.head)?;
        let computed_cursor = utf16_to_line_col(&staged_rope, tx.selection.head)?;

        self.rope = staged_rope;
        self.validation_ranges = staged_ranges;
        self.interactive_revision = self.interactive_revision.saturating_add(1);
        self.content_blake3_hash = compute_rope_blake3_hex(&self.rope);
        self.selection = EditorSelection {
            anchor: tx.selection.anchor,
            head: tx.selection.head,
            cursor_line_col: Some(tx.selection.cursor_line_col.unwrap_or(computed_cursor)),
        };
        self.ime_composing = tx.ime_composing;

        Ok(normalized_changes)
    }
}

fn update_validation_ranges_after_edit(
    updated_rope: &Rope,
    ranges: &mut [DocumentValidationRange],
    edited_span_utf8: Utf8Span,
    inserted_utf8_len: u32,
    is_local_user_edit: bool,
) -> Result<(), OffsetConversionError> {
    let old_start = edited_span_utf8.start.as_u32();
    let old_end = edited_span_utf8.end.as_u32();
    let removed_len = old_end.saturating_sub(old_start);
    let new_end = old_start.saturating_add(inserted_utf8_len);

    for range in ranges.iter_mut() {
        let r_start = range.span_utf8.start.as_u32();
        let r_end = range.span_utf8.end.as_u32();

        // Check if the edit falls strictly after the range.
        if old_start >= r_end {
            // Pure insertion at the exact end boundary of a range does not touch characters inside [r_start, r_end).
            continue;
        }

        // Check if the edit falls strictly before the range.
        if old_end <= r_start && (old_start < r_start || (old_start == r_start && removed_len == 0))
        {
            let shift = |pos: u32| -> u32 {
                pos.saturating_sub(removed_len)
                    .saturating_add(inserted_utf8_len)
            };
            let updated_span_utf8 = Utf8Span::new(
                Utf8ByteOffset::new(shift(r_start)),
                Utf8ByteOffset::new(shift(r_end)),
            );
            range.span_utf8 = updated_span_utf8;
            range.span_utf16 = utf8_span_to_utf16(updated_rope, updated_span_utf8)?;
            continue;
        }

        // Otherwise, the edit touches or overlaps characters inside `[r_start, r_end)`.
        if is_local_user_edit {
            range.state = range.state.on_local_edit();
        }

        let new_r_start = if old_start <= r_start {
            new_end.min(old_start)
        } else {
            r_start
        };
        let new_r_end = if old_end >= r_end {
            new_end
        } else {
            r_end
                .saturating_sub(removed_len)
                .saturating_add(inserted_utf8_len)
        };
        let clamped_end = new_r_end.max(new_r_start);
        let updated_span_utf8 = Utf8Span::new(
            Utf8ByteOffset::new(new_r_start),
            Utf8ByteOffset::new(clamped_end),
        );
        range.span_utf8 = updated_span_utf8;
        range.span_utf16 = utf8_span_to_utf16(updated_rope, updated_span_utf8)?;
    }

    Ok(())
}

/// Compute the lowercase hex `blake3` hash of a file on disk using streaming reads.
pub fn compute_file_blake3_hex(path: &Path) -> Result<String, DocumentError> {
    let file = File::open(path).map_err(|source| DocumentError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let mut reader = BufReader::new(file);
    let mut hasher = blake3::Hasher::new();
    std::io::copy(&mut reader, &mut hasher).map_err(|source| DocumentError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    Ok(hasher.finalize().to_hex().to_string())
}

/// Single persistence authority for workspace documents in `crates/host-core` (`LOT-003`).
#[derive(Debug)]
pub struct DocumentService {
    sessions: BTreeMap<DocumentSessionKey, DocumentSession>,
    latest_generation_by_doc: BTreeMap<String, u32>,
    journal: Option<WriteAheadJournal>,
}

impl DocumentService {
    /// Create an in-memory `DocumentService` backed by a durable `WriteAheadJournal` at `journal_path`.
    pub fn with_journal(journal_path: impl Into<PathBuf>) -> Result<Self, DocumentError> {
        let journal = WriteAheadJournal::open(journal_path)?;
        Ok(Self {
            sessions: BTreeMap::new(),
            latest_generation_by_doc: BTreeMap::new(),
            journal: Some(journal),
        })
    }

    /// Create an in-memory `DocumentService` without a disk journal (for pure in-memory unit tests).
    #[must_use]
    pub fn new_in_memory() -> Self {
        Self {
            sessions: BTreeMap::new(),
            latest_generation_by_doc: BTreeMap::new(),
            journal: None,
        }
    }

    /// Open a document session from an in-memory string and persist its initial state to the WAL.
    pub fn open_document_from_str(
        &mut self,
        document_id: impl Into<String>,
        session_generation: u32,
        disk_path: Option<PathBuf>,
        initial_text: &str,
    ) -> Result<EditorSnapshot, DocumentError> {
        let document_id = document_id.into();
        let rope = Rope::from_str(initial_text);
        let initial_revision = 0;
        let disk_saved_revision = 0;
        let content_blake3_hash = compute_rope_blake3_hex(&rope);
        let last_known_disk_hash = if disk_path.is_some() {
            Some(content_blake3_hash.clone())
        } else {
            None
        };

        if let Some(journal) = &mut self.journal {
            journal.append_and_sync(JournalRecord::DocumentOpened {
                document_id: document_id.clone(),
                session_generation,
                disk_path: disk_path.clone(),
                initial_revision,
                disk_saved_revision,
                initial_text: initial_text.to_string(),
                content_blake3_hash: content_blake3_hash.clone(),
                last_known_disk_hash: last_known_disk_hash.clone(),
            })?;
        }

        let session = DocumentSession {
            document_id: document_id.clone(),
            session_generation,
            disk_path,
            rope,
            interactive_revision: initial_revision,
            journaled_revision: initial_revision,
            disk_saved_revision,
            content_blake3_hash,
            last_known_disk_hash,
            selection: EditorSelection::default(),
            ime_composing: false,
            validation_ranges: Vec::new(),
        };
        let snapshot = session.snapshot();
        self.latest_generation_by_doc
            .insert(document_id.clone(), session_generation);
        self.sessions.insert(
            DocumentSessionKey::new(document_id, session_generation),
            session,
        );
        Ok(snapshot)
    }

    /// Open a local file from disk into a `ropey::Rope` (`p95 <= 50 ms` for 1 MB).
    pub fn open_document_from_disk(
        &mut self,
        document_id: impl Into<String>,
        session_generation: u32,
        disk_path: impl Into<PathBuf>,
    ) -> Result<EditorSnapshot, DocumentError> {
        let document_id = document_id.into();
        let disk_path = disk_path.into();
        let initial_text =
            std::fs::read_to_string(&disk_path).map_err(|source| DocumentError::Io {
                path: disk_path.clone(),
                source,
            })?;
        let content_blake3_hash = blake3::hash(initial_text.as_bytes()).to_hex().to_string();
        let rope = Rope::from_str(&initial_text);

        let initial_revision = 0;
        let disk_saved_revision = 0;
        let last_known_disk_hash = Some(content_blake3_hash.clone());

        if let Some(journal) = &mut self.journal {
            journal.append_and_sync(JournalRecord::DocumentOpened {
                document_id: document_id.clone(),
                session_generation,
                disk_path: Some(disk_path.clone()),
                initial_revision,
                disk_saved_revision,
                initial_text,
                content_blake3_hash: content_blake3_hash.clone(),
                last_known_disk_hash: last_known_disk_hash.clone(),
            })?;
        }

        let session = DocumentSession {
            document_id: document_id.clone(),
            session_generation,
            disk_path: Some(disk_path),
            rope,
            interactive_revision: initial_revision,
            journaled_revision: initial_revision,
            disk_saved_revision,
            content_blake3_hash,
            last_known_disk_hash,
            selection: EditorSelection::default(),
            ime_composing: false,
            validation_ranges: Vec::new(),
        };
        let snapshot = session.snapshot();
        self.latest_generation_by_doc
            .insert(document_id.clone(), session_generation);
        self.sessions.insert(
            DocumentSessionKey::new(document_id, session_generation),
            session,
        );
        Ok(snapshot)
    }

    /// Retrieve an immutable reference to a `DocumentSession` by `(document_id, session_generation)`.
    pub fn session(
        &self,
        document_id: &str,
        session_generation: u32,
    ) -> Result<&DocumentSession, DocumentError> {
        let key = DocumentSessionKey::new(document_id, session_generation);
        if let Some(session) = self.sessions.get(&key) {
            return Ok(session);
        }
        if let Some(&expected) = self.latest_generation_by_doc.get(document_id) {
            if expected != session_generation {
                return Err(DocumentError::StaleSessionGeneration {
                    document_id: document_id.to_string(),
                    expected,
                    actual: session_generation,
                });
            }
        }
        Err(DocumentError::SessionNotFound {
            document_id: document_id.to_string(),
            session_generation,
        })
    }

    /// Retrieve a mutable reference to a `DocumentSession` by `(document_id, session_generation)`.
    pub fn session_mut(
        &mut self,
        document_id: &str,
        session_generation: u32,
    ) -> Result<&mut DocumentSession, DocumentError> {
        let key = DocumentSessionKey::new(document_id, session_generation);
        if self.sessions.contains_key(&key) {
            return Ok(self.sessions.get_mut(&key).expect("checked contains_key"));
        }
        if let Some(&expected) = self.latest_generation_by_doc.get(document_id) {
            if expected != session_generation {
                return Err(DocumentError::StaleSessionGeneration {
                    document_id: document_id.to_string(),
                    expected,
                    actual: session_generation,
                });
            }
        }
        Err(DocumentError::SessionNotFound {
            document_id: document_id.to_string(),
            session_generation,
        })
    }

    /// Return all active sessions in deterministic order.
    pub fn sessions(&self) -> impl Iterator<Item = &DocumentSession> {
        self.sessions.values()
    }

    /// Apply an `EditorTransaction` atomically, durably append and `fsync` to `WriteAheadJournal`
    /// prior to acknowledgment, and emit the updated `EditorSnapshot`.
    pub fn apply_transaction(
        &mut self,
        tx: EditorTransaction,
    ) -> Result<EditorSnapshot, DocumentError> {
        self.apply_transaction_internal(tx, true)
    }

    /// Apply an `EditorTransaction` atomically and write to the WAL stream without an immediate `fsync`
    /// (group-commit mode: `interactive_revision` advances immediately while `journaled_revision`
    /// updates on `flush_journal()`).
    pub fn apply_transaction_unflushed(
        &mut self,
        tx: EditorTransaction,
    ) -> Result<EditorSnapshot, DocumentError> {
        self.apply_transaction_internal(tx, false)
    }

    fn apply_transaction_internal(
        &mut self,
        tx: EditorTransaction,
        sync_immediately: bool,
    ) -> Result<EditorSnapshot, DocumentError> {
        let (normalized_changes, resulting_revision, content_hash) = {
            let session = self.session_mut(&tx.document_id, tx.session_generation)?;
            let normalized = session.apply_transaction_in_memory(&tx)?;
            (
                normalized,
                session.interactive_revision(),
                session.content_blake3_hash().to_string(),
            )
        };

        let mut persisted_tx = tx.clone();
        persisted_tx.changes = normalized_changes;

        if let Some(journal) = &mut self.journal {
            let record = JournalRecord::TransactionApplied {
                transaction: persisted_tx,
                resulting_revision,
                content_blake3_hash: content_hash,
            };
            if sync_immediately {
                journal.append_and_sync(record)?;
            } else {
                journal.append_unflushed(record)?;
            }
        }

        let mark_journaled = sync_immediately || self.journal.is_none();
        let session = self.session_mut(&tx.document_id, tx.session_generation)?;
        if mark_journaled {
            session.journaled_revision = session.interactive_revision;
        }
        Ok(session.snapshot())
    }

    /// Flush and `sync_data()` all group-committed WAL entries, advancing `journaled_revision`
    /// to `interactive_revision` on all sessions.
    pub fn flush_journal(&mut self) -> Result<Vec<EditorSnapshot>, DocumentError> {
        if let Some(journal) = &mut self.journal {
            journal.sync()?;
        }
        let mut snapshots = Vec::with_capacity(self.sessions.len());
        for session in self.sessions.values_mut() {
            session.journaled_revision = session.interactive_revision;
            snapshots.push(session.snapshot());
        }
        Ok(snapshots)
    }

    /// Check whether the file on disk has been modified externally since the document was opened or last saved.
    pub fn detect_external_disk_conflict(
        &self,
        document_id: &str,
        session_generation: u32,
    ) -> Result<Option<ExternalDiskConflict>, DocumentError> {
        let session = self.session(document_id, session_generation)?;
        let disk_path =
            session
                .disk_path
                .as_ref()
                .ok_or_else(|| DocumentError::MissingDiskPath {
                    document_id: document_id.to_string(),
                })?;

        let Some(expected_hash) = &session.last_known_disk_hash else {
            return Ok(None);
        };
        if !disk_path.exists() {
            return Ok(None);
        }

        let actual_hash = compute_file_blake3_hex(disk_path)?;
        if &actual_hash != expected_hash {
            return Ok(Some(ExternalDiskConflict {
                document_id: document_id.to_string(),
                disk_path: disk_path.clone(),
                expected_disk_blake3_hash: expected_hash.clone(),
                actual_disk_blake3_hash: actual_hash,
            }));
        }
        Ok(None)
    }

    /// Begin an atomic disk save for the current `interactive_revision` (`T`).
    /// If any un-synced WAL entries exist, flushes the journal first so the WAL is always ahead of disk.
    pub fn begin_atomic_save(
        &mut self,
        document_id: &str,
        session_generation: u32,
    ) -> Result<PendingDiskSave, DocumentError> {
        if let Some(journal) = &mut self.journal {
            if journal.unflushed_entries() > 0 {
                journal.sync()?;
                for session in self.sessions.values_mut() {
                    session.journaled_revision = session.interactive_revision;
                }
            }
        }

        let session = self.session(document_id, session_generation)?;
        let disk_path =
            session
                .disk_path
                .clone()
                .ok_or_else(|| DocumentError::MissingDiskPath {
                    document_id: document_id.to_string(),
                })?;

        Ok(PendingDiskSave {
            document_id: session.document_id.clone(),
            session_generation: session.session_generation,
            target_revision: session.interactive_revision,
            target_blake3_hash: session.content_blake3_hash.clone(),
            disk_path,
            expected_disk_hash: session.last_known_disk_hash.clone(),
            rope_snapshot: session.rope.clone(),
        })
    }

    /// Complete an in-flight `PendingDiskSave` after `pending.flush_to_disk()` has succeeded.
    ///
    /// Enforces the LOT-003 save invariant:
    /// `disk_saved_revision` updates **only** to `pending.target_revision` (`T`).
    /// If transaction `T+1` arrived while `T` was being flushed to disk,
    /// `interactive_revision` is `T+1`, so `has_unsaved_changes` remains `true`.
    pub fn complete_atomic_save(
        &mut self,
        pending: &PendingDiskSave,
    ) -> Result<EditorSnapshot, DocumentError> {
        // Verify the session exists before writing the WAL completion marker.
        let _ = self.session(&pending.document_id, pending.session_generation)?;

        if let Some(journal) = &mut self.journal {
            journal.append_and_sync(JournalRecord::DiskSaved {
                document_id: pending.document_id.clone(),
                session_generation: pending.session_generation,
                disk_saved_revision: pending.target_revision,
                disk_blake3_hash: pending.target_blake3_hash.clone(),
            })?;
        }

        let session = self.session_mut(&pending.document_id, pending.session_generation)?;
        if pending.target_revision > session.disk_saved_revision {
            session.disk_saved_revision = pending.target_revision;
        }
        session.last_known_disk_hash = Some(pending.target_blake3_hash.clone());
        Ok(session.snapshot())
    }

    /// Perform a complete atomic disk save (`begin_atomic_save` → `flush_to_disk` → `complete_atomic_save`).
    pub fn save_document_atomic(
        &mut self,
        document_id: &str,
        session_generation: u32,
    ) -> Result<EditorSnapshot, DocumentError> {
        let pending = self.begin_atomic_save(document_id, session_generation)?;
        pending.flush_to_disk()?;
        self.complete_atomic_save(&pending)
    }
}

/// Recover all document sessions and their latest journaled revisions from a `WriteAheadJournal` file
/// after a WebView or Rust Host crash (`LOT-003`).
pub fn recover_workspace_from_journal(
    journal_path: impl AsRef<Path>,
) -> Result<DocumentService, DocumentError> {
    let journal_path = journal_path.as_ref().to_path_buf();
    let replay = WriteAheadJournal::read_and_repair(&journal_path)?;

    let mut sessions: BTreeMap<DocumentSessionKey, DocumentSession> = BTreeMap::new();
    let mut latest_generation_by_doc: BTreeMap<String, u32> = BTreeMap::new();

    for entry in replay.entries {
        match entry.record {
            JournalRecord::DocumentOpened {
                document_id,
                session_generation,
                disk_path,
                initial_revision,
                disk_saved_revision,
                initial_text,
                content_blake3_hash,
                last_known_disk_hash,
            } => {
                let rope = Rope::from_str(&initial_text);
                let session = DocumentSession {
                    document_id: document_id.clone(),
                    session_generation,
                    disk_path,
                    rope,
                    interactive_revision: initial_revision,
                    journaled_revision: initial_revision,
                    disk_saved_revision,
                    content_blake3_hash,
                    last_known_disk_hash,
                    selection: EditorSelection::default(),
                    ime_composing: false,
                    validation_ranges: Vec::new(),
                };
                latest_generation_by_doc.insert(document_id.clone(), session_generation);
                sessions.insert(
                    DocumentSessionKey::new(document_id, session_generation),
                    session,
                );
            }
            JournalRecord::TransactionApplied {
                transaction,
                resulting_revision,
                content_blake3_hash,
            } => {
                let key = DocumentSessionKey::new(
                    transaction.document_id.clone(),
                    transaction.session_generation,
                );
                if let Some(session) = sessions.get_mut(&key) {
                    session.apply_transaction_in_memory(&transaction)?;
                    debug_assert_eq!(session.interactive_revision, resulting_revision);
                    debug_assert_eq!(session.content_blake3_hash, content_blake3_hash);
                    session.journaled_revision = session.interactive_revision;
                }
            }
            JournalRecord::DiskSaved {
                document_id,
                session_generation,
                disk_saved_revision,
                disk_blake3_hash,
            } => {
                let key = DocumentSessionKey::new(document_id, session_generation);
                if let Some(session) = sessions.get_mut(&key) {
                    if disk_saved_revision > session.disk_saved_revision {
                        session.disk_saved_revision = disk_saved_revision;
                    }
                    session.last_known_disk_hash = Some(disk_blake3_hash);
                }
            }
            JournalRecord::DocumentClosed {
                document_id,
                session_generation,
            } => {
                let key = DocumentSessionKey::new(document_id, session_generation);
                sessions.remove(&key);
            }
        }
    }

    // Reconcile against actual disk state: if an atomic file rename completed right before
    // the crash (before the `DiskSaved` WAL record could be appended), keep `disk_saved_revision`
    // accurate or preserve `has_unsaved_changes = true` whenever `interactive_revision != disk_saved_revision`.
    let journal = WriteAheadJournal::open(journal_path)?;
    Ok(DocumentService {
        sessions,
        latest_generation_by_doc,
        journal: Some(journal),
    })
}
