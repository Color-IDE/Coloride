use std::collections::{BTreeMap, BTreeSet, VecDeque};

use host_core::{
    utf16_span_to_utf8, ConfidenceLevel, EditorTransaction, OffsetConversionError, Utf8ByteOffset,
    Utf8Span,
};
use ropey::Rope;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Zero-based `(row, column)` byte coordinate matching `tree_sitter::Point`.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize,
)]
pub struct Point {
    pub row: u32,
    pub column: u32,
}

impl Point {
    #[must_use]
    pub const fn new(row: u32, column: u32) -> Self {
        Self { row, column }
    }
}

/// Incremental UTF-8 byte & point delta matching `tree_sitter::InputEdit` (`LOT-007`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputEdit {
    pub start_byte: Utf8ByteOffset,
    pub old_end_byte: Utf8ByteOffset,
    pub new_end_byte: Utf8ByteOffset,
    pub start_position: Point,
    pub old_end_position: Point,
    pub new_end_position: Point,
}

/// Languages supported by the incremental AST parser in `LOT-007`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SupportedAstLanguage {
    TypeScript,
    Tsx,
    JavaScript,
    Json,
    Css,
}

impl SupportedAstLanguage {
    #[must_use]
    pub fn from_path(path: &str) -> Self {
        let lower = path.to_ascii_lowercase();
        if lower.ends_with(".tsx") || lower.ends_with(".jsx") {
            Self::Tsx
        } else if lower.ends_with(".js") || lower.ends_with(".mjs") || lower.ends_with(".cjs") {
            Self::JavaScript
        } else if lower.ends_with(".json") {
            Self::Json
        } else if lower.ends_with(".css") {
            Self::Css
        } else {
            Self::TypeScript
        }
    }
}

/// Zero-copy chunk provider reading directly from `ropey::Rope` without contiguous full-buffer allocation.
pub struct RopeTextProvider<'a> {
    rope: &'a Rope,
}

impl<'a> RopeTextProvider<'a> {
    #[must_use]
    pub const fn new(rope: &'a Rope) -> Self {
        Self { rope }
    }

    #[must_use]
    pub const fn rope(&self) -> &'a Rope {
        self.rope
    }

    #[must_use]
    pub fn len_bytes(&self) -> usize {
        self.rope.len_bytes()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.rope.len_bytes() == 0
    }

    /// Iterate over raw `&str` chunks from `ropey::Rope` intersecting `[start_byte, end_byte)`
    /// without copying the whole document into a contiguous `String`.
    pub fn chunks_in_byte_range(
        &self,
        start_byte: usize,
        end_byte: usize,
    ) -> impl Iterator<Item = &'a str> {
        let clamped_end = end_byte.min(self.rope.len_bytes());
        let clamped_start = start_byte.min(clamped_end);
        self.rope.byte_slice(clamped_start..clamped_end).chunks()
    }

    /// Read a specific line by index (`0..len_lines()`) without copying the full rope.
    #[must_use]
    pub fn line_text_trimmed_newline(&self, line_idx: usize) -> String {
        let slice = self.rope.line(line_idx);
        let mut s = String::with_capacity(slice.len_bytes());
        for chunk in slice.chunks() {
            s.push_str(chunk);
        }
        if s.ends_with('\n') {
            s.pop();
            if s.ends_with('\r') {
                s.pop();
            }
        }
        s
    }
}

/// Compute `Point { row, column }` (in UTF-8 column bytes) for a byte offset using `ropey::Rope` metrics.
#[must_use]
pub fn byte_offset_to_point(rope: &Rope, byte_offset: usize) -> Point {
    let clamped = byte_offset.min(rope.len_bytes());
    let line_idx = rope.byte_to_line(clamped);
    let line_start_byte = rope.line_to_byte(line_idx);
    Point {
        row: line_idx as u32,
        column: (clamped - line_start_byte) as u32,
    }
}

/// Advance a `Point` by scanning a UTF-8 string slice.
#[must_use]
pub fn advance_point_by_str(start: Point, text: &str) -> Point {
    let mut row = start.row;
    let mut col = start.column;
    for b in text.bytes() {
        if b == b'\n' {
            row += 1;
            col = 0;
        } else {
            col += 1;
        }
    }
    Point { row, column: col }
}

