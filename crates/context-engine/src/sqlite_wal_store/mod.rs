//! SQLite (`WAL` + `mmap`) + `FTS5 (BM25)` context engine (`LOT-008`).
//!
//! `mod.rs` owns the row types, the engine struct and its public lifecycle; the submodules add
//! `impl SqliteWalContextEngine` blocks per concern and pull the shared imports in with `use super::*`.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use host_core::{
    compute_rope_blake3_hex, utf16_to_line_col, utf8_to_utf16, AuthorizedDestination,
    ConfidenceLevel, ContextBundle, ContextExcerpt, DataClassification, DocumentService,
    ExcerptFreshness, LineCol, Utf8ByteOffset, Utf8Span, CONTRACT_SCHEMA_VERSION,
};
use ropey::Rope;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::{mpsc, Mutex};

use crate::ast_graph::{
    is_test_file_path, GraphEdgeConfidence, ImpactAnalyzer, IncrementalAstParser, RopeTextProvider,
    SupportedAstLanguage, SymbolKind,
};
use crate::secret_scanner::{
    normalize_rel_path, AclAndSecretScanner, AclDenialReason, AuditSecretRedactionEvent,
    REDACTED_SECRET_MARKER,
};

mod indexer;
mod indexing;
mod overlay;
mod persistence;
mod search;

pub use indexer::{DebouncedIndexer, IndexerEvent};
pub use overlay::{UnsavedBufferEntry, UnsavedBufferOverlay};
pub use search::tokenize_for_fts5;

use indexing::{build_chunks_for_parsed_file, collect_workspace_files_recursively};
use persistence::WalMutationFrame;

/// Default debounce window (`300 ms`) before indexing modified files on the background pool (`LOT-008`).
pub const DEFAULT_INDEX_DEBOUNCE_MS: u64 = 300;

/// Default memory-mapped I/O window (`256 MiB`) for SQLite `mmap_size` (`LOT-008`).
pub const DEFAULT_SQLITE_MMAP_SIZE_BYTES: u64 = 268_435_456;

/// Canonical SQLite (`WAL`/`mmap` + `FTS5`) DDL schema for `LOT-008`.
pub const SQLITE_CONTEXT_SCHEMA_DDL: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA mmap_size = 268435456;
PRAGMA temp_store = MEMORY;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS files (
    file_path TEXT PRIMARY KEY,
    document_revision INTEGER NOT NULL,
    content_blake3_hash TEXT NOT NULL,
    language TEXT NOT NULL,
    is_test_file INTEGER NOT NULL,
    byte_len INTEGER NOT NULL,
    line_count INTEGER NOT NULL,
    git_branch TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ast_chunks (
    chunk_id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL REFERENCES files(file_path) ON DELETE CASCADE,
    document_revision INTEGER NOT NULL,
    content_blake3_hash TEXT NOT NULL,
    symbol_name TEXT,
    symbol_kind TEXT,
    exported INTEGER NOT NULL,
    start_byte INTEGER NOT NULL,
    end_byte INTEGER NOT NULL,
    start_line INTEGER NOT NULL,
    start_col_utf16 INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    end_col_utf16 INTEGER NOT NULL,
    node_blake3_hash TEXT NOT NULL,
    sanitized_content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS symbol_edges (
    importer_file TEXT NOT NULL,
    target_file TEXT NOT NULL,
    imported_symbols_json TEXT NOT NULL,
    confidence TEXT NOT NULL,
    PRIMARY KEY (importer_file, target_file)
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
    chunk_id UNINDEXED,
    file_path,
    symbol_name,
    tokenized_content,
    tokenize = 'unicode61'
);
"#;

/// Active SQLite `PRAGMA` settings for `LOT-008` (`WAL` + `NORMAL` + `mmap_size`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SqlitePragmaConfig {
    pub journal_mode: String,
    pub synchronous: String,
    pub mmap_size: u64,
    pub temp_store: String,
    pub foreign_keys: bool,
    pub zero_mb_model_download_required: bool,
}

impl Default for SqlitePragmaConfig {
    fn default() -> Self {
        Self {
            journal_mode: "WAL".to_string(),
            synchronous: "NORMAL".to_string(),
            mmap_size: DEFAULT_SQLITE_MMAP_SIZE_BYTES,
            temp_store: "MEMORY".to_string(),
            foreign_keys: true,
            zero_mb_model_download_required: true,
        }
    }
}

/// Row stored in the `files` table (`LOT-008`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SqliteFileRow {
    pub file_path: String,
    pub document_revision: u32,
    pub content_blake3_hash: String,
    pub language: SupportedAstLanguage,
    pub is_test_file: bool,
    pub byte_len: u32,
    pub line_count: u32,
    pub git_branch: String,
}

