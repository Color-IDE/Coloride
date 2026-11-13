//! One open document: the `ropey` rope, its revisions and its validation ranges.

use super::*;

/// Authoritative in-memory document session backed by `ropey::Rope`.
#[derive(Debug, Clone)]
pub struct DocumentSession {
    pub(super) document_id: String,
    pub(super) session_generation: u32,
    pub(super) disk_path: Option<PathBuf>,
    pub(super) rope: Rope,
    pub(super) interactive_revision: u32,
    pub(super) journaled_revision: u32,
    pub(super) disk_saved_revision: u32,
    pub(super) content_blake3_hash: String,
    pub(super) last_known_disk_hash: Option<String>,
    pub(super) selection: EditorSelection,
    pub(super) ime_composing: bool,
    pub(super) validation_ranges: Vec<DocumentValidationRange>,
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

    /// Record that `revision` reached the disk. Saves only move forward, except from
    /// `NEVER_SAVED_REVISION`, which any real save replaces.
    pub(super) fn record_disk_save(&mut self, revision: u32) {
        if self.disk_saved_revision == NEVER_SAVED_REVISION || revision > self.disk_saved_revision {
            self.disk_saved_revision = revision;
        }
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
