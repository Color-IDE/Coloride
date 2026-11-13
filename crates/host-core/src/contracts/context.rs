//! Contract #4: `ContextBundle`, its excerpts and data classification.

use super::*;

// ============================================================================
// 6. Contract #4 — ContextBundle
// ============================================================================

/// Confidence level of a retrieved context excerpt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum ConfidenceLevel {
    ExactAstLsp,
    LexicalBm25,
    VectorSemantic,
    HeuristicText,
}

/// Freshness state of a context excerpt with priority given to unsaved buffers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum ExcerptFreshness {
    LiveUnsavedBuffer,
    IndexedCommit,
    StaleNeedsReindex,
}

/// Data sensitivity classification applied after secret/ACL filtering.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum DataClassification {
    Public,
    Internal,
    Confidential,
    RestrictedFiltered,
}

/// Authorized destination for exporting a `ContextBundle`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum AuthorizedDestination {
    LocalOnly,
    ByokProvider { provider_id: String },
    ManagedCloudEu,
    PrivateEnterpriseVllm,
}

/// Sourced, versioned code or documentation excerpt inside a `ContextBundle`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ContextExcerpt {
    pub source_path: String,
    pub document_revision: u32,
    pub content_blake3_hash: String,
    pub span_utf8: Utf8Span,
    pub start_line_col: LineCol,
    pub end_line_col: LineCol,
    pub content: String,
    pub confidence: ConfidenceLevel,
    pub freshness: ExcerptFreshness,
}

/// Contract #4: Versioned, ACL-filtered context bundle delivered to an authorized model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ContextBundle {
    pub schema_version: u16,
    pub bundle_id: String,
    pub workspace_version: String,
    pub excerpts: Vec<ContextExcerpt>,
    pub token_budget_used: u32,
    pub token_budget_max: u32,
    pub classification: DataClassification,
    pub authorized_destination: AuthorizedDestination,
    pub cache_control_prefix: Option<String>,
}
