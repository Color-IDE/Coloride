//! Atomic save of a document: a pending temp file, the disk-conflict check and the content hash.

use super::*;

/// In-flight atomic disk save snapshot capturing the exact revision `T` being flushed to disk.
#[derive(Debug, Clone)]
pub struct PendingDiskSave {
    pub document_id: String,
    pub session_generation: u32,
    pub target_revision: u32,
    pub target_blake3_hash: String,
    pub disk_path: PathBuf,
    pub expected_disk_hash: Option<String>,
    pub(super) rope_snapshot: Rope,
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
