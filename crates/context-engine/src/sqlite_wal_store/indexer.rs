//! Debounced incremental indexer (`300 ms` threshold on a low-priority Tokio pool) (`LOT-008`).

use super::*;

#[derive(Debug, Clone)]
enum PendingIndexAction {
    UpsertFile {
        document_revision: u32,
        content: String,
    },
    RemoveFile,
}

/// Event sent to the background `DebouncedIndexer` worker (`LOT-008`).
#[derive(Debug, Clone)]
pub enum IndexerEvent {
    FileModified {
        relative_path: String,
        document_revision: u32,
        content: String,
    },
    FileRemoved {
        relative_path: String,
    },
    BranchSwitched {
        new_branch: String,
    },
    FlushNow,
}

/// Debounced incremental indexer scheduling SQLite (`WAL`/`mmap`) + `FTS5` updates after a quiet
/// threshold (`300 ms` default) so background indexing never contends with CodeMirror 6 keystrokes (`LOT-008`).
#[derive(Debug)]
pub struct DebouncedIndexer {
    debounce_window: Duration,
    pending_files: BTreeMap<String, (Instant, PendingIndexAction)>,
    pending_branch_switch: Option<String>,
}

impl DebouncedIndexer {
    #[must_use]
    pub fn new(debounce_ms: u64) -> Self {
        Self {
            debounce_window: Duration::from_millis(debounce_ms),
            pending_files: BTreeMap::new(),
            pending_branch_switch: None,
        }
    }

    #[must_use]
    pub const fn debounce_window(&self) -> Duration {
        self.debounce_window
    }

    #[must_use]
    pub fn pending_count(&self) -> usize {
        self.pending_files.len()
    }

    /// Record a file modification; resets the debounce timer for `relative_path`.
    pub fn notify_file_modified(
        &mut self,
        relative_path: &str,
        document_revision: u32,
        content: String,
    ) {
        let norm = normalize_rel_path(relative_path);
        self.pending_files.insert(
            norm,
            (
                Instant::now(),
                PendingIndexAction::UpsertFile {
                    document_revision,
                    content,
                },
            ),
        );
    }

    /// Record a file deletion.
    pub fn notify_file_removed(&mut self, relative_path: &str) {
        let norm = normalize_rel_path(relative_path);
        self.pending_files
            .insert(norm, (Instant::now(), PendingIndexAction::RemoveFile));
    }

    /// Record a Git branch switch, clearing obsolete pending file mutations.
    pub fn notify_branch_switched(&mut self, new_branch: impl Into<String>) {
        self.pending_files.clear();
        self.pending_branch_switch = Some(new_branch.into());
    }

    /// Flush all queued mutations whose `debounce_window` has elapsed (or all mutations if `force_all = true`).
    pub fn flush_due_updates(
        &mut self,
        engine: &mut SqliteWalContextEngine,
        force_all: bool,
    ) -> Result<usize, ContextStorageError> {
        let mut applied = 0usize;
        if let Some(new_branch) = self.pending_branch_switch.take() {
            engine.switch_git_branch(new_branch)?;
            applied += 1;
        }

        let now = Instant::now();
        let ready_paths: Vec<String> = self
            .pending_files
            .iter()
            .filter_map(|(path, (queued_at, _))| {
                if force_all || now.saturating_duration_since(*queued_at) >= self.debounce_window {
                    Some(path.clone())
                } else {
                    None
                }
            })
            .collect();

        for path in ready_paths {
            if let Some((_, action)) = self.pending_files.remove(&path) {
                match action {
                    PendingIndexAction::UpsertFile {
                        document_revision,
                        content,
                    } => {
                        engine.index_file(&path, document_revision, &content)?;
                        applied += 1;
                    }
                    PendingIndexAction::RemoveFile => {
                        engine.remove_file(&path)?;
                        applied += 1;
                    }
                }
            }
        }

        Ok(applied)
    }

    /// Spawn a background low-priority Tokio task processing `IndexerEvent`s with `debounce_ms` batching.
    pub fn spawn_background_worker(
        engine: Arc<Mutex<SqliteWalContextEngine>>,
        debounce_ms: u64,
    ) -> mpsc::UnboundedSender<IndexerEvent> {
        let (tx, mut rx) = mpsc::unbounded_channel::<IndexerEvent>();
        let tick_interval = Duration::from_millis((debounce_ms / 3).clamp(10, 100));

        tokio::spawn(async move {
            let mut indexer = DebouncedIndexer::new(debounce_ms);
            let mut ticker = tokio::time::interval(tick_interval);
            loop {
                tokio::select! {
                    maybe_ev = rx.recv() => {
                        let Some(ev) = maybe_ev else {
                            let mut guard = engine.lock().await;
                            let _ = indexer.flush_due_updates(&mut guard, true);
                            break;
                        };
                        match ev {
                            IndexerEvent::FileModified { relative_path, document_revision, content } => {
                                indexer.notify_file_modified(&relative_path, document_revision, content);
                            }
                            IndexerEvent::FileRemoved { relative_path } => {
                                indexer.notify_file_removed(&relative_path);
                            }
                            IndexerEvent::BranchSwitched { new_branch } => {
                                indexer.notify_branch_switched(new_branch);
                                let mut guard = engine.lock().await;
                                let _ = indexer.flush_due_updates(&mut guard, true);
                            }
                            IndexerEvent::FlushNow => {
                                let mut guard = engine.lock().await;
                                let _ = indexer.flush_due_updates(&mut guard, true);
                            }
                        }
                        tokio::task::yield_now().await;
                    }
                    _ = ticker.tick() => {
                        if indexer.pending_count() > 0 || indexer.pending_branch_switch.is_some() {
                            let mut guard = engine.lock().await;
                            let _ = indexer.flush_due_updates(&mut guard, false);
                            tokio::task::yield_now().await;
                        }
                    }
                }
            }
        });

        tx
    }
}
