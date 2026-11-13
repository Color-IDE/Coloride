//! Local dependency graph and test impact analysis (`LOT-007`).

use super::*;

/// Explicit confidence level on every edge in the local dependency graph (`LOT-007`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum GraphEdgeConfidence {
    /// Highest confidence: resolved via exact semantic/LSP binding.
    ExactSemantic,
    /// Resolved via syntactic Tree-sitter AST `import`/`export` and symbol reference matching.
    SyntacticAst,
    /// Resolved via heuristic text or naming convention (e.g. `money.ts` ↔ `money.test.ts`).
    HeuristicText,
}

impl GraphEdgeConfidence {
    /// Map to canonical `host_core::ConfidenceLevel` contract (`LOT-002`).
    #[must_use]
    pub const fn to_contract_confidence(self) -> ConfidenceLevel {
        match self {
            Self::ExactSemantic => ConfidenceLevel::ExactAstLsp,
            Self::SyntacticAst => ConfidenceLevel::ExactAstLsp,
            Self::HeuristicText => ConfidenceLevel::HeuristicText,
        }
    }
}

/// Directed dependency edge from `importer_file` to `target_file` (`LOT-007`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DependencyEdge {
    pub importer_file: String,
    pub target_file: String,
    pub imported_symbols: Vec<String>,
    pub confidence: GraphEdgeConfidence,
}

/// Indexed file record inside `ImpactAnalyzer`.
#[derive(Debug, Clone)]
pub struct IndexedWorkspaceFile {
    pub path: String,
    pub is_test_file: bool,
    pub symbols: Vec<ExtractedSymbol>,
    pub imports: Vec<ImportDeclaration>,
    pub referenced_identifiers: BTreeSet<String>,
    pub has_syntax_error: bool,
}

/// Impacted test file returned by `ImpactAnalyzer::find_impacted_tests` (`LOT-007`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TestFileTarget {
    pub test_file_path: String,
    pub matched_symbols: Vec<String>,
    pub hop_distance: u32,
    pub confidence: GraphEdgeConfidence,
}

#[derive(Debug, Error)]
pub enum AstEngineError {
    #[error("Offset conversion error: {0}")]
    Offset(#[from] OffsetConversionError),
}

/// Determine whether a repository file path is a test file (`*.test.ts(x)` / `*.spec.ts(x)` / `__tests__/`).
#[must_use]
pub fn is_test_file_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".test.ts")
        || lower.ends_with(".test.tsx")
        || lower.ends_with(".spec.ts")
        || lower.ends_with(".spec.tsx")
        || lower.ends_with(".test.js")
        || lower.ends_with(".spec.js")
        || lower.contains("/__tests__/")
}

pub(super) fn normalize_repo_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let mut stack: Vec<&str> = Vec::new();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            stack.pop();
        } else {
            stack.push(part);
        }
    }
    stack.join("/")
}

pub(super) fn resolve_import_specifier(
    importer_path: &str,
    specifier: &str,
    known_files: &BTreeMap<String, IndexedWorkspaceFile>,
) -> Option<String> {
    let importer_dir = importer_path
        .rsplit_once('/')
        .map(|(dir, _)| dir)
        .unwrap_or("");
    let raw_joined = if specifier.starts_with('.') {
        if importer_dir.is_empty() {
            specifier.to_string()
        } else {
            format!("{importer_dir}/{specifier}")
        }
    } else {
        specifier.to_string()
    };

    let base = normalize_repo_path(&raw_joined);
    let stripped = base
        .strip_suffix(".js")
        .or_else(|| base.strip_suffix(".jsx"))
        .unwrap_or(&base);

    let candidates = [
        base.clone(),
        format!("{stripped}.ts"),
        format!("{stripped}.tsx"),
        format!("{stripped}.js"),
        format!("{stripped}/index.ts"),
        format!("{stripped}/index.tsx"),
    ];

    candidates
        .into_iter()
        .find(|cand| known_files.contains_key(cand))
}

/// Workspace AST Symbol Graph & Test Impact Analyzer (`LOT-007`).
#[derive(Debug, Default, Clone)]
pub struct ImpactAnalyzer {
    files: BTreeMap<String, IndexedWorkspaceFile>,
    edges: Vec<DependencyEdge>,
}

impl ImpactAnalyzer {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Index or update a workspace file from its `Rope` and `SyntaxTree`.
    pub fn index_file(&mut self, path: &str, rope: &Rope, tree: &SyntaxTree) {
        let normalized_path = normalize_repo_path(path);
        let symbols = tree.symbols();
        let imports = tree.imports();
        let referenced_identifiers = tree.all_referenced_identifiers(rope);

        self.files.insert(
            normalized_path,
            IndexedWorkspaceFile {
                path: normalize_repo_path(path),
                is_test_file: is_test_file_path(path),
                symbols,
                imports,
                referenced_identifiers,
                has_syntax_error: tree.has_error(),
            },
        );
        self.rebuild_dependency_edges();
    }

    #[must_use]
    pub fn files(&self) -> &BTreeMap<String, IndexedWorkspaceFile> {
        &self.files
    }

    #[must_use]
    pub fn edges(&self) -> &[DependencyEdge] {
        &self.edges
    }

    /// Upgrade an existing edge's confidence level to `ExactSemantic` (e.g. when enriched by `vtsls` in `LOT-010`).
    pub fn upgrade_edge_confidence(
        &mut self,
        importer_file: &str,
        target_file: &str,
        confidence: GraphEdgeConfidence,
    ) {
        let imp = normalize_repo_path(importer_file);
        let tgt = normalize_repo_path(target_file);
        for edge in &mut self.edges {
            if edge.importer_file == imp && edge.target_file == tgt {
                edge.confidence = confidence;
            }
        }
    }

