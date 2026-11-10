use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

/// Canonical schema version for all Coloride technical contracts (`LOT-002`).
pub const CONTRACT_SCHEMA_VERSION: u16 = 1;

/// Errors raised during contract JSON or binary (`bincode`) serialization/deserialization.
#[derive(Debug, Error)]
pub enum ContractCodecError {
    #[error("JSON contract serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Binary contract serialization error: {0}")]
    Binary(#[from] bincode::Error),
    #[error("Failed to write generated TypeScript bindings: {0}")]
    Io(#[from] std::io::Error),
}

/// Serialize a contract to a JSON string.
pub fn encode_contract_json<T: Serialize>(value: &T) -> Result<String, ContractCodecError> {
    Ok(serde_json::to_string(value)?)
}

/// Deserialize a contract from a JSON string.
pub fn decode_contract_json<T: DeserializeOwned>(json: &str) -> Result<T, ContractCodecError> {
    Ok(serde_json::from_str(json)?)
}

/// Serialize a contract to a compact binary payload (`bincode`) for IPC channels.
pub fn encode_contract_binary<T: Serialize>(value: &T) -> Result<Vec<u8>, ContractCodecError> {
    Ok(bincode::serialize(value)?)
}

/// Deserialize a contract from a binary payload (`bincode`).
pub fn decode_contract_binary<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, ContractCodecError> {
    Ok(bincode::deserialize(bytes)?)
}

// ============================================================================
// 1. Explicit Offset Newtypes & Spans (UTF-8 vs UTF-16 Separation)
// ============================================================================

/// Explicit UTF-8 byte offset used by Rust (`ropey::Rope`) and `Tree-sitter`.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize, TS,
)]
pub struct Utf8ByteOffset(pub u32);

impl Utf8ByteOffset {
    pub const ZERO: Self = Self(0);

    #[must_use]
    pub const fn new(offset: u32) -> Self {
        Self(offset)
    }

    #[must_use]
    pub const fn as_u32(self) -> u32 {
        self.0
    }

    #[must_use]
    pub const fn as_usize(self) -> usize {
        self.0 as usize
    }
}

/// Explicit UTF-16 code unit offset used by CodeMirror 6, LSP, and VS Code Extension Host.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize, TS,
)]
pub struct Utf16CodeUnitOffset(pub u32);

impl Utf16CodeUnitOffset {
    pub const ZERO: Self = Self(0);

    #[must_use]
    pub const fn new(offset: u32) -> Self {
        Self(offset)
    }

    #[must_use]
    pub const fn as_u32(self) -> u32 {
        self.0
    }

    #[must_use]
    pub const fn as_usize(self) -> usize {
        self.0 as usize
    }
}

/// Zero-based line and UTF-16 column coordinate.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize, TS,
)]
pub struct LineCol {
    pub line: u32,
    pub col_utf16: u32,
}

impl LineCol {
    #[must_use]
    pub const fn new(line: u32, col_utf16: u32) -> Self {
        Self { line, col_utf16 }
    }
}

/// Half-open UTF-8 byte span `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, TS)]
pub struct Utf8Span {
    pub start: Utf8ByteOffset,
    pub end: Utf8ByteOffset,
}

impl Utf8Span {
    #[must_use]
    pub const fn new(start: Utf8ByteOffset, end: Utf8ByteOffset) -> Self {
        Self { start, end }
    }

    #[must_use]
    pub const fn len_bytes(self) -> u32 {
        self.end.0.saturating_sub(self.start.0)
    }

    #[must_use]
    pub const fn is_empty(self) -> bool {
        self.start.0 >= self.end.0
    }
}

/// Half-open UTF-16 code unit span `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, TS)]
pub struct Utf16Span {
    pub start: Utf16CodeUnitOffset,
    pub end: Utf16CodeUnitOffset,
}

impl Utf16Span {
    #[must_use]
    pub const fn new(start: Utf16CodeUnitOffset, end: Utf16CodeUnitOffset) -> Self {
        Self { start, end }
    }

    #[must_use]
    pub const fn len_code_units(self) -> u32 {
        self.end.0.saturating_sub(self.start.0)
    }

    #[must_use]
    pub const fn is_empty(self) -> bool {
        self.start.0 >= self.end.0
    }
}

// ============================================================================
// 2. Canonical Coloride Validation States (5 States) & Task Lifecycle (11 States)
// ============================================================================

/// The 5 canonical Coloride validation states bound to the exact document revision hash.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum ColorideValidationState {
    /// `🟢 ✓ Validated`: build OK, `vtsls`/Biome 0 errors, 100% impacted tests passed, Preview 0 crash/`console.error`.
    ValidatedGreen,
    /// `🟡 ! Needs Review`: agent patch awaiting human review, architectural decision, or non-blocking warning.
    ReviewYellow,
    /// `🔴 ✕ Failed`: compilation error, `vtsls` type error, blocking Biome rule, test failure, or runtime crash.
    FailedRed,
    /// `🟠 ⟳ Stale Validation`: previously `ValidatedGreen` range modified locally by the user after validation.
    StaleOrange,
    /// `🔵 • Unchanged Source`: original or infrastructure source code untouched by the current task.
    UnchangedBlue,
}

impl ColorideValidationState {
    pub const ALL: [Self; 5] = [
        Self::ValidatedGreen,
        Self::ReviewYellow,
        Self::FailedRed,
        Self::StaleOrange,
        Self::UnchangedBlue,
    ];