/// Row stored in the `ast_chunks` table (`LOT-008`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SqliteAstChunkRow {
    pub chunk_id: String,
    pub file_path: String,
    pub document_revision: u32,
    pub content_blake3_hash: String,
    pub symbol_name: Option<String>,
    pub symbol_kind: Option<SymbolKind>,
    pub exported: bool,
    pub span_utf8: Utf8Span,
    pub start_line_col: LineCol,
    pub end_line_col: LineCol,
    pub node_blake3_hash: String,
    pub sanitized_content: String,
    pub referenced_identifiers: Vec<String>,
}

/// Row stored in the `symbol_edges` table (`LOT-008`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SqliteSymbolEdgeRow {
    pub importer_file: String,
    pub target_file: String,
    pub imported_symbols: Vec<String>,
    pub confidence: GraphEdgeConfidence,
}

/// Row stored in the `fts_chunks` virtual table (`FTS5 BM25`, `LOT-008`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SqliteFtsChunkRow {
    pub chunk_id: String,
    pub file_path: String,
    pub symbol_name: Option<String>,
    pub tokenized_content: String,
    pub term_frequencies: BTreeMap<String, u32>,
    pub total_terms: u32,
}

/// Errors returned by `SqliteWalContextEngine` (`LOT-008`).
#[derive(Debug, Error)]
pub enum ContextStorageError {
    #[error("ACL policy blocked file '{file_path}': {reason:?}")]
    AclBlocked {
        file_path: String,
        reason: AclDenialReason,
    },
    #[error("I/O error on context store path {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("Corrupted SQLite context store image at {path}: {reason}")]
    CorruptedStore { path: PathBuf, reason: String },
}

/// Ranked context search result combining FTS5 BM25 score, AST symbol match, and graph neighborhood (`LOT-008`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContextSearchHit {
    pub excerpt: ContextExcerpt,
    pub unsaved_buffer: bool,
    pub bm25_score: f64,
    pub graph_boost: f64,
    pub combined_score: f64,
    pub symbol_name: Option<String>,
    pub symbol_kind: Option<SymbolKind>,
}

/// SQLite (`WAL` + `mmap`) + `FTS5 (BM25)` Context Engine with mandatory `AclAndSecretScanner`
/// and `UnsavedBufferOverlay` (`LOT-008`).
#[derive(Debug)]
pub struct SqliteWalContextEngine {
    pub(crate) vector_changes: crate::changes::ChangeJournal,
    db_path: PathBuf,
    wal_path: PathBuf,
    pragmas: SqlitePragmaConfig,
    active_git_branch: String,
    scanner: AclAndSecretScanner,
    overlay: UnsavedBufferOverlay,
    ast_parser: IncrementalAstParser,
    impact_analyzer: ImpactAnalyzer,
    files: BTreeMap<String, SqliteFileRow>,
    ast_chunks: BTreeMap<String, SqliteAstChunkRow>,
    symbol_edges: Vec<SqliteSymbolEdgeRow>,
    fts_chunks: BTreeMap<String, SqliteFtsChunkRow>,
    inverted_postings: BTreeMap<String, BTreeSet<String>>,
    total_fts_terms: u64,
}