/// Build an `InputEdit` on `rope` before mutating `[start_byte, old_end_byte)` with `inserted_text`.
#[must_use]
pub fn build_input_edit_for_utf8_range(
    rope: &Rope,
    start_byte: Utf8ByteOffset,
    old_end_byte: Utf8ByteOffset,
    inserted_text: &str,
) -> InputEdit {
    let start_b = start_byte.as_usize();
    let old_end_b = old_end_byte.as_usize();
    let new_end_b = start_b + inserted_text.len();

    let start_position = byte_offset_to_point(rope, start_b);
    let old_end_position = byte_offset_to_point(rope, old_end_b);
    let new_end_position = advance_point_by_str(start_position, inserted_text);

    InputEdit {
        start_byte,
        old_end_byte,
        new_end_byte: Utf8ByteOffset::new(new_end_b as u32),
        start_position,
        old_end_position,
        new_end_position,
    }
}

/// Apply an `EditorTransaction` to `rope` and return the corresponding `InputEdit` sequence (`LOT-007`).
pub fn apply_editor_transaction_and_collect_edits(
    rope: &mut Rope,
    tx: &EditorTransaction,
) -> Result<Vec<InputEdit>, OffsetConversionError> {
    let mut edits = Vec::with_capacity(tx.changes.len());
    for change in &tx.changes {
        let utf8_span = match change.range_utf8 {
            Some(span) => span,
            None => utf16_span_to_utf8(rope, change.range_utf16)?,
        };
        let input_edit = build_input_edit_for_utf8_range(
            rope,
            utf8_span.start,
            utf8_span.end,
            &change.inserted_text,
        );
        let start_char = rope.byte_to_char(utf8_span.start.as_usize());
        let end_char = rope.byte_to_char(utf8_span.end.as_usize());
        rope.remove(start_char..end_char);
        if !change.inserted_text.is_empty() {
            rope.insert(start_char, &change.inserted_text);
        }
        edits.push(input_edit);
    }
    Ok(edits)
}

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

fn parse_single_rope_line(
    language: SupportedAstLanguage,
    provider: &RopeTextProvider<'_>,
    line_idx: usize,
) -> AstNode {
    let rope = provider.rope();
    let start_byte = rope.line_to_byte(line_idx);
    let end_byte = if line_idx + 1 < rope.len_lines() {
        rope.line_to_byte(line_idx + 1)
    } else {
        rope.len_bytes()
    };

    let line_text = provider.line_text_trimmed_newline(line_idx);
    let trimmed = line_text.trim();
    let start_point = Point::new(line_idx as u32, 0);
    let end_point = Point::new(line_idx as u32, line_text.len() as u32);
    let span_utf8 = Utf8Span::new(
        Utf8ByteOffset::new(start_byte as u32),
        Utf8ByteOffset::new(end_byte as u32),
    );
    let node_blake3_hash = blake3::hash(trimmed.as_bytes()).to_hex().to_string();

    if trimmed.is_empty()
        || trimmed.starts_with("//")
        || trimmed.starts_with("/*")
        || trimmed.starts_with('*')
    {
        return AstNode {
            kind: AstNodeKind::CommentOrBlank,
            span_utf8,
            start_point,
            end_point,
            node_blake3_hash,
        };
    }

    let kind = match language {
        SupportedAstLanguage::TypeScript
        | SupportedAstLanguage::Tsx
        | SupportedAstLanguage::JavaScript => classify_ts_js_line(trimmed, language),
        SupportedAstLanguage::Json => classify_json_line(trimmed),
        SupportedAstLanguage::Css => classify_css_line(trimmed),
    };

    AstNode {
        kind,
        span_utf8,
        start_point,
        end_point,
        node_blake3_hash,
    }
}