    #[must_use]
    pub const fn icon(self) -> &'static str {
        match self {
            Self::ValidatedGreen => "✓",
            Self::ReviewYellow => "!",
            Self::FailedRed => "✕",
            Self::StaleOrange => "⟳",
            Self::UnchangedBlue => "•",
        }
    }

    #[must_use]
    pub const fn label_fr(self) -> &'static str {
        match self {
            Self::ValidatedGreen => "✓ Validé",
            Self::ReviewYellow => "! À examiner",
            Self::FailedRed => "✕ Échec",
            Self::StaleOrange => "⟳ Validation périmée",
            Self::UnchangedBlue => "• Source inchangée",
        }
    }

    #[must_use]
    pub const fn label_en(self) -> &'static str {
        match self {
            Self::ValidatedGreen => "✓ Validated",
            Self::ReviewYellow => "! Needs Review",
            Self::FailedRed => "✕ Failed",
            Self::StaleOrange => "⟳ Stale Validation",
            Self::UnchangedBlue => "• Unchanged Source",
        }
    }

    #[must_use]
    pub const fn label_es(self) -> &'static str {
        match self {
            Self::ValidatedGreen => "✓ Validado",
            Self::ReviewYellow => "! Revisar",
            Self::FailedRed => "✕ Fallo",
            Self::StaleOrange => "⟳ Caducado",
            Self::UnchangedBlue => "• Sin cambios",
        }
    }

    /// Synchronously downgrades `ValidatedGreen` to `StaleOrange` upon any local character edit.
    #[must_use]
    pub const fn on_local_edit(self) -> Self {
        match self {
            Self::ValidatedGreen => Self::StaleOrange,
            other => other,
        }
    }
}

/// The 11-state task lifecycle machine (`LOT-002` / `LOT-013`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum TaskState {
    Created,
    ContextReady,
    Planned,
    Running,
    Verifying,
    AwaitingReview,
    Applied,
    Paused,
    Failed,
    Cancelled,
    NeedsReconciliation,
}

impl TaskState {
    pub const ALL: [Self; 11] = [
        Self::Created,
        Self::ContextReady,
        Self::Planned,
        Self::Running,
        Self::Verifying,
        Self::AwaitingReview,
        Self::Applied,
        Self::Paused,
        Self::Failed,
        Self::Cancelled,
        Self::NeedsReconciliation,
    ];

    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Applied | Self::Failed | Self::Cancelled)
    }

    #[must_use]
    pub const fn requires_human_intervention(self) -> bool {
        matches!(
            self,
            Self::AwaitingReview | Self::Paused | Self::NeedsReconciliation
        )
    }
}

// ============================================================================
// 3. Contract #1 — EditorTransaction
// ============================================================================

/// Origin of an editor transaction for isolated undo/redo and auditability.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum TransactionOrigin {
    User,
    Agent { task_id: String },
    Peer { peer_id: String },
    Extension { extension_id: String },
}

/// Atomic text replacement inside an `EditorTransaction`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct TextChange {
    pub range_utf16: Utf16Span,
    pub range_utf8: Option<Utf8Span>,
    pub inserted_text: String,
}

/// Editor cursor and selection state expressed in UTF-16 code units.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub struct EditorSelection {
    pub anchor: Utf16CodeUnitOffset,
    pub head: Utf16CodeUnitOffset,
    pub cursor_line_col: Option<LineCol>,
}

/// Contract #1: Versioned delta transaction exchanged between CodeMirror 6 and the Rust Host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct EditorTransaction {
    pub schema_version: u16,
    pub document_id: String,
    pub session_generation: u32,
    pub base_revision: u32,
    pub op_id: String,
    pub changes: Vec<TextChange>,
    pub selection: EditorSelection,
    pub origin: TransactionOrigin,
    pub ime_composing: bool,
}

// ============================================================================
// 4. Contract #2 — EditorSnapshot
// ============================================================================

/// Contract #2: Immutable snapshot state of a document managed by `host-core`.
/// Strictly separates `interactive_revision`, `journaled_revision`, and `disk_saved_revision`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct EditorSnapshot {
    pub schema_version: u16,
    pub document_id: String,
    pub session_generation: u32,
    pub interactive_revision: u32,
    pub journaled_revision: u32,
    pub disk_saved_revision: u32,
    pub content_blake3_hash: String,
    pub has_unsaved_changes: bool,
}

impl EditorSnapshot {
    #[must_use]
    pub fn new(
        document_id: impl Into<String>,
        session_generation: u32,
        interactive_revision: u32,
        journaled_revision: u32,
        disk_saved_revision: u32,
        content_blake3_hash: impl Into<String>,
    ) -> Self {
        Self {
            schema_version: CONTRACT_SCHEMA_VERSION,
            document_id: document_id.into(),
            session_generation,
            interactive_revision,
            journaled_revision,
            disk_saved_revision,
            content_blake3_hash: content_blake3_hash.into(),
            has_unsaved_changes: interactive_revision != disk_saved_revision,
        }
    }

    #[must_use]
    pub const fn is_fully_journaled(&self) -> bool {
        self.journaled_revision >= self.interactive_revision
    }

    #[must_use]
    pub const fn is_disk_saved(&self) -> bool {
        !self.has_unsaved_changes && self.interactive_revision == self.disk_saved_revision
    }
}

// ============================================================================
// 5. Contract #3 — TaskSpec
// ============================================================================

/// Execution target environment governed by `PolicyEngine` and `Approval`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum TargetEnvironment {
    LocalWorktree,
    LocalOciSandbox,
    Staging,
    Production,
    SanitizedDatabaseClone,
}

/// Autonomy level granted to an agent for a specific task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum AutonomyLevel {
    ProposalOnly,
    SupervisedSandbox,
    BoundedAutoCorrect,
}

/// Deterministic security and execution policy attached to a `TaskSpec`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ExecutionPolicy {
    pub autonomy_level: AutonomyLevel,
    pub network_allowed: bool,
    pub allowed_paths: Vec<String>,
    pub forbidden_paths: Vec<String>,
    pub max_auto_retries: u8,
    pub workspace_trusted: bool,
}

/// Resource and financial budget ceiling for a task (`BudgetLedger`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct BudgetLimits {
    pub max_cost_usd_micros: u32,
    pub max_tokens: u32,
    pub max_cpu_ms: u32,
    pub max_tool_calls: u32,
}

