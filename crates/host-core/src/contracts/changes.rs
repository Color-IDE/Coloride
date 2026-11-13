//! Contract #7: `ChangeSet`.

use super::*;

// ============================================================================
// 9. Contract #7 — ChangeSet
// ============================================================================

/// Semantic AST (`Tree-sitter`) or symbol-anchored `SEARCH/REPLACE` operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum ChangeOperation {
    AstNodeReplace {
        file_path: String,
        symbol_fqn: String,
        ast_node_kind: String,
        expected_span_utf8: Utf8Span,
        expected_block_blake3: String,
        replacement_code: String,
    },
    SymbolSearchReplace {
        file_path: String,
        anchor_symbol: String,
        search_block: String,
        replace_block: String,
        expected_before_blake3: String,
    },
}

/// Contract #7: AST-anchored changeset proposed by an agent and compiled by the Rust Host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ChangeSet {
    pub schema_version: u16,
    pub changeset_id: String,
    pub task_id: String,
    pub base_revision: u32,
    pub operations: Vec<ChangeOperation>,
    pub affected_files: Vec<String>,
    pub result_digest: String,
}
