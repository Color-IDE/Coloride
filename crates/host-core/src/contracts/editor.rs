//! Contracts #1 and #2: `EditorTransaction`, `EditorSnapshot` and their compact binary IPC format.

use super::*;

const EDITOR_TX_MAGIC: u32 = 0x434c_5458;
const EDITOR_SNAPSHOT_MAGIC: u32 = 0x434c_534e;

struct EditorIpcReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> EditorIpcReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], ContractCodecError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or_else(|| ContractCodecError::EditorIpc("payload length overflow".into()))?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or_else(|| ContractCodecError::EditorIpc("truncated payload".into()))?;
        self.offset = end;
        Ok(value)
    }

    fn u8(&mut self) -> Result<u8, ContractCodecError> {
        Ok(self.take(1)?[0])
    }

    fn bool(&mut self) -> Result<bool, ContractCodecError> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            value => Err(ContractCodecError::EditorIpc(format!(
                "invalid boolean tag {value}"
            ))),
        }
    }

    fn u16(&mut self) -> Result<u16, ContractCodecError> {
        Ok(u16::from_le_bytes(
            self.take(2)?.try_into().expect("two bytes"),
        ))
    }

    fn u32(&mut self) -> Result<u32, ContractCodecError> {
        Ok(u32::from_le_bytes(
            self.take(4)?.try_into().expect("four bytes"),
        ))
    }

    fn string(&mut self) -> Result<String, ContractCodecError> {
        let length = usize::try_from(self.u32()?)
            .map_err(|_| ContractCodecError::EditorIpc("string length overflow".into()))?;
        String::from_utf8(self.take(length)?.to_vec())
            .map_err(|_| ContractCodecError::EditorIpc("string is not valid UTF-8".into()))
    }

    fn finish(self) -> Result<(), ContractCodecError> {
        if self.offset == self.bytes.len() {
            Ok(())
        } else {
            Err(ContractCodecError::EditorIpc(
                "trailing payload bytes".into(),
            ))
        }
    }
}

fn push_string(output: &mut Vec<u8>, value: &str) -> Result<(), ContractCodecError> {
    let length = u32::try_from(value.len())
        .map_err(|_| ContractCodecError::EditorIpc("string exceeds u32 length".into()))?;
    output.extend_from_slice(&length.to_le_bytes());
    output.extend_from_slice(value.as_bytes());
    Ok(())
}

// ============================================================================
// 3. Contract #1 — EditorTransaction
// ============================================================================

/// Origin of an editor transaction for isolated undo/redo and auditability.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum TransactionOrigin {
    User,
    Agent { task_id: String },
    Peer { peer_id: String },
    Extension { extension_id: String },
}

/// Atomic text replacement inside an `EditorTransaction`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct TextChange {
    pub range_utf16: Utf16Span,
    pub range_utf8: Option<Utf8Span>,
    pub inserted_text: String,
}

/// Editor cursor and selection state expressed in UTF-16 code units.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub struct EditorSelection {
    pub anchor: Utf16CodeUnitOffset,
    pub head: Utf16CodeUnitOffset,
    pub cursor_line_col: Option<LineCol>,
}

/// Contract #1: Versioned delta transaction exchanged between CodeMirror 6 and the Rust Host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct EditorTransaction {
    pub schema_version: u16,
    pub document_id: String,
    pub session_generation: u32,
    pub base_revision: u32,
    pub op_id: String,
    pub changes: Vec<TextChange>,
    pub selection: EditorSelection,
    pub origin: TransactionOrigin,
    pub ime_composing: bool,
}

// ============================================================================
// 4. Contract #2 — EditorSnapshot
// ============================================================================

/// Contract #2: Immutable snapshot state of a document managed by `host-core`.
/// Strictly separates `interactive_revision`, `journaled_revision`, and `disk_saved_revision`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct EditorSnapshot {
    pub schema_version: u16,
    pub document_id: String,
    pub session_generation: u32,
    pub interactive_revision: u32,
    pub journaled_revision: u32,
    pub disk_saved_revision: u32,
    pub content_blake3_hash: String,
    pub has_unsaved_changes: bool,
}

impl EditorSnapshot {
    #[must_use]
    pub fn new(
        document_id: impl Into<String>,
        session_generation: u32,
        interactive_revision: u32,
        journaled_revision: u32,
        disk_saved_revision: u32,
        content_blake3_hash: impl Into<String>,
    ) -> Self {
        Self {
            schema_version: CONTRACT_SCHEMA_VERSION,
            document_id: document_id.into(),
            session_generation,
            interactive_revision,
            journaled_revision,
            disk_saved_revision,
            content_blake3_hash: content_blake3_hash.into(),
            has_unsaved_changes: interactive_revision != disk_saved_revision,
        }
    }

    #[must_use]
    pub const fn is_fully_journaled(&self) -> bool {
        self.journaled_revision >= self.interactive_revision
    }

    #[must_use]
    pub const fn is_disk_saved(&self) -> bool {
        !self.has_unsaved_changes && self.interactive_revision == self.disk_saved_revision
    }
}