/// Contract #3: Specification, policy, and budget boundaries for an agent task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct TaskSpec {
    pub schema_version: u16,
    pub task_id: String,
    pub objective: String,
    pub workspace_id: String,
    pub base_snapshot_id: String,
    pub target_env: TargetEnvironment,
    pub policy: ExecutionPolicy,
    pub budget_limits: BudgetLimits,
    pub acceptance_criteria: Vec<String>,
    pub state: TaskState,
}

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

// ============================================================================
// 7. Contract #5 — ModelProvider
// ============================================================================

/// Execution backend category for a model or external ACP agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum ModelProviderKind {
    LocalLlamaCpp,
    LocalOllama,
    ByokCloud,
    ManagedColorideCloud,
    PrivateVllm,
    AcpExternalAgent,
}

/// Declared static capabilities of a model provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ModelCapabilities {
    pub supports_streaming: bool,
    pub supports_structured_tool_calls: bool,
    pub supports_prompt_caching: bool,
    pub max_context_tokens: u32,
    pub max_output_tokens: u32,
}

/// Token consumption, latency, and cost metrics for a model invocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub struct ModelUsageMetrics {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cached_input_tokens: u32,
    pub latency_ms: u32,
    pub cost_usd_micros: u32,
}

/// Contract #5: Model provider descriptor, capabilities, cancellation token, and usage metrics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ModelProvider {
    pub schema_version: u16,
    pub provider_id: String,
    pub model_name: String,
    pub kind: ModelProviderKind,
    pub capabilities: ModelCapabilities,
    pub streaming_enabled: bool,
    pub structured_tool_calls: bool,
    pub cancellation_token_id: String,
    pub usage_metrics: ModelUsageMetrics,
}

// ============================================================================
// 8. Contract #6 — ToolCall
// ============================================================================

/// Strongly-typed argument value for a `ToolCall` (avoids `any` in TypeScript).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum ToolArgValue {
    Text(String),
    Integer(i32),
    Boolean(bool),
    StringList(Vec<String>),
}

/// Capability required by a `ToolCall` and checked by `PolicyEngine`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum ToolCapability {
    ReadWorkspace,
    WriteWorktree,
    RunSandboxCommand,
    QueryLocalMcp,
    NetworkEgress,
    DatabaseRead,
    DatabaseMigrate,
    DeployPreview,
    DeployProduction,
}

/// Precondition that must hold before `ToolBroker` executes a `ToolCall`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ToolPrecondition {
    pub description: String,
    pub required_snapshot_hash: Option<String>,
    pub requires_human_approval: bool,
}

/// Contract #6: Structured, idempotent tool invocation submitted to `PolicyEngine` and `ToolBroker`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ToolCall {
    pub schema_version: u16,
    pub call_id: String,
    pub task_id: String,
    pub tool_name: String,
    pub validated_args: BTreeMap<String, ToolArgValue>,
    pub required_capabilities: Vec<ToolCapability>,
    pub preconditions: Vec<ToolPrecondition>,
    pub idempotency_key: String,
}

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

// ============================================================================
// 10. Contract #8 — Evidence
// ============================================================================

/// Record of a command executed inside the isolated sandbox during verification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ExecutedCommandRecord {
    pub command: String,
    pub args: Vec<String>,
    pub exit_code: i32,
    pub duration_ms: u32,
    pub impacted_tests_only: bool,
}

/// Severity of a diagnostic reported by `vtsls`, Biome, or runtime checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Information,
}

/// Tool or subsystem that emitted a diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum DiagnosticSource {
    Vtsls,
    Biome,
    Compiler,
    TestRunner,
    PreviewRuntime,
}

/// Structured diagnostic entry anchored on explicit UTF-16 spans for CodeMirror 6 projection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct DiagnosticEntry {
    pub file_path: String,
    pub span_utf16: Utf16Span,
    pub line_col: LineCol,
    pub source: DiagnosticSource,
    pub severity: DiagnosticSeverity,
    pub code: String,
    pub message: String,
}

/// Aggregated `vtsls` and Biome diagnostics for an `Evidence` bundle.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub struct QualityDiagnosticsSummary {
    pub vtsls_error_count: u32,
    pub vtsls_warning_count: u32,
    pub biome_error_count: u32,
    pub biome_warning_count: u32,
    pub items: Vec<DiagnosticEntry>,
}

/// Runtime report captured by the isolated `Preview Service` (Browser Loop).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct PreviewRuntimeReport {
    pub inspected_url: String,
    pub console_error_count: u32,
    pub uncaught_exception_count: u32,
    pub failed_network_request_count: u32,
    pub crashed: bool,
    pub dom_snapshot_hash: Option<String>,
}

/// Verifiable artifact produced during sandbox validation (coverage, logs, screenshots, trace).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct EvidenceArtifact {
    pub name: String,
    pub kind: String,
    pub digest_blake3: String,
    pub byte_size: u32,
}

/// Contract #8: Cryptographically bound verification proof determining the Coloride state (`🟢/🟡/🔴`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Evidence {
    pub schema_version: u16,
    pub evidence_id: String,
    pub task_id: String,
    pub tested_snapshot_hash: String,
    pub checkpoint_ref: String,
    pub commands: Vec<ExecutedCommandRecord>,
    pub diagnostics: QualityDiagnosticsSummary,
    pub preview_report: PreviewRuntimeReport,
    pub artifacts: Vec<EvidenceArtifact>,
    pub verdict: ColorideValidationState,
}