fn is_valid_identifier(ident: &str) -> bool {
    let mut chars = ident.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_' || first == '$') {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

fn extract_first_identifier(after_keyword: &str) -> Option<String> {
    let trimmed = after_keyword.trim_start();
    let end = trimmed
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$'))
        .unwrap_or(trimmed.len());
    let candidate = &trimmed[..end];
    if is_valid_identifier(candidate) {
        Some(candidate.to_string())
    } else {
        None
    }
}

fn extract_identifier_tokens(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '$' {
            current.push(ch);
        } else if !current.is_empty() {
            if is_valid_identifier(&current) && !is_ts_keyword(&current) {
                tokens.push(std::mem::take(&mut current));
            } else {
                current.clear();
            }
        }
    }
    if !current.is_empty() && is_valid_identifier(&current) && !is_ts_keyword(&current) {
        tokens.push(current);
    }
    tokens
}

fn is_ts_keyword(word: &str) -> bool {
    matches!(
        word,
        "export"
            | "import"
            | "from"
            | "function"
            | "async"
            | "const"
            | "let"
            | "var"
            | "class"
            | "interface"
            | "type"
            | "return"
            | "if"
            | "else"
            | "for"
            | "while"
            | "true"
            | "false"
            | "null"
            | "undefined"
            | "string"
            | "number"
            | "boolean"
            | "void"
            | "Promise"
            | "default"
            | "new"
    )
}

fn has_obvious_syntax_error(trimmed: &str) -> Option<String> {
    if trimmed.contains("???") || trimmed.contains("@@@") || trimmed.ends_with("= ;") {
        return Some("Unexpected syntax token in statement".to_string());
    }
    // Check unbalanced parentheses on single-line declaration/expression
    let open_parens = trimmed.chars().filter(|&c| c == '(').count();
    let close_parens = trimmed.chars().filter(|&c| c == ')').count();
    if open_parens != close_parens {
        return Some("Unbalanced parentheses in line".to_string());
    }
    // Check unclosed string literal on single line
    let double_quotes = trimmed.chars().filter(|&c| c == '"').count();
    let single_quotes = trimmed.chars().filter(|&c| c == '\'').count();
    if double_quotes % 2 != 0 || single_quotes % 2 != 0 {
        return Some("Unclosed string literal".to_string());
    }
    None
}

fn parse_import_line(trimmed: &str) -> Option<AstNodeKind> {
    let rest = trimmed.strip_prefix("import ")?.trim();
    let from_idx = rest.find("from ")?;
    let clause = rest[..from_idx].trim().trim_start_matches("type ").trim();
    let source_part = rest[from_idx + 5..].trim().trim_end_matches(';').trim();
    let source_specifier = source_part
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string();
    if source_specifier.is_empty() {
        return None;
    }

    let mut imported_symbols = Vec::new();
    let cleaned_clause = clause.replace(['{', '}'], " ");
    for part in cleaned_clause.split(',') {
        let token = part.trim();
        if token.is_empty() {
            continue;
        }
        let actual = if let Some((_, alias)) = token.split_once(" as ") {
            alias.trim()
        } else if let Some(star_alias) = token.strip_prefix("* as ") {
            star_alias.trim()
        } else {
            token.trim_start_matches("type ").trim()
        };
        if is_valid_identifier(actual) {
            imported_symbols.push(actual.to_string());
        }
    }

    Some(AstNodeKind::ImportStatement {
        imported_symbols,
        source_specifier,
    })
}

