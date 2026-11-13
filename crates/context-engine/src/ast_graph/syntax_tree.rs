//! Symbols, AST nodes, the incremental `SyntaxTree` and its parser (`LOT-007`).

use super::*;

/// Categories of symbols extracted from the syntax tree (`LOT-007`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum SymbolKind {
    Function,
    ReactComponent,
    Class,
    Interface,
    TypeAlias,
    ConstOrVariable,
    CssSelector,
    JsonKey,
}

impl SymbolKind {
    #[must_use]
    pub const fn sexp_tag(self) -> &'static str {
        match self {
            Self::Function => "function_declaration",
            Self::ReactComponent => "react_component_declaration",
            Self::Class => "class_declaration",
            Self::Interface => "interface_declaration",
            Self::TypeAlias => "type_alias_declaration",
            Self::ConstOrVariable => "lexical_declaration",
            Self::CssSelector => "rule_set",
            Self::JsonKey => "pair",
        }
    }
}

/// AST node kinds inside a `SyntaxTree` (`LOT-007`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AstNodeKind {
    SymbolDeclaration {
        name: String,
        kind: SymbolKind,
        exported: bool,
        referenced_identifiers: Vec<String>,
    },
    ImportStatement {
        imported_symbols: Vec<String>,
        source_specifier: String,
    },
    ExportStatement {
        exported_symbols: Vec<String>,
        reexport_source: Option<String>,
    },
    Statement,
    CommentOrBlank,
    /// Isolated syntax error node (`ERROR` in Tree-sitter) preserving all surrounding valid symbols.
    Error {
        reason: String,
    },
}

/// A line-granular or block-granular syntactic node inside a `SyntaxTree`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AstNode {
    pub kind: AstNodeKind,
    pub span_utf8: Utf8Span,
    pub start_point: Point,
    pub end_point: Point,
    pub node_blake3_hash: String,
}

///Extracted symbol summary with byte/line ranges and `blake3` node hash (`LOT-007`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractedSymbol {
    pub name: String,
    pub kind: SymbolKind,
    pub exported: bool,
    pub span_utf8: Utf8Span,
    pub start_point: Point,
    pub end_point: Point,
    pub node_blake3_hash: String,
    pub referenced_identifiers: Vec<String>,
}

/// Extracted `import` statement edge from a parsed file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportDeclaration {
    pub imported_symbols: Vec<String>,
    pub source_specifier: String,
    pub span_utf8: Utf8Span,
}

/// Pending dirty line range tracked after `SyntaxTree::edit`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DirtyByteRange {
    start_byte: usize,
    new_end_byte: usize,
}

/// Incremental syntax tree backed by line-indexed AST nodes (`LOT-007`).
#[derive(Debug, Clone)]
pub struct SyntaxTree {
    pub language: SupportedAstLanguage,
    nodes: Vec<AstNode>,
    pending_edits: Vec<DirtyByteRange>,
}

impl SyntaxTree {
    #[must_use]
    pub fn nodes(&self) -> &[AstNode] {
        &self.nodes
    }

    #[must_use]
    pub fn has_error(&self) -> bool {
        self.nodes
            .iter()
            .any(|n| matches!(n.kind, AstNodeKind::Error { .. }))
    }

    #[must_use]
    pub fn error_count(&self) -> usize {
        self.nodes
            .iter()
            .filter(|n| matches!(n.kind, AstNodeKind::Error { .. }))
            .count()
    }

    /// Apply an `InputEdit` to the syntax tree (`Tree::edit` counterpart in `LOT-007`):
    /// shifts all nodes located strictly after `old_end_byte` and records the dirty byte window
    /// so `IncrementalAstParser::parse_with` only re-parses the affected lines.
    pub fn edit(&mut self, edit: &InputEdit) {
        let start_b = edit.start_byte.as_usize();
        let old_end_b = edit.old_end_byte.as_usize();
        let new_end_b = edit.new_end_byte.as_usize();
        let byte_delta = new_end_b as isize - old_end_b as isize;
        let row_delta = edit.new_end_position.row as isize - edit.old_end_position.row as isize;

        for node in &mut self.nodes {
            let n_start = node.span_utf8.start.as_usize();
            let n_end = node.span_utf8.end.as_usize();
            if n_start >= old_end_b {
                let shifted_start = (n_start as isize + byte_delta).max(0) as u32;
                let shifted_end = (n_end as isize + byte_delta).max(0) as u32;
                node.span_utf8 = Utf8Span::new(
                    Utf8ByteOffset::new(shifted_start),
                    Utf8ByteOffset::new(shifted_end),
                );
                node.start_point.row = (node.start_point.row as isize + row_delta).max(0) as u32;
                node.end_point.row = (node.end_point.row as isize + row_delta).max(0) as u32;
            }
        }

        // Also shift any previously recorded pending edits after `old_end_b`
        for pending in &mut self.pending_edits {
            if pending.start_byte >= old_end_b {
                pending.start_byte = (pending.start_byte as isize + byte_delta).max(0) as usize;
                pending.new_end_byte = (pending.new_end_byte as isize + byte_delta).max(0) as usize;
            } else if pending.new_end_byte >= start_b {
                pending.start_byte = pending.start_byte.min(start_b);
                pending.new_end_byte =
                    ((pending.new_end_byte as isize + byte_delta).max(0) as usize).max(new_end_b);
            }
        }

        self.pending_edits.push(DirtyByteRange {
            start_byte: start_b,
            new_end_byte: new_end_b,
        });
    }