impl Evidence {
    /// Enforces Invariant #4: `ValidatedGreen` (`🟢 ✓ Validated`) requires a matching
    /// `content_blake3_hash`, all executed commands succeeding (`exit_code == 0`),
    /// 0 `vtsls`/Biome errors, and 0 `Preview Service` crashes or `console.error`.
    #[must_use]
    pub fn satisfies_validated_green(&self, current_content_blake3_hash: &str) -> bool {
        !current_content_blake3_hash.is_empty()
            && self.tested_snapshot_hash == current_content_blake3_hash
            && !self.commands.is_empty()
            && self.commands.iter().all(|cmd| cmd.exit_code == 0)
            && self.diagnostics.vtsls_error_count == 0
            && self.diagnostics.biome_error_count == 0
            && !self.preview_report.crashed
            && self.preview_report.console_error_count == 0
            && self.preview_report.uncaught_exception_count == 0
            && self.verdict == ColorideValidationState::ValidatedGreen
    }
}

// ============================================================================
// 11. Contract #9 — Approval
// ============================================================================

/// Kind of privileged action covered by a signed `Approval`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum ApprovalActionKind {
    ApplyChangeSet,
    ExecuteToolCall,
    RunDatabaseMigration,
    DeployInfrastructure,
    PublishRelease,
}

/// Contract #9: Cryptographic approval bound to a specific actor, target, action, and digest.
/// Any 1-bit change in the patch, plan, or target environment immediately invalidates the approval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Approval {
    pub schema_version: u16,
    pub approval_id: String,
    pub actor_identity: String,
    pub target_env: TargetEnvironment,
    pub action_kind: ApprovalActionKind,
    pub approved_digest: String,
    #[ts(type = "number")]
    pub expires_at: u64,
}

impl Approval {
    /// Computes a domain-separated BLAKE3 digest binding the changeset/patch digest,
    /// execution plan digest, target environment, and action kind.
    #[must_use]
    pub fn compute_action_digest(
        changeset_digest: &str,
        plan_digest: &str,
        target_env: &TargetEnvironment,
        action_kind: &ApprovalActionKind,
    ) -> String {
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"coloride.approval.v1\0");
        hasher.update(changeset_digest.as_bytes());
        hasher.update(b"\0");
        hasher.update(plan_digest.as_bytes());
        hasher.update(b"\0");
        if let Ok(env_bytes) = bincode::serialize(target_env) {
            hasher.update(&env_bytes);
        }
        hasher.update(b"\0");
        if let Ok(kind_bytes) = bincode::serialize(action_kind) {
            hasher.update(&kind_bytes);
        }
        hasher.finalize().to_hex().to_string()
    }

    /// Validates whether this approval authorizes `action_digest` on `target_env` at timestamp `now`.
    /// Returns `false` if expired (`now >= self.expires_at`), if `target_env` differs, or if
    /// `action_digest` differs by even a single bit from `self.approved_digest`.
    #[must_use]
    pub fn is_valid_for(
        &self,
        target_env: &TargetEnvironment,
        action_digest: &str,
        now: u64,
    ) -> bool {
        if self.schema_version != CONTRACT_SCHEMA_VERSION {
            return false;
        }
        if self.actor_identity.trim().is_empty() || self.approved_digest.is_empty() {
            return false;
        }
        if now >= self.expires_at {
            return false;
        }
        if &self.target_env != target_env {
            return false;
        }
        constant_time_str_eq(&self.approved_digest, action_digest)
    }

    /// Validates this approval against the raw `changeset_digest`, `plan_digest`, `target_env`, and `action_kind`.
    #[must_use]
    pub fn is_valid_for_plan_and_patch(
        &self,
        target_env: &TargetEnvironment,
        action_kind: &ApprovalActionKind,
        changeset_digest: &str,
        plan_digest: &str,
        now: u64,
    ) -> bool {
        if &self.action_kind != action_kind {
            return false;
        }
        let expected_digest =
            Self::compute_action_digest(changeset_digest, plan_digest, target_env, action_kind);
        self.is_valid_for(target_env, &expected_digest, now)
    }
}