impl SqliteWalContextEngine {
    /// Open an existing SQLite (`WAL`/`mmap`) context database at `db_path`, or create a fresh one.
    /// If the database file exists on the same `git_branch`, loads the `.sqlite` snapshot and replays
    /// any pending `.sqlite-wal` frames.
    pub fn open(
        db_path: impl Into<PathBuf>,
        git_branch: impl Into<String>,
        scanner: AclAndSecretScanner,
    ) -> Result<Self, ContextStorageError> {
        let db_path = db_path.into();
        let wal_path = Self::wal_path_for(&db_path);
        let active_git_branch = git_branch.into();

        let mut engine = Self {
            vector_changes: Default::default(),
            db_path,
            wal_path,
            pragmas: SqlitePragmaConfig::default(),
            active_git_branch,
            scanner,
            overlay: UnsavedBufferOverlay::new(),
            ast_parser: IncrementalAstParser::new(),
            impact_analyzer: ImpactAnalyzer::new(),
            files: BTreeMap::new(),
            ast_chunks: BTreeMap::new(),
            symbol_edges: Vec::new(),
            fts_chunks: BTreeMap::new(),
            inverted_postings: BTreeMap::new(),
            total_fts_terms: 0,
        };

        if engine.db_path.exists() {
            match engine.load_snapshot_and_wal() {
                Ok(loaded_branch) => {
                    if loaded_branch != engine.active_git_branch {
                        // Branch changed: invalidate stale index and persist clean snapshot for new branch
                        engine.clear_all_tables();
                        engine.persist_full_snapshot()?;
                    }
                }
                Err(_) => {
                    // Corrupted or incompatible image: reset deterministically
                    engine.clear_all_tables();
                    engine.persist_full_snapshot()?;
                }
            }
        } else {
            engine.persist_full_snapshot()?;
        }

        Ok(engine)
    }

    /// Open a SQLite context store and deterministically rebuild from `workspace_root` if empty,
    /// missing, or invalidated by a branch switch (`LOT-008` Section 4.4.1).
    pub fn open_or_rebuild_from_workspace(
        db_path: impl Into<PathBuf>,
        workspace_root: &Path,
        git_branch: impl Into<String>,
    ) -> Result<Self, ContextStorageError> {
        let scanner = AclAndSecretScanner::from_workspace_root(workspace_root);
        let mut engine = Self::open(db_path, git_branch, scanner)?;
        if engine.files.is_empty() {
            engine.rebuild_from_workspace(workspace_root)?;
        }
        Ok(engine)
    }

    #[must_use]
    pub fn wal_path_for(db_path: &Path) -> PathBuf {
        let mut os = db_path.as_os_str().to_os_string();
        os.push("-wal");
        PathBuf::from(os)
    }

    #[must_use]
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    #[must_use]
    pub fn wal_path(&self) -> &Path {
        &self.wal_path
    }

    #[must_use]
    pub const fn pragmas(&self) -> &SqlitePragmaConfig {
        &self.pragmas
    }

    #[must_use]
    pub fn active_git_branch(&self) -> &str {
        &self.active_git_branch
    }

    #[must_use]
    pub const fn scanner(&self) -> &AclAndSecretScanner {
        &self.scanner
    }

    pub fn scanner_mut(&mut self) -> &mut AclAndSecretScanner {
        &mut self.scanner
    }

    #[must_use]
    pub const fn overlay(&self) -> &UnsavedBufferOverlay {
        &self.overlay
    }

    pub fn overlay_mut(&mut self) -> &mut UnsavedBufferOverlay {
        &mut self.overlay
    }

    #[must_use]
    pub const fn impact_analyzer(&self) -> &ImpactAnalyzer {
        &self.impact_analyzer
    }

    #[must_use]
    pub const fn files_table(&self) -> &BTreeMap<String, SqliteFileRow> {
        &self.files
    }

