//! Hybrid search: FTS5-style BM25 ranking, AST symbol matches and graph neighbourhood boost (`LOT-008`).

use super::*;

impl SqliteWalContextEngine {
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
        // Restricted only when this bundle carries redacted text: indexed chunks were sanitized
        // when they were indexed (and keep the placeholder), excerpts re-scanned now may add more.
        let mut had_redactions = false;

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
            let estimated_tokens = estimate_token_count(&sanitized.sanitized_text);
            if token_budget_used.saturating_add(estimated_tokens) > token_budget_max {
                break;
            }
            token_budget_used = token_budget_used.saturating_add(estimated_tokens);
            if sanitized.contains_redactions()
                || sanitized.sanitized_text.contains(REDACTED_SECRET_MARKER)
            {
                had_redactions = true;
            }
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

    pub(super) fn build_search_hit(
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

        let rope = Rope::from_str(&sanitized.sanitized_text);
        let parsed = self.ast_parser.parse_with(
            SupportedAstLanguage::from_path(&chunk.file_path),
            &RopeTextProvider::new(&rope),
            None,
        );
        let confidence = if parsed.has_error() {
            ConfidenceLevel::HeuristicText
        } else if chunk.symbol_name.is_some() {
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

    pub(super) fn rebuild_inverted_postings(&mut self) {
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

pub(super) fn push_expanded_token(raw: &str, out: &mut Vec<String>) {
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

pub(super) fn compute_okapi_bm25_score(
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

pub(super) fn estimate_token_count(text: &str) -> u32 {
    // Standard ~4 UTF-8 bytes per token heuristic (minimum 1 for non-empty excerpt)
    if text.is_empty() {
        0
    } else {
        (text.len() as u32).div_ceil(4).max(1)
    }
}

impl SqliteWalContextEngine {
    pub(crate) fn context_chunks_for_path(&mut self, path: &str) -> Vec<SqliteAstChunkRow> {
        if self.scanner.check_path_acl(path).is_err() {
            return Vec::new();
        }
        if let Some(entry) = self.overlay.entries().get(path).cloned() {
            let text = self
                .scanner
                .sanitize_text(path, &entry.rope.to_string())
                .sanitized_text;
            let rope = Rope::from_str(&text);
            let language = SupportedAstLanguage::from_path(path);
            let tree = self
                .ast_parser
                .parse_with(language, &RopeTextProvider::new(&rope), None);
            return build_chunks_for_parsed_file(
                path,
                entry.interactive_revision,
                &entry.content_blake3_hash,
                &self.active_git_branch,
                language,
                &rope,
                &tree,
            )
            .1;
        }
        self.chunks_of_file(path).cloned().collect()
    }

    pub fn get_symbol_definition(&mut self, symbol: &str) -> Vec<ContextSearchHit> {
        // Exact symbol table lookup, without lexical ranking or a candidate cap.
        let mut chunks = self
            .ast_chunks
            .values()
            .filter(|c| {
                c.symbol_name.as_deref() == Some(symbol)
                    && !self.overlay.entries().contains_key(&c.file_path)
            })
            .cloned()
            .collect::<Vec<_>>();
        let paths = self.overlay.entries().keys().cloned().collect::<Vec<_>>();
        for path in paths {
            chunks.extend(
                self.context_chunks_for_path(&path)
                    .into_iter()
                    .filter(|c| c.symbol_name.as_deref() == Some(symbol)),
            );
        }
        chunks
            .iter()
            .filter_map(|c| {
                let live = self.overlay.entries().contains_key(&c.file_path);
                self.build_search_hit(
                    c,
                    0.0,
                    0.0,
                    if live {
                        ExcerptFreshness::LiveUnsavedBuffer
                    } else {
                        ExcerptFreshness::IndexedCommit
                    },
                    live,
                )
            })
            .collect()
    }

    #[cfg(feature = "vector")]
    pub(crate) fn vector_hit(
        &mut self,
        path: &str,
        key: &str,
        hash: &str,
        score: f64,
    ) -> Option<ContextSearchHit> {
        let chunk = if self.overlay.entries().contains_key(path) {
            self.context_chunks_for_path(path)
                .into_iter()
                .find(|c| c.chunk_id == key)
        } else {
            self.ast_chunks
                .get(key)
                .filter(|c| c.file_path == path)
                .cloned()
        }?;
        if blake3::hash(chunk.sanitized_content.as_bytes())
            .to_hex()
            .as_str()
            != hash
        {
            return None;
        }
        let live = self.overlay.entries().contains_key(path);
        let mut hit = self.build_search_hit(
            &chunk,
            0.0,
            0.0,
            if live {
                ExcerptFreshness::LiveUnsavedBuffer
            } else {
                ExcerptFreshness::IndexedCommit
            },
            live,
        )?;
        hit.combined_score = score;
        if hit.excerpt.confidence != ConfidenceLevel::HeuristicText {
            hit.excerpt.confidence = ConfidenceLevel::VectorSemantic;
        }
        Some(hit)
    }
}
