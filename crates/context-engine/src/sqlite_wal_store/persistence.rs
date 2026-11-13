//! On-disk snapshot image and write-ahead log frames for the context store (`LOT-008`).

use super::*;

const SQLITE_SNAPSHOT_MAGIC: &[u8; 16] = b"COLORIDE_SQL8_01";
const SQLITE_WAL_FRAME_MAGIC: &[u8; 8] = b"CLRWAL08";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct PersistedSqliteDatabaseImage {
    schema_ddl: String,
    pragmas: SqlitePragmaConfig,
    active_git_branch: String,
    files: BTreeMap<String, SqliteFileRow>,
    ast_chunks: BTreeMap<String, SqliteAstChunkRow>,
    symbol_edges: Vec<SqliteSymbolEdgeRow>,
    fts_chunks: BTreeMap<String, SqliteFtsChunkRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) enum WalMutationFrame {
    FileIndexed {
        file_row: SqliteFileRow,
        chunks: Vec<SqliteAstChunkRow>,
        fts_rows: Vec<SqliteFtsChunkRow>,
        edges: Vec<SqliteSymbolEdgeRow>,
    },
    FileRemoved {
        file_path: String,
        edges: Vec<SqliteSymbolEdgeRow>,
    },
    BranchSwitched {
        new_branch: String,
    },
}

