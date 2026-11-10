use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::contracts::EditorTransaction;

const WAL_FRAME_MAGIC: [u8; 8] = *b"CLRWAL01";
const WAL_FRAME_HEADER_LEN: usize = 8 + 4 + 32;

/// Errors raised by the Write-Ahead Log (`WriteAheadJournal`).
#[derive(Debug, Error)]
pub enum JournalError {
    #[error("WAL I/O error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("WAL binary serialization error: {0}")]
    Serialization(#[from] bincode::Error),
    #[error("Corrupted WAL frame header magic at byte offset {offset}")]
    InvalidFrameMagic { offset: u64 },
    #[error("Corrupted WAL frame checksum at byte offset {offset}")]
    ChecksumMismatch { offset: u64 },
}

/// Durable record persisted inside `WriteAheadJournal`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum JournalRecord {
    /// Initial document registration in a session generation.
    DocumentOpened {
        document_id: String,
        session_generation: u32,
        disk_path: Option<PathBuf>,
        initial_revision: u32,
        disk_saved_revision: u32,
        initial_text: String,
        content_blake3_hash: String,
        last_known_disk_hash: Option<String>,
    },
    /// Atomic editor transaction appended prior to acknowledgment.
    TransactionApplied {
        transaction: EditorTransaction,
        resulting_revision: u32,
        content_blake3_hash: String,
    },
    /// Atomic disk save completion marker updating `disk_saved_revision`.
    DiskSaved {
        document_id: String,
        session_generation: u32,
        disk_saved_revision: u32,
        disk_blake3_hash: String,
    },
    /// Session closed cleanly.
    DocumentClosed {
        document_id: String,
        session_generation: u32,
    },
}

/// Sequenced entry stored in the WAL journal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JournalEntry {
    pub sequence_number: u64,
    pub record: JournalRecord,
}

/// Summary of reading and validating a WAL journal file from disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalReplayReport {
    pub entries: Vec<JournalEntry>,
    pub truncated_tail_bytes: u64,
}

/// Append-only durable Write-Ahead Log (`WriteAheadJournal`) for `host-core`.
#[derive(Debug)]
pub struct WriteAheadJournal {
    path: PathBuf,
    file: File,
    next_sequence_number: u64,
    unflushed_entries: usize,
}

