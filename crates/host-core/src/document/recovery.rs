//! Rebuilding the workspace from the write-ahead journal after a crash.

use super::*;

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
                    session.record_disk_save(disk_saved_revision);
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