    #[must_use]
    pub const fn ast_chunks_table(&self) -> &BTreeMap<String, SqliteAstChunkRow> {
        &self.ast_chunks
    }

    #[must_use]
    pub fn symbol_edges_table(&self) -> &[SqliteSymbolEdgeRow] {
        &self.symbol_edges
    }

    #[must_use]
    pub const fn fts_chunks_table(&self) -> &BTreeMap<String, SqliteFtsChunkRow> {
        &self.fts_chunks
    }

    #[must_use]
    pub fn audit_log(&self) -> &[AuditSecretRedactionEvent] {
        self.scanner.audit_log()
    }

    /// Switch the active Git branch, invalidating stale branch records and persisting the transition.
    pub fn switch_git_branch(
        &mut self,
        new_branch: impl Into<String>,
    ) -> Result<bool, ContextStorageError> {
        let new_branch = new_branch.into();
        if self.active_git_branch == new_branch {
            return Ok(false);
        }
        self.active_git_branch = new_branch.clone();
        self.clear_all_tables();
        self.append_wal_frame(&WalMutationFrame::BranchSwitched { new_branch })?;
        self.persist_full_snapshot()?;
        Ok(true)
    }

    /// Deterministically rebuild the entire SQLite (`WAL`/`mmap`) + `FTS5` store from `workspace_root`.
    pub fn rebuild_from_workspace(
        &mut self,
        workspace_root: &Path,
    ) -> Result<usize, ContextStorageError> {
        self.clear_all_tables();
        let mut discovered_files = Vec::new();
        collect_workspace_files_recursively(workspace_root, workspace_root, &mut discovered_files)?;
        discovered_files.sort();

        let mut indexed_count = 0usize;
        for rel_path in discovered_files {
            if self.scanner.check_path_acl(&rel_path).is_err() {
                continue;
            }
            let full_path = workspace_root.join(&rel_path);
            let Ok(raw_text) = std::fs::read_to_string(&full_path) else {
                continue;
            };
            if self
                .index_file_internal(&rel_path, 0, &raw_text, false)?
                .is_some()
            {
                indexed_count += 1;
            }
        }

        self.persist_full_snapshot()?;
        Ok(indexed_count)
    }

    /// Index or re-index a single file after running `AclAndSecretScanner` prior to any SQLite insert.
    /// Appends a durable frame to `.sqlite-wal` without rewriting the full `.sqlite` snapshot on every file.
    /// Returns `Ok(None)` if the file path is excluded by ACL / `.gitignore` / `.colorideignore` / `.env` rules.
    pub fn index_file(
        &mut self,
        relative_path: &str,
        document_revision: u32,
        raw_content: &str,
    ) -> Result<Option<SqliteFileRow>, ContextStorageError> {
        self.index_file_internal(relative_path, document_revision, raw_content, true)
    }

    /// Remove a deleted file from `files`, `ast_chunks`, `symbol_edges`, and `fts_chunks`,
    /// recording the removal frame in `.sqlite-wal`.
    pub fn remove_file(&mut self, relative_path: &str) -> Result<bool, ContextStorageError> {
        let norm_path = normalize_rel_path(relative_path);
        self.overlay.remove_buffer(&norm_path);
        if self.files.remove(&norm_path).is_none() {
            return Ok(false);
        }

        self.vector_changes.mark(Some(norm_path.clone()));
        self.remove_chunks_for_file(&norm_path);
        self.rebuild_impact_analyzer_from_chunks();

        let edges = self.symbol_edges.clone();
        self.append_wal_frame(&WalMutationFrame::FileRemoved {
            file_path: norm_path,
            edges,
        })?;
        Ok(true)
    }

    /// Checkpoint the `.sqlite-wal` log into the primary `.sqlite` file and truncate the WAL.
    pub fn checkpoint_wal(&mut self) -> Result<(), ContextStorageError> {
        self.persist_full_snapshot()
    }
}