/// Decode the compact little-endian editor transaction format used by `@coloride/editor-cm6`.
pub fn decode_editor_transaction_ipc(
    bytes: &[u8],
) -> Result<EditorTransaction, ContractCodecError> {
    let mut reader = EditorIpcReader::new(bytes);
    if reader.u32()? != EDITOR_TX_MAGIC {
        return Err(ContractCodecError::EditorIpc(
            "invalid EditorTransaction magic".into(),
        ));
    }
    let schema_version = reader.u16()?;
    if schema_version != CONTRACT_SCHEMA_VERSION {
        return Err(ContractCodecError::EditorIpc(format!(
            "unsupported schema version {schema_version}"
        )));
    }
    let document_id = reader.string()?;
    let session_generation = reader.u32()?;
    let base_revision = reader.u32()?;
    let op_id = reader.string()?;
    let change_count = usize::try_from(reader.u32()?)
        .map_err(|_| ContractCodecError::EditorIpc("change count overflow".into()))?;
    if change_count > 100_000 {
        return Err(ContractCodecError::EditorIpc(
            "change count exceeds safety limit".into(),
        ));
    }
    let mut changes = Vec::with_capacity(change_count);
    for _ in 0..change_count {
        let range_utf16 = Utf16Span::new(
            Utf16CodeUnitOffset::new(reader.u32()?),
            Utf16CodeUnitOffset::new(reader.u32()?),
        );
        let range_utf8 = if reader.bool()? {
            Some(Utf8Span::new(
                Utf8ByteOffset::new(reader.u32()?),
                Utf8ByteOffset::new(reader.u32()?),
            ))
        } else {
            None
        };
        changes.push(TextChange {
            range_utf16,
            range_utf8,
            inserted_text: reader.string()?,
        });
    }
    let anchor = Utf16CodeUnitOffset::new(reader.u32()?);
    let head = Utf16CodeUnitOffset::new(reader.u32()?);
    let cursor_line_col = if reader.bool()? {
        Some(LineCol::new(reader.u32()?, reader.u32()?))
    } else {
        None
    };
    let origin = match reader.u8()? {
        0 => TransactionOrigin::User,
        1 => TransactionOrigin::Agent {
            task_id: reader.string()?,
        },
        2 => TransactionOrigin::Peer {
            peer_id: reader.string()?,
        },
        3 => TransactionOrigin::Extension {
            extension_id: reader.string()?,
        },
        tag => {
            return Err(ContractCodecError::EditorIpc(format!(
                "invalid transaction origin tag {tag}"
            )))
        }
    };
    let ime_composing = reader.bool()?;
    reader.finish()?;
    Ok(EditorTransaction {
        schema_version,
        document_id,
        session_generation,
        base_revision,
        op_id,
        changes,
        selection: EditorSelection {
            anchor,
            head,
            cursor_line_col,
        },
        origin,
        ime_composing,
    })
}

/// Encode the compact little-endian editor transaction format used by `@coloride/editor-cm6`.
pub fn encode_editor_transaction_ipc(
    transaction: &EditorTransaction,
) -> Result<Vec<u8>, ContractCodecError> {
    let mut output = Vec::with_capacity(128);
    output.extend_from_slice(&EDITOR_TX_MAGIC.to_le_bytes());
    output.extend_from_slice(&transaction.schema_version.to_le_bytes());
    push_string(&mut output, &transaction.document_id)?;
    output.extend_from_slice(&transaction.session_generation.to_le_bytes());
    output.extend_from_slice(&transaction.base_revision.to_le_bytes());
    push_string(&mut output, &transaction.op_id)?;
    let change_count = u32::try_from(transaction.changes.len())
        .map_err(|_| ContractCodecError::EditorIpc("change count exceeds u32".into()))?;
    output.extend_from_slice(&change_count.to_le_bytes());
    for change in &transaction.changes {
        output.extend_from_slice(&change.range_utf16.start.as_u32().to_le_bytes());
        output.extend_from_slice(&change.range_utf16.end.as_u32().to_le_bytes());
        match change.range_utf8 {
            Some(range) => {
                output.push(1);
                output.extend_from_slice(&range.start.as_u32().to_le_bytes());
                output.extend_from_slice(&range.end.as_u32().to_le_bytes());
            }
            None => output.push(0),
        }
        push_string(&mut output, &change.inserted_text)?;
    }
    output.extend_from_slice(&transaction.selection.anchor.as_u32().to_le_bytes());
    output.extend_from_slice(&transaction.selection.head.as_u32().to_le_bytes());
    match transaction.selection.cursor_line_col {
        Some(position) => {
            output.push(1);
            output.extend_from_slice(&position.line.to_le_bytes());
            output.extend_from_slice(&position.col_utf16.to_le_bytes());
        }
        None => output.push(0),
    }
    match &transaction.origin {
        TransactionOrigin::User => output.push(0),
        TransactionOrigin::Agent { task_id } => {
            output.push(1);
            push_string(&mut output, task_id)?;
        }
        TransactionOrigin::Peer { peer_id } => {
            output.push(2);
            push_string(&mut output, peer_id)?;
        }
        TransactionOrigin::Extension { extension_id } => {
            output.push(3);
            push_string(&mut output, extension_id)?;
        }
    }
    output.push(u8::from(transaction.ime_composing));
    Ok(output)
}

/// Encode the compact little-endian editor snapshot format used by `@coloride/editor-cm6`.
pub fn encode_editor_snapshot_ipc(
    snapshot: &EditorSnapshot,
) -> Result<Vec<u8>, ContractCodecError> {
    let mut output = Vec::with_capacity(64 + snapshot.document_id.len());
    output.extend_from_slice(&EDITOR_SNAPSHOT_MAGIC.to_le_bytes());
    output.extend_from_slice(&snapshot.schema_version.to_le_bytes());
    push_string(&mut output, &snapshot.document_id)?;
    output.extend_from_slice(&snapshot.session_generation.to_le_bytes());
    output.extend_from_slice(&snapshot.interactive_revision.to_le_bytes());
    output.extend_from_slice(&snapshot.journaled_revision.to_le_bytes());
    output.extend_from_slice(&snapshot.disk_saved_revision.to_le_bytes());
    push_string(&mut output, &snapshot.content_blake3_hash)?;
    output.push(u8::from(snapshot.has_unsaved_changes));
    Ok(output)
}