impl SqliteWalContextEngine {
    pub(super) fn persist_full_snapshot(&self) -> Result<(), ContextStorageError> {
        if let Some(parent) = self.db_path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|source| ContextStorageError::Io {
                    path: parent.to_path_buf(),
                    source,
                })?;
            }
        }

        let image = PersistedSqliteDatabaseImage {
            schema_ddl: SQLITE_CONTEXT_SCHEMA_DDL.to_string(),
            pragmas: self.pragmas.clone(),
            active_git_branch: self.active_git_branch.clone(),
            files: self.files.clone(),
            ast_chunks: self.ast_chunks.clone(),
            symbol_edges: self.symbol_edges.clone(),
            fts_chunks: self.fts_chunks.clone(),
        };

        let payload =
            bincode::serialize(&image).map_err(|err| ContextStorageError::CorruptedStore {
                path: self.db_path.clone(),
                reason: err.to_string(),
            })?;
        let digest = blake3::hash(&payload);

        let tmp_path = self.db_path.with_extension("sqlite.tmp");
        {
            let file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&tmp_path)
                .map_err(|source| ContextStorageError::Io {
                    path: tmp_path.clone(),
                    source,
                })?;
            let mut writer = BufWriter::new(file);
            writer
                .write_all(SQLITE_SNAPSHOT_MAGIC)
                .map_err(|source| ContextStorageError::Io {
                    path: tmp_path.clone(),
                    source,
                })?;
            writer
                .write_all(digest.as_bytes())
                .map_err(|source| ContextStorageError::Io {
                    path: tmp_path.clone(),
                    source,
                })?;
            let len_u64 = payload.len() as u64;
            writer
                .write_all(&len_u64.to_le_bytes())
                .map_err(|source| ContextStorageError::Io {
                    path: tmp_path.clone(),
                    source,
                })?;
            writer
                .write_all(&payload)
                .map_err(|source| ContextStorageError::Io {
                    path: tmp_path.clone(),
                    source,
                })?;
            writer.flush().map_err(|source| ContextStorageError::Io {
                path: tmp_path.clone(),
                source,
            })?;
        }

        std::fs::rename(&tmp_path, &self.db_path).map_err(|source| ContextStorageError::Io {
            path: self.db_path.clone(),
            source,
        })?;

        // Truncate/initialize the `.sqlite-wal` file alongside the snapshot
        let _ = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&self.wal_path);

        Ok(())
    }

    pub(super) fn append_wal_frame(
        &self,
        frame: &WalMutationFrame,
    ) -> Result<(), ContextStorageError> {
        let payload =
            bincode::serialize(frame).map_err(|err| ContextStorageError::CorruptedStore {
                path: self.wal_path.clone(),
                reason: err.to_string(),
            })?;
        let digest = blake3::hash(&payload);
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.wal_path)
            .map_err(|source| ContextStorageError::Io {
                path: self.wal_path.clone(),
                source,
            })?;
        let mut writer = BufWriter::new(file);
        writer
            .write_all(SQLITE_WAL_FRAME_MAGIC)
            .map_err(|source| ContextStorageError::Io {
                path: self.wal_path.clone(),
                source,
            })?;
        writer
            .write_all(digest.as_bytes())
            .map_err(|source| ContextStorageError::Io {
                path: self.wal_path.clone(),
                source,
            })?;
        let len_u32 = payload.len() as u32;
        writer
            .write_all(&len_u32.to_le_bytes())
            .map_err(|source| ContextStorageError::Io {
                path: self.wal_path.clone(),
                source,
            })?;
        writer
            .write_all(&payload)
            .map_err(|source| ContextStorageError::Io {
                path: self.wal_path.clone(),
                source,
            })?;
        writer.flush().map_err(|source| ContextStorageError::Io {
            path: self.wal_path.clone(),
            source,
        })?;
        Ok(())
    }

    pub(super) fn load_snapshot_and_wal(&mut self) -> Result<String, ContextStorageError> {
        let file = File::open(&self.db_path).map_err(|source| ContextStorageError::Io {
            path: self.db_path.clone(),
            source,
        })?;
        let mut reader = BufReader::new(file);
        let mut magic = [0u8; 16];
        reader
            .read_exact(&mut magic)
            .map_err(|_| ContextStorageError::CorruptedStore {
                path: self.db_path.clone(),
                reason: "Invalid or truncated header magic".to_string(),
            })?;
        if &magic != SQLITE_SNAPSHOT_MAGIC {
            return Err(ContextStorageError::CorruptedStore {
                path: self.db_path.clone(),
                reason: "Mismatched SQLite context store magic".to_string(),
            });
        }

        let mut expected_digest = [0u8; 32];
        reader.read_exact(&mut expected_digest).map_err(|_| {
            ContextStorageError::CorruptedStore {
                path: self.db_path.clone(),
                reason: "Truncated digest".to_string(),
            }
        })?;

        let mut len_bytes = [0u8; 8];
        reader
            .read_exact(&mut len_bytes)
            .map_err(|_| ContextStorageError::CorruptedStore {
                path: self.db_path.clone(),
                reason: "Truncated payload length".to_string(),
            })?;
        let payload_len = u64::from_le_bytes(len_bytes) as usize;
        let mut payload = vec![0u8; payload_len];
        reader
            .read_exact(&mut payload)
            .map_err(|_| ContextStorageError::CorruptedStore {
                path: self.db_path.clone(),
                reason: "Truncated payload body".to_string(),
            })?;

        let actual_digest = blake3::hash(&payload);
        if actual_digest.as_bytes() != &expected_digest {
            return Err(ContextStorageError::CorruptedStore {
                path: self.db_path.clone(),
                reason: "BLAKE3 checksum mismatch".to_string(),
            });
        }

        let image: PersistedSqliteDatabaseImage =
            bincode::deserialize(&payload).map_err(|err| ContextStorageError::CorruptedStore {
                path: self.db_path.clone(),
                reason: err.to_string(),
            })?;

        self.pragmas = image.pragmas;
        self.files = image.files;
        self.ast_chunks = image.ast_chunks;
        self.symbol_edges = image.symbol_edges;
        self.fts_chunks = image.fts_chunks;
        self.rebuild_inverted_postings();

        let mut loaded_branch = image.active_git_branch;

        // Replay any committed frames in `.sqlite-wal`
        if self.wal_path.exists() {
            if let Ok(wal_file) = File::open(&self.wal_path) {
                let mut wal_reader = BufReader::new(wal_file);
                loop {
                    let mut frame_magic = [0u8; 8];
                    if wal_reader.read_exact(&mut frame_magic).is_err() {
                        break;
                    }
                    if &frame_magic != SQLITE_WAL_FRAME_MAGIC {
                        break;
                    }
                    let mut frame_digest = [0u8; 32];
                    if wal_reader.read_exact(&mut frame_digest).is_err() {
                        break;
                    }
                    let mut flen_bytes = [0u8; 4];
                    if wal_reader.read_exact(&mut flen_bytes).is_err() {
                        break;
                    }
                    let flen = u32::from_le_bytes(flen_bytes) as usize;
                    let mut fpayload = vec![0u8; flen];
                    if wal_reader.read_exact(&mut fpayload).is_err() {
                        break;
                    }
                    if blake3::hash(&fpayload).as_bytes() != &frame_digest {
                        break;
                    }
                    let Ok(frame) = bincode::deserialize::<WalMutationFrame>(&fpayload) else {
                        break;
                    };
                    match frame {
                        WalMutationFrame::FileIndexed {
                            file_row,
                            chunks,
                            fts_rows,
                            edges,
                        } => {
                            self.remove_chunks_for_file(&file_row.file_path);
                            self.files.insert(file_row.file_path.clone(), file_row);
                            for c in chunks {
                                self.ast_chunks.insert(c.chunk_id.clone(), c);
                            }
                            for f in fts_rows {
                                for term in f.term_frequencies.keys() {
                                    self.inverted_postings
                                        .entry(term.clone())
                                        .or_default()
                                        .insert(f.chunk_id.clone());
                                }
                                self.total_fts_terms += u64::from(f.total_terms);
                                self.fts_chunks.insert(f.chunk_id.clone(), f);
                            }
                            self.symbol_edges = edges;
                        }
                        WalMutationFrame::FileRemoved { file_path, edges } => {
                            self.files.remove(&file_path);
                            self.remove_chunks_for_file(&file_path);
                            self.symbol_edges = edges;
                        }
                        WalMutationFrame::BranchSwitched { new_branch } => {
                            loaded_branch = new_branch;
                            self.clear_all_tables();
                        }
                    }
                }
            }
        }

        self.rebuild_impact_analyzer_from_chunks();
        Ok(loaded_branch)
    }
}