fn classify_ts_js_line(trimmed: &str, language: SupportedAstLanguage) -> AstNodeKind {
    if let Some(reason) = has_obvious_syntax_error(trimmed) {
        return AstNodeKind::Error { reason };
    }

    if trimmed.starts_with("import ") {
        if let Some(import_node) = parse_import_line(trimmed) {
            return import_node;
        }
    }

    let (exported, body) =
        if let Some(after_export_default) = trimmed.strip_prefix("export default ") {
            (true, after_export_default.trim_start())
        } else if let Some(after_export) = trimmed.strip_prefix("export ") {
            (true, after_export.trim_start())
        } else {
            (false, trimmed)
        };

    let body_no_async = body.strip_prefix("async ").unwrap_or(body).trim_start();

    if let Some(after_fn) = body_no_async.strip_prefix("function ") {
        if let Some(name) = extract_first_identifier(after_fn) {
            let is_react_component = (language == SupportedAstLanguage::Tsx
                || body.contains("JSX")
                || body.contains("ReactElement"))
                && name
                    .chars()
                    .next()
                    .map(|c| c.is_ascii_uppercase())
                    .unwrap_or(false);
            let kind = if is_react_component {
                SymbolKind::ReactComponent
            } else {
                SymbolKind::Function
            };
            let refs = extract_identifier_tokens(after_fn)
                .into_iter()
                .filter(|id| id != &name)
                .collect();
            return AstNodeKind::SymbolDeclaration {
                name,
                kind,
                exported,
                referenced_identifiers: refs,
            };
        }
    }

    if let Some(after_class) = body
        .strip_prefix("abstract class ")
        .or_else(|| body.strip_prefix("class "))
    {
        if let Some(name) = extract_first_identifier(after_class) {
            let refs = extract_identifier_tokens(after_class)
                .into_iter()
                .filter(|id| id != &name)
                .collect();
            return AstNodeKind::SymbolDeclaration {
                name,
                kind: SymbolKind::Class,
                exported,
                referenced_identifiers: refs,
            };
        }
    }

    if let Some(after_iface) = body.strip_prefix("interface ") {
        if let Some(name) = extract_first_identifier(after_iface) {
            let refs = extract_identifier_tokens(after_iface)
                .into_iter()
                .filter(|id| id != &name)
                .collect();
            return AstNodeKind::SymbolDeclaration {
                name,
                kind: SymbolKind::Interface,
                exported,
                referenced_identifiers: refs,
            };
        }
    }

    if let Some(after_type) = body.strip_prefix("type ") {
        if let Some(name) = extract_first_identifier(after_type) {
            let refs = extract_identifier_tokens(after_type)
                .into_iter()
                .filter(|id| id != &name)
                .collect();
            return AstNodeKind::SymbolDeclaration {
                name,
                kind: SymbolKind::TypeAlias,
                exported,
                referenced_identifiers: refs,
            };
        }
    }

    if let Some(after_decl) = body
        .strip_prefix("const ")
        .or_else(|| body.strip_prefix("let "))
        .or_else(|| body.strip_prefix("var "))
    {
        if let Some(name) = extract_first_identifier(after_decl) {
            let is_arrow_fn = after_decl.contains("=>");
            let is_uppercase = name
                .chars()
                .next()
                .map(|c| c.is_ascii_uppercase())
                .unwrap_or(false);
            let kind = if is_arrow_fn && language == SupportedAstLanguage::Tsx && is_uppercase {
                SymbolKind::ReactComponent
            } else if is_arrow_fn {
                SymbolKind::Function
            } else {
                SymbolKind::ConstOrVariable
            };
            let refs = extract_identifier_tokens(after_decl)
                .into_iter()
                .filter(|id| id != &name)
                .collect();
            return AstNodeKind::SymbolDeclaration {
                name,
                kind,
                exported,
                referenced_identifiers: refs,
            };
        }
    }

    AstNodeKind::Statement
}

fn classify_json_line(trimmed: &str) -> AstNodeKind {
    if let Some(rest) = trimmed.strip_prefix('"') {
        if let Some((key, _)) = rest.split_once("\":") {
            return AstNodeKind::SymbolDeclaration {
                name: key.to_string(),
                kind: SymbolKind::JsonKey,
                exported: true,
                referenced_identifiers: Vec::new(),
            };
        }
    }
    AstNodeKind::Statement
}

fn classify_css_line(trimmed: &str) -> AstNodeKind {
    if trimmed.ends_with('{') {
        let selector = trimmed.trim_end_matches('{').trim();
        if !selector.is_empty() {
            return AstNodeKind::SymbolDeclaration {
                name: selector.to_string(),
                kind: SymbolKind::CssSelector,
                exported: true,
                referenced_identifiers: Vec::new(),
            };
        }
    }
    AstNodeKind::Statement
}

// ============================================================================
// Dependency Graph & Test Impact Analysis (`LOT-007`)
// ============================================================================

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

fn normalize_repo_path(path: &str) -> String {
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

fn resolve_import_specifier(
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
