//! The document service: opening, editing, journaling and saving every session.

use super::*;

/// Single persistence authority for workspace documents in `crates/host-core` (`LOT-003`).
#[derive(Debug)]
pub struct DocumentService {
    pub(super) sessions: BTreeMap<DocumentSessionKey, DocumentSession>,
    pub(super) latest_generation_by_doc: BTreeMap<String, u32>,
    pub(super) journal: Option<WriteAheadJournal>,
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
