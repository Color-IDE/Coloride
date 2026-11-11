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
};

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

const SQLITE_SNAPSHOT_MAGIC: &[u8; 16] = b"COLORIDE_SQL8_01";
const SQLITE_WAL_FRAME_MAGIC: &[u8; 8] = b"CLRWAL08";

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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedSqliteDatabaseImage {
    schema_ddl: String,
    pragmas: SqlitePragmaConfig,
    active_git_branch: String,
    files: BTreeMap<String, SqliteFileRow>,
    ast_chunks: BTreeMap<String, SqliteAstChunkRow>,
    symbol_edges: Vec<SqliteSymbolEdgeRow>,
    fts_chunks: BTreeMap<String, SqliteFtsChunkRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
enum WalMutationFrame {
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
        self.interactive_revision > self.disk_saved_revision
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
        if interactive_revision > disk_saved_revision {
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
            if session.interactive_revision() > session.disk_saved_revision() {
                let resolved_path = session
                    .disk_path()
                    .and_then(|disk_p| {
                        if let Some(root) = workspace_root {
                            disk_p
                                .strip_prefix(root)
                                .ok()
                                .map(|rel| normalize_rel_path(&rel.to_string_lossy()))
                        } else {
                            Some(normalize_rel_path(&disk_p.to_string_lossy()))
                        }
                    })
                    .unwrap_or_else(|| normalize_rel_path(session.document_id()));

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

    /// Execute a hybrid `FTS5 (BM25)` + `Tree-sitter` AST symbol + dependency graph neighborhood search.
    ///
    /// Guarantees (`LOT-008`):
    /// 1. **100% Priority for Unsaved In-Memory Buffers:** Any file present in `UnsavedBufferOverlay`
    ///    (`interactive_revision > disk_saved_revision`) overrides disk-indexed SQLite rows for that path.
    /// 2. **Mandatory Pre-Export ACL & Secret Filtering:** Every candidate excerpt is checked against
    ///    `AclAndSecretScanner` before being returned.
    pub fn query_hybrid(&mut self, query: &str, limit: usize) -> Vec<ContextSearchHit> {
        if limit == 0 {
            return Vec::new();
        }
        let query_terms = tokenize_for_fts5(query);
        if query_terms.is_empty() {
            return Vec::new();
        }

        let unsaved_paths: BTreeSet<String> = self
            .overlay
            .entries()
            .values()
            .filter(|e| e.has_unsaved_changes())
            .map(|e| e.file_path.clone())
            .collect();

        // Build ephemeral sanitized chunks for all live unsaved buffers
        let mut live_chunks: Vec<(SqliteAstChunkRow, SqliteFtsChunkRow)> = Vec::new();
        let overlay_snapshot: Vec<UnsavedBufferEntry> = self
            .overlay
            .entries()
            .values()
            .filter(|e| e.has_unsaved_changes())
            .cloned()
            .collect();

        for entry in &overlay_snapshot {
            if self.scanner.check_path_acl(&entry.file_path).is_err() {
                continue;
            }
            let raw_text = entry.rope.to_string();
            let sanitized_doc = self.scanner.sanitize_text(&entry.file_path, &raw_text);
            let sanitized_rope = Rope::from_str(&sanitized_doc.sanitized_text);
            let language = SupportedAstLanguage::from_path(&entry.file_path);
            let provider = RopeTextProvider::new(&sanitized_rope);
            let tree = self.ast_parser.parse_with(language, &provider, None);
            let (_, chunks, fts_rows) = build_chunks_for_parsed_file(
                &entry.file_path,
                entry.interactive_revision,
                &entry.content_blake3_hash,
                &self.active_git_branch,
                language,
                &sanitized_rope,
                &tree,
            );
            for (c, f) in chunks.into_iter().zip(fts_rows) {
                live_chunks.push((c, f));
            }
        }

        // Collect candidate persisted chunk IDs via inverted postings (excluding shadowed `unsaved_paths`)
        let mut candidate_chunk_ids = BTreeSet::new();
        for term in &query_terms {
            if let Some(postings) = self.inverted_postings.get(term) {
                for chunk_id in postings {
                    candidate_chunk_ids.insert(chunk_id.clone());
                }
            }
            // Prefix match support for FTS5 queries
            if term.len() >= 3 {
                for (indexed_term, postings) in self.inverted_postings.range(term.clone()..) {
                    if !indexed_term.starts_with(term) {
                        break;
                    }
                    for chunk_id in postings {
                        candidate_chunk_ids.insert(chunk_id.clone());
                    }
                }
            }
        }

        let total_docs = (self
            .fts_chunks
            .values()
            .filter(|f| !unsaved_paths.contains(&f.file_path))
            .count()
            + live_chunks.len())
        .max(1) as f64;

        let avg_doc_len = if total_docs > 0.0 {
            let persisted_terms: u64 = self
                .fts_chunks
                .values()
                .filter(|f| !unsaved_paths.contains(&f.file_path))
                .map(|f| u64::from(f.total_terms))
                .sum();
            let live_terms: u64 = live_chunks
                .iter()
                .map(|(_, f)| u64::from(f.total_terms))
                .sum();
            ((persisted_terms + live_terms) as f64 / total_docs).max(1.0)
        } else {
            16.0
        };

        // Compute document frequency per query term across active corpus
        let mut doc_freq: BTreeMap<String, usize> = BTreeMap::new();
        for term in &query_terms {
            let mut df = 0usize;
            if let Some(postings) = self.inverted_postings.get(term) {
                df += postings
                    .iter()
                    .filter(|cid| {
                        self.ast_chunks
                            .get(*cid)
                            .map(|c| !unsaved_paths.contains(&c.file_path))
                            .unwrap_or(false)
                    })
                    .count();
            }
            df += live_chunks
                .iter()
                .filter(|(_, fts)| fts.term_frequencies.contains_key(term))
                .count();
            doc_freq.insert(term.clone(), df);
        }

        let mut scored_hits: Vec<ContextSearchHit> = Vec::new();
        let mut primary_matched_files: BTreeSet<String> = BTreeSet::new();

        // 1. Score live unsaved buffer chunks first
        for (chunk, fts) in &live_chunks {
            let bm25 = compute_okapi_bm25_score(
                &query_terms,
                query,
                chunk,
                fts,
                &doc_freq,
                total_docs,
                avg_doc_len,
            );
            if bm25 <= 0.0 {
                continue;
            }
            primary_matched_files.insert(chunk.file_path.clone());
            if let Some(hit) = self.build_search_hit(
                chunk,
                bm25,
                0.5, // live unsaved buffer freshness boost
                ExcerptFreshness::LiveUnsavedBuffer,
                true,
            ) {
                scored_hits.push(hit);
            }
        }

        // 2. Score persisted SQLite chunks for files NOT shadowed by an unsaved buffer
        for chunk_id in &candidate_chunk_ids {
            let Some(chunk) = self.ast_chunks.get(chunk_id).cloned() else {
                continue;
            };
            if unsaved_paths.contains(&chunk.file_path) {
                continue;
            }
            let Some(fts) = self.fts_chunks.get(chunk_id) else {
                continue;
            };
            let bm25 = compute_okapi_bm25_score(
                &query_terms,
                query,
                &chunk,
                fts,
                &doc_freq,
                total_docs,
                avg_doc_len,
            );
            if bm25 <= 0.0 {
                continue;
            }
            primary_matched_files.insert(chunk.file_path.clone());
            if let Some(hit) =
                self.build_search_hit(&chunk, bm25, 0.0, ExcerptFreshness::IndexedCommit, false)
            {
                scored_hits.push(hit);
            }
        }

        // 3. Graph neighborhood expansion (1-hop importers/targets of primary matched files)
        let mut neighbor_files: BTreeMap<String, f64> = BTreeMap::new();
        for edge in &self.symbol_edges {
            let weight = match edge.confidence {
                GraphEdgeConfidence::ExactSemantic => 1.5,
                GraphEdgeConfidence::SyntacticAst => 1.1,
                GraphEdgeConfidence::HeuristicText => 0.6,
            };
            if primary_matched_files.contains(&edge.target_file)
                && !primary_matched_files.contains(&edge.importer_file)
            {
                let entry = neighbor_files
                    .entry(edge.importer_file.clone())
                    .or_insert(0.0);
                if weight > *entry {
                    *entry = weight;
                }
            }
            if primary_matched_files.contains(&edge.importer_file)
                && !primary_matched_files.contains(&edge.target_file)
            {
                let entry = neighbor_files
                    .entry(edge.target_file.clone())
                    .or_insert(0.0);
                if weight > *entry {
                    *entry = weight;
                }
            }
        }

        // Boost existing hits that participate in graph edges
        for hit in &mut scored_hits {
            let has_edge = self.symbol_edges.iter().any(|e| {
                (e.importer_file == hit.excerpt.source_path
                    && primary_matched_files.contains(&e.target_file))
                    || (e.target_file == hit.excerpt.source_path
                        && primary_matched_files.contains(&e.importer_file))
            });
            if has_edge {
                hit.graph_boost += 0.75;
                hit.combined_score = hit.bm25_score + hit.graph_boost;
            }
        }

        // Add top exported symbol chunk from 1-hop neighbor files if we have room
        if scored_hits.len() < limit && !neighbor_files.is_empty() {
            for (neighbor_path, boost) in neighbor_files {
                if unsaved_paths.contains(&neighbor_path) {
                    if let Some((chunk, _)) = live_chunks
                        .iter()
                        .find(|(c, _)| c.file_path == neighbor_path && c.exported)
                    {
                        if let Some(hit) = self.build_search_hit(
                            chunk,
                            0.1,
                            boost,
                            ExcerptFreshness::LiveUnsavedBuffer,
                            true,
                        ) {
                            scored_hits.push(hit);
                        }
                    }
                } else if let Some(chunk) = self
                    .ast_chunks
                    .values()
                    .find(|c| c.file_path == neighbor_path && c.exported)
                    .cloned()
                {
                    if let Some(hit) = self.build_search_hit(
                        &chunk,
                        0.1,
                        boost,
                        ExcerptFreshness::IndexedCommit,
                        false,
                    ) {
                        scored_hits.push(hit);
                    }
                }
            }
        }

        scored_hits.sort_by(|a, b| {
            b.combined_score
                .partial_cmp(&a.combined_score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.excerpt.source_path.cmp(&b.excerpt.source_path))
                .then_with(|| a.excerpt.span_utf8.start.cmp(&b.excerpt.span_utf8.start))
        });
        scored_hits.truncate(limit);
        scored_hits
    }

    /// Assemble and export a `host_core::ContextBundle` with mandatory pre-export `AclAndSecretScanner`
    /// enforcement and token budget bounding (`LOT-008`).
    pub fn export_context_bundle(
        &mut self,
        bundle_id: impl Into<String>,
        query: &str,
        token_budget_max: u32,
        authorized_destination: AuthorizedDestination,
    ) -> ContextBundle {
        let hits = self.query_hybrid(query, 64);
        let mut excerpts = Vec::new();
        let mut token_budget_used = 0u32;
        let mut had_redactions = !self.scanner.audit_log().is_empty();

        for hit in hits {
            if self
                .scanner
                .check_path_acl(&hit.excerpt.source_path)
                .is_err()
            {
                continue;
            }
            let sanitized = self
                .scanner
                .sanitize_text(&hit.excerpt.source_path, &hit.excerpt.content);
            if sanitized.contains_redactions() {
                had_redactions = true;
            }
            let estimated_tokens = estimate_token_count(&sanitized.sanitized_text);
            if token_budget_used.saturating_add(estimated_tokens) > token_budget_max
                && !excerpts.is_empty()
            {
                break;
            }
            token_budget_used = token_budget_used.saturating_add(estimated_tokens);
            let mut safe_excerpt = hit.excerpt;
            safe_excerpt.content = sanitized.sanitized_text;
            excerpts.push(safe_excerpt);
        }

        let classification = if had_redactions {
            DataClassification::RestrictedFiltered
        } else {
            DataClassification::Internal
        };

        ContextBundle {
            schema_version: CONTRACT_SCHEMA_VERSION,
            bundle_id: bundle_id.into(),
            workspace_version: self.active_git_branch.clone(),
            excerpts,
            token_budget_used,
            token_budget_max,
            classification,
            authorized_destination,
            cache_control_prefix: Some(format!("branch:{}", self.active_git_branch)),
        }
    }

    fn build_search_hit(
        &mut self,
        chunk: &SqliteAstChunkRow,
        bm25_score: f64,
        graph_boost: f64,
        freshness: ExcerptFreshness,
        unsaved_buffer: bool,
    ) -> Option<ContextSearchHit> {
        // Pre-export ACL and secret filter check
        if self.scanner.check_path_acl(&chunk.file_path).is_err() {
            return None;
        }
        let sanitized = self
            .scanner
            .sanitize_text(&chunk.file_path, &chunk.sanitized_content);

        let confidence = if chunk.symbol_name.is_some() {
            ConfidenceLevel::ExactAstLsp
        } else {
            ConfidenceLevel::LexicalBm25
        };

        let excerpt = ContextExcerpt {
            source_path: chunk.file_path.clone(),
            document_revision: chunk.document_revision,
            content_blake3_hash: chunk.content_blake3_hash.clone(),
            span_utf8: chunk.span_utf8,
            start_line_col: chunk.start_line_col,
            end_line_col: chunk.end_line_col,
            content: sanitized.sanitized_text,
            confidence,
            freshness,
        };

        Some(ContextSearchHit {
            excerpt,
            unsaved_buffer,
            bm25_score,
            graph_boost,
            combined_score: bm25_score + graph_boost,
            symbol_name: chunk.symbol_name.clone(),
            symbol_kind: chunk.symbol_kind,
        })
    }

    fn index_file_internal(
        &mut self,
        relative_path: &str,
        document_revision: u32,
        raw_content: &str,
        write_wal: bool,
    ) -> Result<Option<SqliteFileRow>, ContextStorageError> {
        let norm_path = normalize_rel_path(relative_path);
        if self.scanner.check_path_acl(&norm_path).is_err() {
            // Ensure any previously indexed entries for this path are purged
            if self.files.remove(&norm_path).is_some() {
                self.remove_chunks_for_file(&norm_path);
                self.rebuild_impact_analyzer_from_chunks();
            }
            return Ok(None);
        }

        // Run AclAndSecretScanner BEFORE any SQLite insert or AST/FTS5 tokenization!
        let sanitized_doc = self.scanner.sanitize_text(&norm_path, raw_content);
        let sanitized_rope = Rope::from_str(&sanitized_doc.sanitized_text);
        let content_blake3_hash = compute_rope_blake3_hex(&sanitized_rope);
        let language = SupportedAstLanguage::from_path(&norm_path);

        let provider = RopeTextProvider::new(&sanitized_rope);
        let tree = self.ast_parser.parse_with(language, &provider, None);
        self.impact_analyzer
            .index_file(&norm_path, &sanitized_rope, &tree);

        let (file_row, chunks, fts_rows) = build_chunks_for_parsed_file(
            &norm_path,
            document_revision,
            &content_blake3_hash,
            &self.active_git_branch,
            language,
            &sanitized_rope,
            &tree,
        );

        self.remove_chunks_for_file(&norm_path);
        self.files.insert(norm_path, file_row.clone());

        for chunk in &chunks {
            self.ast_chunks
                .insert(chunk.chunk_id.clone(), chunk.clone());
        }
        for fts in &fts_rows {
            for term in fts.term_frequencies.keys() {
                self.inverted_postings
                    .entry(term.clone())
                    .or_default()
                    .insert(fts.chunk_id.clone());
            }
            self.total_fts_terms += u64::from(fts.total_terms);
            self.fts_chunks.insert(fts.chunk_id.clone(), fts.clone());
        }

        self.sync_symbol_edges_from_impact_analyzer();

        if write_wal {
            let frame = WalMutationFrame::FileIndexed {
                file_row: file_row.clone(),
                chunks,
                fts_rows,
                edges: self.symbol_edges.clone(),
            };
            self.append_wal_frame(&frame)?;
        }

        Ok(Some(file_row))
    }

    fn remove_chunks_for_file(&mut self, norm_path: &str) {
        let chunk_ids_to_remove: Vec<String> = self
            .ast_chunks
            .values()
            .filter(|c| c.file_path == norm_path)
            .map(|c| c.chunk_id.clone())
            .collect();

        for cid in chunk_ids_to_remove {
            self.ast_chunks.remove(&cid);
            if let Some(fts) = self.fts_chunks.remove(&cid) {
                self.total_fts_terms = self
                    .total_fts_terms
                    .saturating_sub(u64::from(fts.total_terms));
                for term in fts.term_frequencies.keys() {
                    if let Some(postings) = self.inverted_postings.get_mut(term) {
                        postings.remove(&cid);
                        if postings.is_empty() {
                            self.inverted_postings.remove(term);
                        }
                    }
                }
            }
        }
    }

    fn sync_symbol_edges_from_impact_analyzer(&mut self) {
        self.symbol_edges = self
            .impact_analyzer
            .edges()
            .iter()
            .map(|e| SqliteSymbolEdgeRow {
                importer_file: e.importer_file.clone(),
                target_file: e.target_file.clone(),
                imported_symbols: e.imported_symbols.clone(),
                confidence: e.confidence,
            })
            .collect();
    }

    fn rebuild_impact_analyzer_from_chunks(&mut self) {
        let mut next_analyzer = ImpactAnalyzer::new();
        for file_row in self.files.values() {
            let mut file_text = String::new();
            for chunk in self
                .ast_chunks
                .values()
                .filter(|c| c.file_path == file_row.file_path)
            {
                file_text.push_str(&chunk.sanitized_content);
                file_text.push('\n');
            }
            let rope = Rope::from_str(&file_text);
            let provider = RopeTextProvider::new(&rope);
            let tree = self
                .ast_parser
                .parse_with(file_row.language, &provider, None);
            next_analyzer.index_file(&file_row.file_path, &rope, &tree);
        }
        self.impact_analyzer = next_analyzer;
        self.sync_symbol_edges_from_impact_analyzer();
    }

    fn clear_all_tables(&mut self) {
        self.files.clear();
        self.ast_chunks.clear();
        self.symbol_edges.clear();
        self.fts_chunks.clear();
        self.inverted_postings.clear();
        self.total_fts_terms = 0;
        self.impact_analyzer = ImpactAnalyzer::new();
    }

    fn persist_full_snapshot(&self) -> Result<(), ContextStorageError> {
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

    fn append_wal_frame(&self, frame: &WalMutationFrame) -> Result<(), ContextStorageError> {
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

    fn load_snapshot_and_wal(&mut self) -> Result<String, ContextStorageError> {
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

    fn rebuild_inverted_postings(&mut self) {
        self.inverted_postings.clear();
        self.total_fts_terms = 0;
        for fts in self.fts_chunks.values() {
            self.total_fts_terms += u64::from(fts.total_terms);
            for term in fts.term_frequencies.keys() {
                self.inverted_postings
                    .entry(term.clone())
                    .or_default()
                    .insert(fts.chunk_id.clone());
            }
        }
    }
}

// ============================================================================
// Debounced Incremental Indexer (`300 ms` threshold on low-priority Tokio pool)
// ============================================================================

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

// ============================================================================
// Internal Chunking & Okapi BM25 (`FTS5`) Helpers
// ============================================================================

fn build_chunks_for_parsed_file(
    norm_path: &str,
    document_revision: u32,
    content_blake3_hash: &str,
    git_branch: &str,
    language: SupportedAstLanguage,
    sanitized_rope: &Rope,
    tree: &crate::ast_graph::SyntaxTree,
) -> (
    SqliteFileRow,
    Vec<SqliteAstChunkRow>,
    Vec<SqliteFtsChunkRow>,
) {
    let file_row = SqliteFileRow {
        file_path: norm_path.to_string(),
        document_revision,
        content_blake3_hash: content_blake3_hash.to_string(),
        language,
        is_test_file: is_test_file_path(norm_path),
        byte_len: sanitized_rope.len_bytes() as u32,
        line_count: sanitized_rope.len_lines() as u32,
        git_branch: git_branch.to_string(),
    };

    let mut chunks = Vec::new();
    let mut fts_rows = Vec::new();

    for (idx, node) in tree.nodes().iter().enumerate() {
        let start_b = node
            .span_utf8
            .start
            .as_usize()
            .min(sanitized_rope.len_bytes());
        let end_b = node
            .span_utf8
            .end
            .as_usize()
            .min(sanitized_rope.len_bytes());
        if start_b >= end_b {
            continue;
        }

        let slice = sanitized_rope.byte_slice(start_b..end_b);
        let mut raw_chunk_text = String::with_capacity(slice.len_bytes());
        for c in slice.chunks() {
            raw_chunk_text.push_str(c);
        }
        let trimmed = raw_chunk_text.trim();
        if trimmed.is_empty() {
            continue;
        }

        let (symbol_name, symbol_kind, exported, referenced_identifiers) = match &node.kind {
            crate::ast_graph::AstNodeKind::SymbolDeclaration {
                name,
                kind,
                exported,
                referenced_identifiers,
            } => (
                Some(name.clone()),
                Some(*kind),
                *exported,
                referenced_identifiers.clone(),
            ),
            crate::ast_graph::AstNodeKind::ImportStatement {
                imported_symbols, ..
            } => (None, None, false, imported_symbols.clone()),
            crate::ast_graph::AstNodeKind::ExportStatement {
                exported_symbols, ..
            } => (None, None, true, exported_symbols.clone()),
            _ => (None, None, false, Vec::new()),
        };

        let start_line_col = utf8_to_utf16(sanitized_rope, Utf8ByteOffset::new(start_b as u32))
            .and_then(|u16_off| utf16_to_line_col(sanitized_rope, u16_off))
            .unwrap_or_else(|_| LineCol::new(node.start_point.row, 0));
        let end_line_col = utf8_to_utf16(sanitized_rope, Utf8ByteOffset::new(end_b as u32))
            .and_then(|u16_off| utf16_to_line_col(sanitized_rope, u16_off))
            .unwrap_or_else(|_| LineCol::new(node.end_point.row, node.end_point.column));

        let chunk_id = format!("{norm_path}#{idx}:{}", node.span_utf8.start.as_u32());
        let mut combined_for_fts = String::with_capacity(trimmed.len() + norm_path.len() + 32);
        combined_for_fts.push_str(norm_path);
        combined_for_fts.push(' ');
        if let Some(sym) = &symbol_name {
            combined_for_fts.push_str(sym);
            combined_for_fts.push(' ');
        }
        combined_for_fts.push_str(trimmed);

        let tokens = tokenize_for_fts5(&combined_for_fts);
        if tokens.is_empty() {
            continue;
        }

        let mut term_frequencies: BTreeMap<String, u32> = BTreeMap::new();
        for tok in &tokens {
            *term_frequencies.entry(tok.clone()).or_insert(0) += 1;
        }
        let total_terms = tokens.len() as u32;

        chunks.push(SqliteAstChunkRow {
            chunk_id: chunk_id.clone(),
            file_path: norm_path.to_string(),
            document_revision,
            content_blake3_hash: content_blake3_hash.to_string(),
            symbol_name: symbol_name.clone(),
            symbol_kind,
            exported,
            span_utf8: node.span_utf8,
            start_line_col,
            end_line_col,
            node_blake3_hash: node.node_blake3_hash.clone(),
            sanitized_content: trimmed.to_string(),
            referenced_identifiers,
        });

        fts_rows.push(SqliteFtsChunkRow {
            chunk_id,
            file_path: norm_path.to_string(),
            symbol_name,
            tokenized_content: tokens.join(" "),
            term_frequencies,
            total_terms,
        });
    }

    (file_row, chunks, fts_rows)
}

/// Tokenize text using `unicode61`-style identifier & camelCase/snake_case splitting for `FTS5 (BM25)`.
#[must_use]
pub fn tokenize_for_fts5(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();

    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' {
            current.push(ch);
        } else if !current.is_empty() {
            push_expanded_token(&current, &mut tokens);
            current.clear();
        }
    }
    if !current.is_empty() {
        push_expanded_token(&current, &mut tokens);
    }

    tokens
}

fn push_expanded_token(raw: &str, out: &mut Vec<String>) {
    let trimmed = raw.trim_matches('.').trim_matches('_');
    if trimmed.is_empty() {
        return;
    }
    let lower_full = trimmed.to_ascii_lowercase();
    out.push(lower_full);

    // Also split snake_case, dot.separated, and camelCase sub-tokens for high recall
    for part in trimmed.split(['_', '.']) {
        if part.is_empty() {
            continue;
        }
        let part_lower = part.to_ascii_lowercase();
        if part_lower != trimmed.to_ascii_lowercase() {
            out.push(part_lower);
        }
        // Split camelCase / PascalCase boundaries
        let mut sub = String::new();
        let mut prev_lower = false;
        for ch in part.chars() {
            if ch.is_ascii_uppercase() && prev_lower && !sub.is_empty() {
                out.push(sub.to_ascii_lowercase());
                sub.clear();
            }
            prev_lower = ch.is_ascii_lowercase();
            sub.push(ch);
        }
        if !sub.is_empty() && sub.len() < part.len() {
            out.push(sub.to_ascii_lowercase());
        }
    }
}

fn compute_okapi_bm25_score(
    query_terms: &[String],
    raw_query: &str,
    chunk: &SqliteAstChunkRow,
    fts: &SqliteFtsChunkRow,
    doc_freq: &BTreeMap<String, usize>,
    total_docs: f64,
    avg_doc_len: f64,
) -> f64 {
    const K1: f64 = 1.2;
    const B: f64 = 0.75;

    let doc_len = f64::from(fts.total_terms.max(1));
    let mut score = 0.0;

    for term in query_terms {
        let mut tf = f64::from(*fts.term_frequencies.get(term).unwrap_or(&0));
        if tf == 0.0 && term.len() >= 3 {
            // Check prefix match in chunk terms
            for (chunk_term, &count) in &fts.term_frequencies {
                if chunk_term.starts_with(term) {
                    tf += f64::from(count) * 0.6;
                }
            }
        }
        if tf <= 0.0 {
            continue;
        }

        let df = *doc_freq.get(term).unwrap_or(&1) as f64;
        let idf = ((total_docs - df + 0.5) / (df + 0.5) + 1.0).ln();
        let numerator = tf * (K1 + 1.0);
        let denominator = tf + K1 * (1.0 - B + B * (doc_len / avg_doc_len));
        score += idf * (numerator / denominator);
    }

    if score > 0.0 {
        // Exact symbol name boost
        if let Some(sym) = &chunk.symbol_name {
            let sym_lower = sym.to_ascii_lowercase();
            let q_lower = raw_query.trim().to_ascii_lowercase();
            if sym_lower == q_lower {
                score += 4.0;
            } else if query_terms.iter().any(|t| t == &sym_lower) {
                score += 2.0;
            }
        }
        // Exact substring match boost in sanitized content
        let trimmed_query = raw_query.trim();
        if !trimmed_query.is_empty() && chunk.sanitized_content.contains(trimmed_query) {
            score += 1.5;
        }
    }

    score
}

fn estimate_token_count(text: &str) -> u32 {
    // Standard ~4 UTF-8 bytes per token heuristic (minimum 1 for non-empty excerpt)
    if text.is_empty() {
        0
    } else {
        (text.len() as u32).div_ceil(4).max(1)
    }
}

fn collect_workspace_files_recursively(
    workspace_root: &Path,
    current_dir: &Path,
    out: &mut Vec<String>,
) -> Result<(), ContextStorageError> {
    let entries = std::fs::read_dir(current_dir).map_err(|source| ContextStorageError::Io {
        path: current_dir.to_path_buf(),
        source,
    })?;

    for entry_res in entries {
        let entry = entry_res.map_err(|source| ContextStorageError::Io {
            path: current_dir.to_path_buf(),
            source,
        })?;
        let path = entry.path();
        let file_name = entry.file_name();
        let name_str = file_name.to_string_lossy();
        if name_str == ".git" || name_str == "node_modules" || name_str == "target" {
            continue;
        }
        if path.is_dir() {
            collect_workspace_files_recursively(workspace_root, &path, out)?;
        } else if path.is_file() {
            if let Ok(rel) = path.strip_prefix(workspace_root) {
                out.push(normalize_rel_path(&rel.to_string_lossy()));
            }
        }
    }
    Ok(())
}