    /// Format the syntax tree as a deterministic Tree-sitter S-expression (`(program ...)`).
    #[must_use]
    pub fn to_sexp(&self) -> String {
        let mut out = String::from("(program");
        for node in &self.nodes {
            match &node.kind {
                AstNodeKind::SymbolDeclaration {
                    name,
                    kind,
                    exported,
                    ..
                } => {
                    out.push_str(&format!(
                        " ({} name: (identifier \"{}\") exported: {} span: [{}, {}] hash: \"{}\")",
                        kind.sexp_tag(),
                        name,
                        exported,
                        node.span_utf8.start.as_u32(),
                        node.span_utf8.end.as_u32(),
                        &node.node_blake3_hash[..12]
                    ));
                }
                AstNodeKind::ImportStatement {
                    imported_symbols,
                    source_specifier,
                } => {
                    out.push_str(&format!(
                        " (import_statement symbols: {:?} source: \"{}\" span: [{}, {}])",
                        imported_symbols,
                        source_specifier,
                        node.span_utf8.start.as_u32(),
                        node.span_utf8.end.as_u32(),
                    ));
                }
                AstNodeKind::ExportStatement {
                    exported_symbols,
                    reexport_source,
                } => {
                    out.push_str(&format!(
                        " (export_statement symbols: {:?} source: {:?} span: [{}, {}])",
                        exported_symbols,
                        reexport_source,
                        node.span_utf8.start.as_u32(),
                        node.span_utf8.end.as_u32(),
                    ));
                }
                AstNodeKind::Statement => {
                    out.push_str(&format!(
                        " (statement span: [{}, {}] hash: \"{}\")",
                        node.span_utf8.start.as_u32(),
                        node.span_utf8.end.as_u32(),
                        &node.node_blake3_hash[..12]
                    ));
                }
                AstNodeKind::Error { reason } => {
                    out.push_str(&format!(
                        " (ERROR reason: \"{}\" span: [{}, {}])",
                        reason,
                        node.span_utf8.start.as_u32(),
                        node.span_utf8.end.as_u32(),
                    ));
                }
                AstNodeKind::CommentOrBlank => {}
            }
        }
        out.push(')');
        out
    }

    /// Extract all symbols from the syntax tree with their byte/line ranges and `blake3` hashes.
    #[must_use]
    pub fn symbols(&self) -> Vec<ExtractedSymbol> {
        self.nodes
            .iter()
            .filter_map(|node| match &node.kind {
                AstNodeKind::SymbolDeclaration {
                    name,
                    kind,
                    exported,
                    referenced_identifiers,
                } => Some(ExtractedSymbol {
                    name: name.clone(),
                    kind: *kind,
                    exported: *exported,
                    span_utf8: node.span_utf8,
                    start_point: node.start_point,
                    end_point: node.end_point,
                    node_blake3_hash: node.node_blake3_hash.clone(),
                    referenced_identifiers: referenced_identifiers.clone(),
                }),
                _ => None,
            })
            .collect()
    }

    /// Extract all import statements from the syntax tree.
    #[must_use]
    pub fn imports(&self) -> Vec<ImportDeclaration> {
        self.nodes
            .iter()
            .filter_map(|node| match &node.kind {
                AstNodeKind::ImportStatement {
                    imported_symbols,
                    source_specifier,
                } => Some(ImportDeclaration {
                    imported_symbols: imported_symbols.clone(),
                    source_specifier: source_specifier.clone(),
                    span_utf8: node.span_utf8,
                }),
                _ => None,
            })
            .collect()
    }

