//! Turning workspace files into chunk, FTS and symbol-edge rows (`LOT-008`).

use super::*;

impl SqliteWalContextEngine {
    pub(super) fn index_file_internal(
        &mut self,
        relative_path: &str,
        document_revision: u32,
        raw_content: &str,
        write_wal: bool,
    ) -> Result<Option<SqliteFileRow>, ContextStorageError> {
        let norm_path = normalize_rel_path(relative_path);
        self.vector_changes.mark(Some(norm_path.clone()));
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

    /// The chunks of one file. Chunk ids start with `"{file_path}#"` and the table is ordered, so
    /// this is a range scan, not a pass over every chunk of the workspace.
    pub(super) fn chunks_of_file<'a>(
        &'a self,
        norm_path: &'a str,
    ) -> impl Iterator<Item = &'a SqliteAstChunkRow> + 'a {
        let prefix = format!("{norm_path}#");
        self.ast_chunks
            .range(prefix.clone()..)
            .take_while(move |(id, _)| id.starts_with(&prefix))
            .map(|(_, chunk)| chunk)
            // A file literally named "a.ts#b" shares the prefix of "a.ts".
            .filter(move |chunk| chunk.file_path == norm_path)
    }

    pub(super) fn remove_chunks_for_file(&mut self, norm_path: &str) {
        let chunk_ids_to_remove: Vec<String> = self
            .chunks_of_file(norm_path)
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

    pub(super) fn sync_symbol_edges_from_impact_analyzer(&mut self) {
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

    pub(super) fn rebuild_impact_analyzer_from_chunks(&mut self) {
        let mut next_analyzer = ImpactAnalyzer::new();
        for file_row in self.files.values() {
            let mut file_text = String::new();
            for chunk in self.chunks_of_file(&file_row.file_path) {
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

    pub(super) fn clear_all_tables(&mut self) {
        self.vector_changes.mark(None);
        self.files.clear();
        self.ast_chunks.clear();
        self.symbol_edges.clear();
        self.fts_chunks.clear();
        self.inverted_postings.clear();
        self.total_fts_terms = 0;
        self.impact_analyzer = ImpactAnalyzer::new();
    }
}

pub(super) fn build_chunks_for_parsed_file(
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

/// Every file under `workspace_root`, as normalized relative paths.
///
/// Symbolic links are never followed: a link cycle would recurse forever and a link may point
/// outside the workspace. A subdirectory that cannot be read (permissions, removed meanwhile) is
/// skipped instead of failing the whole index; only an unreadable root is an error.
pub(super) fn collect_workspace_files_recursively(
    workspace_root: &Path,
    current_dir: &Path,
    out: &mut Vec<String>,
) -> Result<(), ContextStorageError> {
    let entries = std::fs::read_dir(current_dir).map_err(|source| ContextStorageError::Io {
        path: current_dir.to_path_buf(),
        source,
    })?;

    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == ".git" || name == "node_modules" || name == "target" {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            // Errors below the root only lose that subtree.
            let _ = collect_workspace_files_recursively(workspace_root, &path, out);
        } else if file_type.is_file() {
            if let Ok(rel) = path.strip_prefix(workspace_root) {
                out.push(normalize_rel_path(&rel.to_string_lossy()));
            }
        }
    }
    Ok(())
}
