//! Unsaved in-memory buffers that take priority over disk-indexed rows (`LOT-008`).

use super::*;

/// Live unsaved document entry tracked by `UnsavedBufferOverlay` (`interactive_revision > disk_saved_revision`).
#[derive(Debug, Clone)]
pub struct UnsavedBufferEntry {
    pub file_path: String,
    pub rope: Rope,
    pub interactive_revision: u32,
    pub disk_saved_revision: u32,
    pub content_blake3_hash: String,
}

impl UnsavedBufferEntry {
    #[must_use]
    pub const fn has_unsaved_changes(&self) -> bool {
        self.interactive_revision != self.disk_saved_revision
    }
}

/// Overlay prioritizing unsaved in-memory `ropey::Rope` buffers (`interactive_revision > disk_saved_revision`)
/// over disk-indexed SQLite records (`LOT-008`).
#[derive(Debug, Default, Clone)]
pub struct UnsavedBufferOverlay {
    entries: BTreeMap<String, UnsavedBufferEntry>,
}

impl UnsavedBufferOverlay {
    #[must_use]
    pub fn new() -> Self {
        Self {
            entries: BTreeMap::new(),
        }
    }

    /// Register or update an in-memory buffer. Only kept in the active overlay if
    /// `interactive_revision > disk_saved_revision`.
    pub fn upsert_buffer(
        &mut self,
        file_path: &str,
        rope: Rope,
        interactive_revision: u32,
        disk_saved_revision: u32,
        content_blake3_hash: Option<String>,
    ) {
        let norm_path = normalize_rel_path(file_path);
        // `!=`, not `>`: a buffer opened with unsaved edits has `NEVER_SAVED_REVISION` on disk.
        if interactive_revision != disk_saved_revision {
            let hash = content_blake3_hash.unwrap_or_else(|| compute_rope_blake3_hex(&rope));
            self.entries.insert(
                norm_path.clone(),
                UnsavedBufferEntry {
                    file_path: norm_path,
                    rope,
                    interactive_revision,
                    disk_saved_revision,
                    content_blake3_hash: hash,
                },
            );
        } else {
            self.entries.remove(&norm_path);
        }
    }

    /// Remove a path from the unsaved buffer overlay (e.g. when saved to disk or closed).
    pub fn remove_buffer(&mut self, file_path: &str) {
        let norm = normalize_rel_path(file_path);
        self.entries.remove(&norm);
    }

    /// Synchronize the overlay directly from `host_core::DocumentService`:
    /// any session with `interactive_revision > disk_saved_revision` is registered in the overlay,
    /// and any session saved to disk (`interactive_revision == disk_saved_revision`) is removed.
    pub fn sync_from_document_service(
        &mut self,
        workspace_root: Option<&Path>,
        document_service: &DocumentService,
    ) {
        self.entries.clear();
        for session in document_service.sessions() {
            if session.has_unsaved_changes() {
                let resolved_path = match (session.disk_path(), workspace_root) {
                    // A file outside the workspace (another project's session) is not this
                    // workspace's file, whatever its relative id says.
                    (Some(disk_p), Some(root)) => match disk_p.strip_prefix(root) {
                        Ok(rel) => normalize_rel_path(&rel.to_string_lossy()),
                        Err(_) => continue,
                    },
                    (Some(disk_p), None) => normalize_rel_path(&disk_p.to_string_lossy()),
                    (None, _) => normalize_rel_path(session.document_id()),
                };

                self.entries.insert(
                    resolved_path.clone(),
                    UnsavedBufferEntry {
                        file_path: resolved_path,
                        rope: session.rope().clone(),
                        interactive_revision: session.interactive_revision(),
                        disk_saved_revision: session.disk_saved_revision(),
                        content_blake3_hash: session.content_blake3_hash().to_string(),
                    },
                );
            }
        }
    }

    #[must_use]
    pub fn get(&self, file_path: &str) -> Option<&UnsavedBufferEntry> {
        let norm = normalize_rel_path(file_path);
        self.entries.get(&norm)
    }

    #[must_use]
    pub fn entries(&self) -> &BTreeMap<String, UnsavedBufferEntry> {
        &self.entries
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}