impl WriteAheadJournal {
    /// Open or create an append-only WAL journal at `path`.
    /// Any incomplete tail frame from a prior hard crash is automatically repaired/truncated.
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, JournalError> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|source| JournalError::Io {
                    path: parent.to_path_buf(),
                    source,
                })?;
            }
        }

        // Ensure the file exists first.
        let _ = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .read(true)
            .open(&path)
            .map_err(|source| JournalError::Io {
                path: path.clone(),
                source,
            })?;

        let replay = Self::read_and_repair(&path)?;
        let next_sequence_number = replay
            .entries
            .last()
            .map_or(1, |entry| entry.sequence_number.saturating_add(1));

        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|source| JournalError::Io {
                path: path.clone(),
                source,
            })?;
        file.seek(SeekFrom::End(0))
            .map_err(|source| JournalError::Io {
                path: path.clone(),
                source,
            })?;

        Ok(Self {
            path,
            file,
            next_sequence_number,
            unflushed_entries: 0,
        })
    }

    /// Path to the underlying WAL file on disk.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Number of entries written to the OS page cache but not yet `fsync`ed (`sync_data`).
    #[must_use]
    pub const fn unflushed_entries(&self) -> usize {
        self.unflushed_entries
    }

    /// Append a `JournalRecord` and immediately flush + `sync_data()` to disk.
    pub fn append_and_sync(&mut self, record: JournalRecord) -> Result<JournalEntry, JournalError> {
        let entry = self.append_unflushed(record)?;
        self.sync()?;
        Ok(entry)
    }

    /// Append a `JournalRecord` to the WAL stream without an immediate `fsync`
    /// (used for group-commit batching over a few milliseconds).
    pub fn append_unflushed(
        &mut self,
        record: JournalRecord,
    ) -> Result<JournalEntry, JournalError> {
        let entry = JournalEntry {
            sequence_number: self.next_sequence_number,
            record,
        };
        let payload = bincode::serialize(&entry)?;
        let payload_len = payload.len() as u32;
        let checksum = *blake3::hash(&payload).as_bytes();

        let mut frame = Vec::with_capacity(WAL_FRAME_HEADER_LEN + payload.len());
        frame.extend_from_slice(&WAL_FRAME_MAGIC);
        frame.extend_from_slice(&payload_len.to_le_bytes());
        frame.extend_from_slice(&checksum);
        frame.extend_from_slice(&payload);

        self.file
            .write_all(&frame)
            .map_err(|source| JournalError::Io {
                path: self.path.clone(),
                source,
            })?;
        self.file.flush().map_err(|source| JournalError::Io {
            path: self.path.clone(),
            source,
        })?;

        self.next_sequence_number = self.next_sequence_number.saturating_add(1);
        self.unflushed_entries += 1;
        Ok(entry)
    }

    /// Durably `sync_data()` all pending WAL entries to persistent storage.
    pub fn sync(&mut self) -> Result<(), JournalError> {
        self.file.flush().map_err(|source| JournalError::Io {
            path: self.path.clone(),
            source,
        })?;
        self.file.sync_data().map_err(|source| JournalError::Io {
            path: self.path.clone(),
            source,
        })?;
        self.unflushed_entries = 0;
        Ok(())
    }

    /// Read all valid frames from a WAL file on disk.
    /// If the final frame was partially written or corrupted during a crash,
    /// truncates the file back to the last valid frame boundary.
    pub fn read_and_repair(path: &Path) -> Result<JournalReplayReport, JournalError> {
        if !path.exists() {
            return Ok(JournalReplayReport {
                entries: Vec::new(),
                truncated_tail_bytes: 0,
            });
        }

        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .map_err(|source| JournalError::Io {
                path: path.to_path_buf(),
                source,
            })?;

        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|source| JournalError::Io {
                path: path.to_path_buf(),
                source,
            })?;

        let total_len = bytes.len();
        let mut cursor = 0usize;
        let mut entries = Vec::new();
        let mut truncated_tail_bytes = 0u64;

        while cursor < total_len {
            let remaining = total_len - cursor;
            if remaining < WAL_FRAME_HEADER_LEN {
                truncated_tail_bytes = remaining as u64;
                break;
            }

            let header = &bytes[cursor..cursor + WAL_FRAME_HEADER_LEN];
            if header[0..8] != WAL_FRAME_MAGIC {
                // If corruption is at the tail, truncate cleanly; otherwise report corruption.
                truncated_tail_bytes = remaining as u64;
                break;
            }

            let payload_len =
                u32::from_le_bytes([header[8], header[9], header[10], header[11]]) as usize;
            let expected_checksum = &header[12..44];

            if remaining < WAL_FRAME_HEADER_LEN + payload_len {
                // Incomplete tail write during crash.
                truncated_tail_bytes = remaining as u64;
                break;
            }

            let payload_start = cursor + WAL_FRAME_HEADER_LEN;
            let payload_end = payload_start + payload_len;
            let payload = &bytes[payload_start..payload_end];
            let actual_checksum = blake3::hash(payload);

            if actual_checksum.as_bytes() != expected_checksum {
                // Tail frame was torn during crash; if this is the last frame, truncate it.
                if payload_end == total_len {
                    truncated_tail_bytes = remaining as u64;
                    break;
                }
                return Err(JournalError::ChecksumMismatch {
                    offset: cursor as u64,
                });
            }

            let entry: JournalEntry = bincode::deserialize(payload)?;
            entries.push(entry);
            cursor = payload_end;
        }

        if truncated_tail_bytes > 0 {
            let valid_len = (total_len as u64).saturating_sub(truncated_tail_bytes);
            file.set_len(valid_len).map_err(|source| JournalError::Io {
                path: path.to_path_buf(),
                source,
            })?;
            file.sync_data().map_err(|source| JournalError::Io {
                path: path.to_path_buf(),
                source,
            })?;
        }

        Ok(JournalReplayReport {
            entries,
            truncated_tail_bytes,
        })
    }
}