    fn rebuild_dependency_edges(&mut self) {
        let mut next_edges = Vec::new();
        for file in self.files.values() {
            for imp in &file.imports {
                if let Some(target_file) =
                    resolve_import_specifier(&file.path, &imp.source_specifier, &self.files)
                {
                    next_edges.push(DependencyEdge {
                        importer_file: file.path.clone(),
                        target_file,
                        imported_symbols: imp.imported_symbols.clone(),
                        confidence: GraphEdgeConfidence::SyntacticAst,
                    });
                }
            }

            // Also add HeuristicText edge if this is a test file matching stem name (e.g. `money.test.ts` -> `money.ts`)
            if file.is_test_file {
                let file_stem = file
                    .path
                    .rsplit_once('/')
                    .map(|(_, f)| f)
                    .unwrap_or(&file.path)
                    .split('.')
                    .next()
                    .unwrap_or("");
                if !file_stem.is_empty() {
                    for candidate in self.files.values() {
                        if candidate.is_test_file || candidate.path == file.path {
                            continue;
                        }
                        let cand_stem = candidate
                            .path
                            .rsplit_once('/')
                            .map(|(_, f)| f)
                            .unwrap_or(&candidate.path)
                            .split('.')
                            .next()
                            .unwrap_or("");
                        if cand_stem == file_stem
                            && !next_edges.iter().any(|e| {
                                e.importer_file == file.path && e.target_file == candidate.path
                            })
                        {
                            next_edges.push(DependencyEdge {
                                importer_file: file.path.clone(),
                                target_file: candidate.path.clone(),
                                imported_symbols: Vec::new(),
                                confidence: GraphEdgeConfidence::HeuristicText,
                            });
                        }
                    }
                }
            }
        }
        self.edges = next_edges;
    }

    /// Compute the impacted test files (`*.test.ts(x)` / `*.spec.ts(x)`) covering `modified_symbols`
    /// directly or transitively up to `max_depth` hops (`LOT-007`).
    #[must_use]
    pub fn find_impacted_tests(
        &self,
        modified_symbols: &[(&str, &str)],
        max_depth: u32,
    ) -> Vec<TestFileTarget> {
        let mut queue: VecDeque<(String, Vec<String>, u32, GraphEdgeConfidence)> = VecDeque::new();
        let mut visited_files: BTreeMap<String, u32> = BTreeMap::new();
        let mut impacted_tests: BTreeMap<String, TestFileTarget> = BTreeMap::new();

        for (file_path, symbol_name) in modified_symbols {
            let norm_file = normalize_repo_path(file_path);
            visited_files.insert(norm_file.clone(), 0);
            queue.push_back((
                norm_file,
                vec![(*symbol_name).to_string()],
                0,
                GraphEdgeConfidence::SyntacticAst,
            ));
        }

        while let Some((current_file, active_symbols, depth, path_confidence)) = queue.pop_front() {
            if depth >= max_depth {
                continue;
            }

            for edge in &self.edges {
                if edge.target_file != current_file {
                    continue;
                }
                let importer = &edge.importer_file;
                let next_depth = depth + 1;

                // Check if importer imports any of the modified symbols (or wildcard / default import / heuristic)
                let symbol_matched = edge.imported_symbols.is_empty()
                    || active_symbols
                        .iter()
                        .any(|sym| edge.imported_symbols.contains(sym))
                    || self
                        .files
                        .get(importer)
                        .map(|f| {
                            active_symbols
                                .iter()
                                .any(|sym| f.referenced_identifiers.contains(sym))
                        })
                        .unwrap_or(false);

                if !symbol_matched {
                    continue;
                }

                let combined_confidence = path_confidence.max(edge.confidence);

                if let Some(importer_meta) = self.files.get(importer) {
                    if importer_meta.is_test_file {
                        impacted_tests
                            .entry(importer.clone())
                            .and_modify(|existing| {
                                for s in &active_symbols {
                                    if !existing.matched_symbols.contains(s) {
                                        existing.matched_symbols.push(s.clone());
                                    }
                                }
                                if next_depth < existing.hop_distance {
                                    existing.hop_distance = next_depth;
                                }
                                if combined_confidence < existing.confidence {
                                    existing.confidence = combined_confidence;
                                }
                            })
                            .or_insert_with(|| TestFileTarget {
                                test_file_path: importer.clone(),
                                matched_symbols: active_symbols.clone(),
                                hop_distance: next_depth,
                                confidence: combined_confidence,
                            });
                    } else {
                        let should_visit = visited_files
                            .get(importer)
                            .map(|&prev_d| next_depth < prev_d)
                            .unwrap_or(true);
                        if should_visit {
                            visited_files.insert(importer.clone(), next_depth);
                            let exported_from_importer: Vec<String> = importer_meta
                                .symbols
                                .iter()
                                .filter(|s| s.exported)
                                .map(|s| s.name.clone())
                                .collect();
                            let next_symbols = if exported_from_importer.is_empty() {
                                active_symbols.clone()
                            } else {
                                exported_from_importer
                            };
                            queue.push_back((
                                importer.clone(),
                                next_symbols,
                                next_depth,
                                combined_confidence,
                            ));
                        }
                    }
                }
            }
        }

        let mut results: Vec<TestFileTarget> = impacted_tests.into_values().collect();
        results.sort_by(|a, b| {
            a.hop_distance
                .cmp(&b.hop_distance)
                .then_with(|| a.confidence.cmp(&b.confidence))
                .then_with(|| a.test_file_path.cmp(&b.test_file_path))
        });
        results
    }
}
