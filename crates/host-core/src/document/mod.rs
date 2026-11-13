//! Authoritative document text: `ropey` ropes backed by a write-ahead journal (AGENTS.md rule 2).
//!
//! One submodule per concern, re-exported here so public paths do not depend on the split.

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

/// `disk_saved_revision` of a buffer whose text was never on disk (opened with unsaved edits):
/// no interactive revision ever equals it, so the session reports unsaved changes until a save.
pub const NEVER_SAVED_REVISION: u32 = u32::MAX;

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

mod recovery;
mod save;
mod service;
mod session;

pub use recovery::*;
pub use save::*;
pub use service::*;
pub use session::*;