    /// Retrieve all identifier calls/references across the entire file (including inside statements and tests).
    #[must_use]
    pub fn all_referenced_identifiers(&self, rope: &Rope) -> BTreeSet<String> {
        let mut refs = BTreeSet::new();
        for node in &self.nodes {
            match &node.kind {
                AstNodeKind::SymbolDeclaration {
                    referenced_identifiers,
                    ..
                } => {
                    for id in referenced_identifiers {
                        refs.insert(id.clone());
                    }
                }
                AstNodeKind::Statement => {
                    let start = node.span_utf8.start.as_usize().min(rope.len_bytes());
                    let end = node.span_utf8.end.as_usize().min(rope.len_bytes());
                    if start < end {
                        let slice = rope.byte_slice(start..end);
                        let mut text = String::with_capacity(slice.len_bytes());
                        for chunk in slice.chunks() {
                            text.push_str(chunk);
                        }
                        for id in extract_identifier_tokens(&text) {
                            refs.insert(id);
                        }
                    }
                }
                _ => {}
            }
        }
        refs
    }
}

/// Incremental AST parser reading directly from `RopeTextProvider` (`LOT-007`).
#[derive(Debug, Default)]
pub struct IncrementalAstParser {
    last_reparse_line_count: usize,
}

impl IncrementalAstParser {
    #[must_use]
    pub fn new() -> Self {
        Self {
            last_reparse_line_count: 0,
        }
    }

    #[must_use]
    pub const fn last_reparse_line_count(&self) -> usize {
        self.last_reparse_line_count
    }

    /// Parse or incrementally re-parse a `ropey::Rope` via `RopeTextProvider`.
    /// When `old_tree` is provided with `InputEdit`s, only the dirty line range is re-parsed
    /// and spliced into the existing node list (`p95 < 5 ms`, 100% equivalent to cold parse).
    pub fn parse_with(
        &mut self,
        language: SupportedAstLanguage,
        provider: &RopeTextProvider<'_>,
        old_tree: Option<&SyntaxTree>,
    ) -> SyntaxTree {
        let rope = provider.rope();
        let total_lines = rope.len_lines();

        if let Some(prev) = old_tree {
            if prev.language == language && !prev.pending_edits.is_empty() {
                let min_dirty_byte = prev
                    .pending_edits
                    .iter()
                    .map(|e| e.start_byte)
                    .min()
                    .unwrap_or(0)
                    .min(rope.len_bytes());
                let max_dirty_byte = prev
                    .pending_edits
                    .iter()
                    .map(|e| e.new_end_byte)
                    .max()
                    .unwrap_or(rope.len_bytes())
                    .min(rope.len_bytes());

                let dirty_start_line = rope.byte_to_line(min_dirty_byte);
                let dirty_end_line = (rope.byte_to_line(max_dirty_byte) + 1).min(total_lines);

                let dirty_line_start_byte = rope.line_to_byte(dirty_start_line);
                let dirty_line_end_byte = if dirty_end_line < total_lines {
                    rope.line_to_byte(dirty_end_line)
                } else {
                    rope.len_bytes()
                };

                let prefix_end_idx = prev
                    .nodes
                    .partition_point(|n| n.span_utf8.end.as_usize() <= dirty_line_start_byte);
                let suffix_start_idx = prev
                    .nodes
                    .partition_point(|n| n.span_utf8.start.as_usize() < dirty_line_end_byte);

                let mut nodes = Vec::with_capacity(
                    prefix_end_idx
                        + (dirty_end_line - dirty_start_line)
                        + prev.nodes.len().saturating_sub(suffix_start_idx),
                );
                nodes.extend_from_slice(&prev.nodes[..prefix_end_idx]);

                for line_idx in dirty_start_line..dirty_end_line {
                    nodes.push(parse_single_rope_line(language, provider, line_idx));
                }

                if suffix_start_idx < prev.nodes.len() {
                    nodes.extend_from_slice(&prev.nodes[suffix_start_idx..]);
                }

                self.last_reparse_line_count = dirty_end_line - dirty_start_line;
                return SyntaxTree {
                    language,
                    nodes,
                    pending_edits: Vec::new(),
                };
            }
        }

        let mut nodes = Vec::with_capacity(total_lines);
        for line_idx in 0..total_lines {
            nodes.push(parse_single_rope_line(language, provider, line_idx));
        }
        self.last_reparse_line_count = total_lines;

        SyntaxTree {
            language,
            nodes,
            pending_edits: Vec::new(),
        }
    }
}
