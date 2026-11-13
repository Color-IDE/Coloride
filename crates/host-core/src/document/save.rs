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

        // Keep the file's permissions (an executable script stays executable).
        let original_permissions = std::fs::metadata(&self.disk_path)
            .ok()
            .map(|metadata| metadata.permissions());
        let written = self.write_temp_file(&tmp_path).and_then(|()| {
            if let Some(permissions) = original_permissions {
                std::fs::set_permissions(&tmp_path, permissions).map_err(|source| {
                    DocumentError::Io {
                        path: tmp_path.clone(),
                        source,
                    }
                })?;
            }
            std::fs::rename(&tmp_path, &self.disk_path).map_err(|source| DocumentError::Io {
                path: self.disk_path.clone(),
                source,
            })
        });
        if let Err(error) = written {
            // Never leave a hidden temp file behind in the user's folder.
            let _ = std::fs::remove_file(&tmp_path);
            return Err(error);
        }

        Ok(self.target_blake3_hash.clone())
    }

    /// Write the captured rope to `tmp_path` and `sync_data()` it.
    fn write_temp_file(&self, tmp_path: &Path) -> Result<(), DocumentError> {
        let tmp_file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(tmp_path)
            .map_err(|source| DocumentError::Io {
                path: tmp_path.to_path_buf(),
                source,
            })?;
        let mut writer = BufWriter::new(tmp_file);
        for chunk in self.rope_snapshot.chunks() {
            writer
                .write_all(chunk.as_bytes())
                .map_err(|source| DocumentError::Io {
                    path: tmp_path.to_path_buf(),
                    source,
                })?;
        }
        writer.flush().map_err(|source| DocumentError::Io {
            path: tmp_path.to_path_buf(),
            source,
        })?;
        let inner_file = writer.into_inner().map_err(|err| DocumentError::Io {
            path: tmp_path.to_path_buf(),
            source: err.into_error(),
        })?;
        inner_file.sync_data().map_err(|source| DocumentError::Io {
            path: tmp_path.to_path_buf(),
            source,
        })?;
        Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(disk_path: PathBuf, text: &str) -> PendingDiskSave {
        let rope = Rope::from_str(text);
        PendingDiskSave {
            document_id: "doc".to_string(),
            session_generation: 1,
            target_revision: 1,
            target_blake3_hash: compute_rope_blake3_hex(&rope),
            disk_path,
            expected_disk_hash: None,
            rope_snapshot: rope,
        }
    }

    fn leftover_temp_files(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter(|name| name.contains(".coloride-atomic-"))
            .collect()
    }

    #[cfg(unix)]
    #[test]
    fn saving_keeps_the_file_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("deploy.sh");
        std::fs::write(&script, "echo old\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        pending(script.clone(), "echo new\n")
            .flush_to_disk()
            .unwrap();

        assert_eq!(std::fs::read_to_string(&script).unwrap(), "echo new\n");
        let mode = std::fs::metadata(&script).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
        assert!(leftover_temp_files(dir.path()).is_empty());
    }

    #[test]
    fn a_failed_save_leaves_no_temp_file_behind() {
        let dir = tempfile::tempdir().unwrap();
        // The target is a non-empty directory, so the final rename fails after the temp is written.
        let target = dir.path().join("blocked.ts");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("inside.txt"), "x").unwrap();

        assert!(pending(target.clone(), "const a = 1;\n")
            .flush_to_disk()
            .is_err());
        assert!(leftover_temp_files(dir.path()).is_empty());
        assert!(target.join("inside.txt").exists());
    }
}