fn constant_time_str_eq(lhs: &str, rhs: &str) -> bool {
    let lhs_bytes = lhs.as_bytes();
    let rhs_bytes = rhs.as_bytes();
    if lhs_bytes.len() != rhs_bytes.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&a, &b) in lhs_bytes.iter().zip(rhs_bytes.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

// ============================================================================
// 12. Automated TypeScript Binding Generator (`packages/protocol-types`)
// ============================================================================

/// Format a `ts-rs` declaration into Biome-compliant TypeScript (`export type ...`).
fn format_ts_decl(raw_decl: &str) -> String {
    let normalized = raw_decl.trim();
    let exported = if normalized.starts_with("export ") {
        normalized.to_string()
    } else {
        format!("export {normalized}")
    };

    // Format single-line `{ a: T, b: U, }` struct declarations from `ts-rs` into
    // multi-line 2-space indented Biome-compliant declarations.
    if !exported.contains(" } | { ") {
        if let Some((prefix, rest)) = exported.split_once(" = { ") {
            if let Some(fields_str) = rest.strip_suffix(" };") {
                let fields: Vec<&str> = fields_str
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .collect();
                let mut out = format!("{prefix} = {{\n");
                for field in fields {
                    out.push_str("  ");
                    out.push_str(field);
                    out.push_str(";\n");
                }
                out.push_str("};");
                return out;
            }
        }
    }

    // Format union declarations that contain inline object variants or exceed 100 chars.
    if let Some((prefix, rest)) = exported.split_once(" = ") {
        if let Some(body) = rest.strip_suffix(';') {
            if body.contains(" | ") && (exported.len() > 100 || body.contains("{ ")) {
                let variants: Vec<&str> = body.split(" | ").map(str::trim).collect();
                let mut out = format!("{prefix} =\n");
                for (idx, variant) in variants.iter().enumerate() {
                    let formatted_variant = format_inline_object_variant(variant);
                    out.push_str("  | ");
                    out.push_str(&formatted_variant);
                    if idx + 1 == variants.len() {
                        out.push(';');
                    }
                    out.push('\n');
                }
                return out.trim_end().to_string();
            }
        }
    }

    exported
}

fn format_inline_object_variant(variant: &str) -> String {
    if let Some(inner) = variant
        .strip_prefix("{ ")
        .and_then(|s| s.strip_suffix(" }"))
    {
        if let Some((tag_raw, obj)) = inner.split_once(": { ") {
            let tag = tag_raw.trim_matches('"');
            if let Some(fields_raw) = obj.strip_suffix(" }") {
                let fields: Vec<&str> = fields_raw
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .collect();
                if fields.len() == 1 && variant.len() <= 75 {
                    return format!("{{ {tag}: {{ {} }} }}", fields[0]);
                }
                let mut out = format!("{{\n      {tag}: {{\n");
                for field in fields {
                    out.push_str("        ");
                    out.push_str(field);
                    out.push_str(";\n");
                }
                out.push_str("      };\n    }");
                return out;
            }
        } else if let Some((tag_raw, val)) = inner.split_once(": ") {
            let tag = tag_raw.trim_matches('"');
            return format!("{{ {tag}: {val} }}");
        }
    }
    variant.to_string()
}

/// Generates the complete, deterministic TypeScript module for `@coloride/protocol-types`.
#[must_use]
pub fn generate_typescript_bindings() -> String {
    let declarations = [
        Utf8ByteOffset::decl(),
        Utf16CodeUnitOffset::decl(),
        LineCol::decl(),
        Utf8Span::decl(),
        Utf16Span::decl(),
        ColorideValidationState::decl(),
        TaskState::decl(),
        TransactionOrigin::decl(),
        TextChange::decl(),
        EditorSelection::decl(),
        EditorTransaction::decl(),
        EditorSnapshot::decl(),
        TargetEnvironment::decl(),
        AutonomyLevel::decl(),
        ExecutionPolicy::decl(),
        BudgetLimits::decl(),
        TaskSpec::decl(),
        ConfidenceLevel::decl(),
        ExcerptFreshness::decl(),
        DataClassification::decl(),
        AuthorizedDestination::decl(),
        ContextExcerpt::decl(),
        ContextBundle::decl(),
        ModelProviderKind::decl(),
        ModelCapabilities::decl(),
        ModelUsageMetrics::decl(),
        ModelProvider::decl(),
        ToolArgValue::decl(),
        ToolCapability::decl(),
        ToolPrecondition::decl(),
        ToolCall::decl(),
        ChangeOperation::decl(),
        ChangeSet::decl(),
        ExecutedCommandRecord::decl(),
        DiagnosticSeverity::decl(),
        DiagnosticSource::decl(),
        DiagnosticEntry::decl(),
        QualityDiagnosticsSummary::decl(),
        PreviewRuntimeReport::decl(),
        EvidenceArtifact::decl(),
        Evidence::decl(),
        ApprovalActionKind::decl(),
        Approval::decl(),
    ];

    let mut output = String::from(
        "// AUTO-GENERATED FILE — DO NOT EDIT MANUALLY.\n\
         // Source of truth: crates/host-core/src/contracts.rs (LOT-002)\n\
         // Regenerate with: cargo test --package host-core export_bindings\n\n\
         export const CONTRACT_SCHEMA_VERSION = 1 as const;\n\n",
    );

    for (idx, decl) in declarations.iter().enumerate() {
        output.push_str(&format_ts_decl(decl));
        output.push('\n');
        if idx + 1 < declarations.len() {
            output.push('\n');
        }
    }

    output
}

/// Resolves the path to `packages/protocol-types/src/generated.ts` from `crates/host-core`.
#[must_use]
pub fn default_generated_ts_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("packages")
        .join("protocol-types")
        .join("src")
        .join("generated.ts")
}

/// Writes the generated TypeScript bindings to `target_path`, preserving the file's existing
/// line ending style (`\r\n` vs `\n`) if already present on disk so `git diff --exit-code`
/// remains clean across Windows, macOS, and Linux checkouts.
pub fn write_typescript_bindings(target_path: &Path) -> Result<String, ContractCodecError> {
    let canonical_lf = generate_typescript_bindings();
    let existing = std::fs::read_to_string(target_path).ok();
    let desired = match &existing {
        Some(content) if content.contains("\r\n") => canonical_lf.replace('\n', "\r\n"),
        _ => canonical_lf.clone(),
    };

    if existing.as_deref() != Some(desired.as_str()) {
        std::fs::write(target_path, desired.as_bytes())?;
    }

    Ok(canonical_lf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_json_and_binary_roundtrip<T>(value: &T)
    where
        T: Serialize + DeserializeOwned + PartialEq + std::fmt::Debug,
    {
        let json = encode_contract_json(value).expect("JSON serialize failed");
        let from_json: T = decode_contract_json(&json).expect("JSON deserialize failed");
        assert_eq!(&from_json, value, "JSON round-trip mismatch");

        let bytes = encode_contract_binary(value).expect("Binary serialize failed");
        let from_bytes: T = decode_contract_binary(&bytes).expect("Binary deserialize failed");
        assert_eq!(&from_bytes, value, "Binary round-trip mismatch");
    }

    #[test]
    fn export_bindings() {
        let out_path = default_generated_ts_path();
        let generated =
            write_typescript_bindings(&out_path).expect("failed to write generated.ts bindings");

        assert!(
            !generated.contains(": any") && !generated.contains("<any>"),
            "Generated TypeScript must never contain explicit `any`"
        );

        for contract_name in [
            "EditorTransaction",
            "EditorSnapshot",
            "TaskSpec",
            "ContextBundle",
            "ModelProvider",
            "ToolCall",
            "ChangeSet",
            "Evidence",
            "Approval",
            "ColorideValidationState",
            "TaskState",
            "Utf8ByteOffset",
            "Utf16CodeUnitOffset",
            "LineCol",
        ] {
            let needle = format!("export type {contract_name} =");
            assert!(
                generated.contains(&needle),
                "Missing exported TypeScript contract: {contract_name}"
            );
        }
    }

    #[test]
    fn offset_newtypes_and_spans_enforce_explicit_units() {
        let utf8 = Utf8ByteOffset::new(42);
        let utf16 = Utf16CodeUnitOffset::new(28);
        let lc = LineCol::new(3, 14);
        assert_eq!(utf8.as_u32(), 42);
        assert_eq!(utf8.as_usize(), 42);
        assert_eq!(utf16.as_u32(), 28);
        assert_eq!(utf16.as_usize(), 28);
        assert_eq!(lc.line, 3);
        assert_eq!(lc.col_utf16, 14);

        let span_utf8 = Utf8Span::new(Utf8ByteOffset::new(10), Utf8ByteOffset::new(26));
        assert_eq!(span_utf8.len_bytes(), 16);
        assert!(!span_utf8.is_empty());

        let span_utf16 = Utf16Span::new(Utf16CodeUnitOffset::new(5), Utf16CodeUnitOffset::new(12));
        assert_eq!(span_utf16.len_code_units(), 7);
        assert!(!span_utf16.is_empty());
    }

    #[test]
    fn all_five_coloride_states_and_eleven_task_states_roundtrip() {
        assert_eq!(ColorideValidationState::ALL.len(), 5);
        for state in ColorideValidationState::ALL {
            assert_json_and_binary_roundtrip(&state);
            assert!(!state.icon().is_empty());
            assert!(!state.label_fr().is_empty());
            assert!(!state.label_en().is_empty());
            assert!(!state.label_es().is_empty());
        }

        assert_eq!(
            ColorideValidationState::ValidatedGreen.on_local_edit(),
            ColorideValidationState::StaleOrange
        );
        assert_eq!(
            ColorideValidationState::ReviewYellow.on_local_edit(),
            ColorideValidationState::ReviewYellow
        );

        assert_eq!(TaskState::ALL.len(), 11);
        for task_state in TaskState::ALL {
            assert_json_and_binary_roundtrip(&task_state);
        }
        assert!(TaskState::Applied.is_terminal());
        assert!(TaskState::Failed.is_terminal());
        assert!(TaskState::Cancelled.is_terminal());
        assert!(!TaskState::Running.is_terminal());
        assert!(TaskState::NeedsReconciliation.requires_human_intervention());
    }

    #[test]
    fn all_nine_canonical_contracts_roundtrip_json_and_binary_with_unicode() {
        // 1. EditorTransaction (with Unicode emoji / CJK / accents and all origins)
        for origin in [
            TransactionOrigin::User,
            TransactionOrigin::Agent {
                task_id: "task-001".to_string(),
            },
            TransactionOrigin::Peer {
                peer_id: "peer-alice".to_string(),
            },
            TransactionOrigin::Extension {
                extension_id: "openvsx.prettier".to_string(),
            },
        ] {
            let tx = EditorTransaction {
                schema_version: CONTRACT_SCHEMA_VERSION,
                document_id: "src/auth/login.tsx".to_string(),
                session_generation: 3,
                base_revision: 41,
                op_id: "op-unicode-001".to_string(),
                changes: vec![TextChange {
                    range_utf16: Utf16Span::new(
                        Utf16CodeUnitOffset::new(12),
                        Utf16CodeUnitOffset::new(24),
                    ),
                    range_utf8: Some(Utf8Span::new(
                        Utf8ByteOffset::new(14),
                        Utf8ByteOffset::new(30),
                    )),
                    inserted_text: "const badge = '🟢 ✓ Validé 👩‍💻 🏳️‍🌈 日本語';".to_string(),
                }],
                selection: EditorSelection {
                    anchor: Utf16CodeUnitOffset::new(48),
                    head: Utf16CodeUnitOffset::new(48),
                    cursor_line_col: Some(LineCol::new(10, 22)),
                },
                origin,
                ime_composing: false,
            };
            assert_json_and_binary_roundtrip(&tx);
        }

        // 2. EditorSnapshot (separating interactive, journaled, and disk-saved revisions)
        let snapshot = EditorSnapshot::new(
            "src/auth/login.tsx",
            3,
            42,
            42,
            40,
            blake3::hash(b"snapshot-content-v42").to_hex().to_string(),
        );
        assert!(snapshot.has_unsaved_changes);
        assert!(snapshot.is_fully_journaled());
        assert!(!snapshot.is_disk_saved());
        assert_json_and_binary_roundtrip(&snapshot);

        // 3. TaskSpec (across all 11 task states)
        for state in TaskState::ALL {
            let spec = TaskSpec {
                schema_version: CONTRACT_SCHEMA_VERSION,
                task_id: "task-stripe-webhook".to_string(),
                objective: "Vérifier la signature HMAC du webhook Stripe".to_string(),
                workspace_id: "ws-coloride-core".to_string(),
                base_snapshot_id: snapshot.content_blake3_hash.clone(),
                target_env: TargetEnvironment::LocalWorktree,
                policy: ExecutionPolicy {
                    autonomy_level: AutonomyLevel::BoundedAutoCorrect,
                    network_allowed: false,
                    allowed_paths: vec!["src/**".to_string(), "tests/**".to_string()],
                    forbidden_paths: vec![".env".to_string(), "~/.ssh/**".to_string()],
                    max_auto_retries: 2,
                    workspace_trusted: true,
                },
                budget_limits: BudgetLimits {
                    max_cost_usd_micros: 1_000_000,
                    max_tokens: 200_000,
                    max_cpu_ms: 60_000,
                    max_tool_calls: 32,
                },
                acceptance_criteria: vec![
                    "0 erreur vtsls et Biome".to_string(),
                    "100% des tests impactés passent".to_string(),
                ],
                state,
            };
            assert_json_and_binary_roundtrip(&spec);
        }

        // 4. ContextBundle
        let bundle = ContextBundle {
            schema_version: CONTRACT_SCHEMA_VERSION,
            bundle_id: "bundle-001".to_string(),
            workspace_version: "git:9f8e7d6c+dirty:1".to_string(),
            excerpts: vec![ContextExcerpt {
                source_path: "src/auth/login.tsx".to_string(),
                document_revision: 42,
                content_blake3_hash: snapshot.content_blake3_hash.clone(),
                span_utf8: Utf8Span::new(Utf8ByteOffset::new(0), Utf8ByteOffset::new(128)),
                start_line_col: LineCol::new(0, 0),
                end_line_col: LineCol::new(12, 1),
                content: "export function verifySession() { return true; }".to_string(),
                confidence: ConfidenceLevel::ExactAstLsp,
                freshness: ExcerptFreshness::LiveUnsavedBuffer,
            }],
            token_budget_used: 1_420,
            token_budget_max: 16_000,
            classification: DataClassification::RestrictedFiltered,
            authorized_destination: AuthorizedDestination::ByokProvider {
                provider_id: "anthropic-claude".to_string(),
            },
            cache_control_prefix: Some("coloride:ws-core:v1".to_string()),
        };
        assert_json_and_binary_roundtrip(&bundle);

        // 5. ModelProvider
        let provider = ModelProvider {
            schema_version: CONTRACT_SCHEMA_VERSION,
            provider_id: "claude-sonnet-acp".to_string(),
            model_name: "claude-sonnet-4".to_string(),
            kind: ModelProviderKind::AcpExternalAgent,
            capabilities: ModelCapabilities {
                supports_streaming: true,
                supports_structured_tool_calls: true,
                supports_prompt_caching: true,
                max_context_tokens: 200_000,
                max_output_tokens: 16_384,
            },
            streaming_enabled: true,
            structured_tool_calls: true,
            cancellation_token_id: "cancel-tok-77".to_string(),
            usage_metrics: ModelUsageMetrics {
                input_tokens: 3_200,
                output_tokens: 640,
                cached_input_tokens: 2_800,
                latency_ms: 410,
                cost_usd_micros: 14_500,
            },
        };
        assert_json_and_binary_roundtrip(&provider);

        // 6. ToolCall
        let mut args = BTreeMap::new();
        args.insert(
            "command".to_string(),
            ToolArgValue::Text("vitest".to_string()),
        );
        args.insert(
            "args".to_string(),
            ToolArgValue::StringList(vec![
                "related".to_string(),
                "src/auth/login.tsx".to_string(),
            ]),
        );
        args.insert("timeout_ms".to_string(), ToolArgValue::Integer(5_000));
        args.insert("fail_fast".to_string(), ToolArgValue::Boolean(true));

        let tool_call = ToolCall {
            schema_version: CONTRACT_SCHEMA_VERSION,
            call_id: "call-001".to_string(),
            task_id: "task-stripe-webhook".to_string(),
            tool_name: "sandbox.run_impacted_tests".to_string(),
            validated_args: args,
            required_capabilities: vec![
                ToolCapability::ReadWorkspace,
                ToolCapability::RunSandboxCommand,
            ],
            preconditions: vec![ToolPrecondition {
                description: "Worktree snapshot must match base revision".to_string(),
                required_snapshot_hash: Some(snapshot.content_blake3_hash.clone()),
                requires_human_approval: false,
            }],
            idempotency_key: "idem-task-stripe-001".to_string(),
        };
        assert_json_and_binary_roundtrip(&tool_call);

        // 7. ChangeSet (both AST and SEARCH/REPLACE operations with Unicode)
        let changeset_digest = blake3::hash(b"patched-login-tsx-v43").to_hex().to_string();
        let changeset = ChangeSet {
            schema_version: CONTRACT_SCHEMA_VERSION,
            changeset_id: "cs-001".to_string(),
            task_id: "task-stripe-webhook".to_string(),
            base_revision: 42,
            operations: vec![
                ChangeOperation::AstNodeReplace {
                    file_path: "src/auth/login.tsx".to_string(),
                    symbol_fqn: "verifySession".to_string(),
                    ast_node_kind: "function_declaration".to_string(),
                    expected_span_utf8: Utf8Span::new(
                        Utf8ByteOffset::new(0),
                        Utf8ByteOffset::new(48),
                    ),
                    expected_block_blake3: snapshot.content_blake3_hash.clone(),
                    replacement_code:
                        "export function verifySession(): boolean { return true; // ✓ Validé 👩‍💻 }"
                            .to_string(),
                },
                ChangeOperation::SymbolSearchReplace {
                    file_path: "src/auth/login.tsx".to_string(),
                    anchor_symbol: "verifySession".to_string(),
                    search_block: "return false;".to_string(),
                    replace_block: "return true;".to_string(),
                    expected_before_blake3: snapshot.content_blake3_hash.clone(),
                },
            ],
            affected_files: vec!["src/auth/login.tsx".to_string()],
            result_digest: changeset_digest.clone(),
        };
        assert_json_and_binary_roundtrip(&changeset);

        // 8. Evidence
        let evidence = Evidence {
            schema_version: CONTRACT_SCHEMA_VERSION,
            evidence_id: "ev-001".to_string(),
            task_id: "task-stripe-webhook".to_string(),
            tested_snapshot_hash: changeset_digest.clone(),
            checkpoint_ref: "refs/coloride/checkpoints/task-stripe-webhook".to_string(),
            commands: vec![ExecutedCommandRecord {
                command: "pnpm".to_string(),
                args: vec![
                    "vitest".to_string(),
                    "related".to_string(),
                    "src/auth/login.tsx".to_string(),
                ],
                exit_code: 0,
                duration_ms: 820,
                impacted_tests_only: true,
            }],
            diagnostics: QualityDiagnosticsSummary {
                vtsls_error_count: 0,
                vtsls_warning_count: 1,
                biome_error_count: 0,
                biome_warning_count: 0,
                items: vec![DiagnosticEntry {
                    file_path: "src/auth/login.tsx".to_string(),
                    span_utf16: Utf16Span::new(
                        Utf16CodeUnitOffset::new(0),
                        Utf16CodeUnitOffset::new(15),
                    ),
                    line_col: LineCol::new(0, 0),
                    source: DiagnosticSource::Vtsls,
                    severity: DiagnosticSeverity::Warning,
                    code: "TS6133".to_string(),
                    message: "Unused variable hint".to_string(),
                }],
            },
            preview_report: PreviewRuntimeReport {
                inspected_url: "http://127.0.0.1:43210/preview".to_string(),
                console_error_count: 0,
                uncaught_exception_count: 0,
                failed_network_request_count: 0,
                crashed: false,
                dom_snapshot_hash: Some(blake3::hash(b"<main>OK</main>").to_hex().to_string()),
            },
            artifacts: vec![EvidenceArtifact {
                name: "junit-report.xml".to_string(),
                kind: "test-report".to_string(),
                digest_blake3: blake3::hash(b"<testsuites/>").to_hex().to_string(),
                byte_size: 512,
            }],
            verdict: ColorideValidationState::ValidatedGreen,
        };
        assert!(evidence.satisfies_validated_green(&changeset_digest));
        assert!(!evidence.satisfies_validated_green("stale-or-different-hash"));
        assert_json_and_binary_roundtrip(&evidence);

        // 9. Approval
        let plan_digest = blake3::hash(b"plan-v1").to_hex().to_string();
        let approved_digest = Approval::compute_action_digest(
            &changeset_digest,
            &plan_digest,
            &TargetEnvironment::Staging,
            &ApprovalActionKind::ApplyChangeSet,
        );
        let approval = Approval {
            schema_version: CONTRACT_SCHEMA_VERSION,
            approval_id: "appr-001".to_string(),
            actor_identity: "founder@coloride.dev".to_string(),
            target_env: TargetEnvironment::Staging,
            action_kind: ApprovalActionKind::ApplyChangeSet,
            approved_digest,
            expires_at: 1_900_000_000,
        };
        assert_json_and_binary_roundtrip(&approval);
    }

    #[test]
    fn approval_invalidation_rejects_any_single_bit_or_target_or_expiry_mutation() {
        let h1_patch = blake3::hash(b"patch-payload-original").to_hex().to_string();
        let plan_digest = blake3::hash(b"execution-plan-v1").to_hex().to_string();
        let approved_digest = Approval::compute_action_digest(
            &h1_patch,
            &plan_digest,
            &TargetEnvironment::Staging,
            &ApprovalActionKind::ApplyChangeSet,
        );

        let approval = Approval {
            schema_version: CONTRACT_SCHEMA_VERSION,
            approval_id: "appr-sec-001".to_string(),
            actor_identity: "security-reviewer@coloride.dev".to_string(),
            target_env: TargetEnvironment::Staging,
            action_kind: ApprovalActionKind::ApplyChangeSet,
            approved_digest: approved_digest.clone(),
            expires_at: 2_000_000,
        };

        // Baseline: exact match before expiration succeeds.
        assert!(approval.is_valid_for(&TargetEnvironment::Staging, &approved_digest, 1_999_999));
        assert!(approval.is_valid_for_plan_and_patch(
            &TargetEnvironment::Staging,
            &ApprovalActionKind::ApplyChangeSet,
            &h1_patch,
            &plan_digest,
            1_999_999,
        ));

        // 1. Mutate 1 bit / 1 byte of the patch (`changeset_digest = H2`)
        let h2_patch = blake3::hash(b"patch-payload-originaL").to_hex().to_string();
        let mutated_patch_digest = Approval::compute_action_digest(
            &h2_patch,
            &plan_digest,
            &TargetEnvironment::Staging,
            &ApprovalActionKind::ApplyChangeSet,
        );
        assert!(!approval.is_valid_for(
            &TargetEnvironment::Staging,
            &mutated_patch_digest,
            1_999_999
        ));
        assert!(!approval.is_valid_for_plan_and_patch(
            &TargetEnvironment::Staging,
            &ApprovalActionKind::ApplyChangeSet,
            &h2_patch,
            &plan_digest,
            1_999_999,
        ));

        // 2. Flip a single hex character in `approved_digest` directly
        let mut flipped_bytes = approved_digest.clone().into_bytes();
        flipped_bytes[0] = if flipped_bytes[0] == b'0' { b'1' } else { b'0' };
        let single_bit_flipped_digest = String::from_utf8(flipped_bytes).unwrap();
        assert!(!approval.is_valid_for(
            &TargetEnvironment::Staging,
            &single_bit_flipped_digest,
            1_999_999
        ));

        // 3. Mutate 1 bit of the execution plan digest
        let mutated_plan = blake3::hash(b"execution-plan-v2").to_hex().to_string();
        assert!(!approval.is_valid_for_plan_and_patch(
            &TargetEnvironment::Staging,
            &ApprovalActionKind::ApplyChangeSet,
            &h1_patch,
            &mutated_plan,
            1_999_999,
        ));

        // 4. Change target environment from Staging to Production
        assert!(!approval.is_valid_for(
            &TargetEnvironment::Production,
            &approved_digest,
            1_999_999
        ));
        assert!(!approval.is_valid_for_plan_and_patch(
            &TargetEnvironment::Production,
            &ApprovalActionKind::ApplyChangeSet,
            &h1_patch,
            &plan_digest,
            1_999_999,
        ));

        // 5. Change action kind
        assert!(!approval.is_valid_for_plan_and_patch(
            &TargetEnvironment::Staging,
            &ApprovalActionKind::DeployInfrastructure,
            &h1_patch,
            &plan_digest,
            1_999_999,
        ));

        // 6. Expired timestamp (`now == expires_at` and `now > expires_at`)
        assert!(!approval.is_valid_for(&TargetEnvironment::Staging, &approved_digest, 2_000_000));
        assert!(!approval.is_valid_for(&TargetEnvironment::Staging, &approved_digest, 2_000_001));
    }
}
