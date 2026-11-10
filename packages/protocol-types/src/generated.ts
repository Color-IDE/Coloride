// AUTO-GENERATED FILE — DO NOT EDIT MANUALLY.
// Source of truth: crates/host-core/src/contracts.rs (LOT-002)
// Regenerate with: cargo test --package host-core export_bindings

export const CONTRACT_SCHEMA_VERSION = 1 as const;

export type Utf8ByteOffset = number;

export type Utf16CodeUnitOffset = number;

export type LineCol = {
  line: number;
  col_utf16: number;
};

export type Utf8Span = {
  start: Utf8ByteOffset;
  end: Utf8ByteOffset;
};

export type Utf16Span = {
  start: Utf16CodeUnitOffset;
  end: Utf16CodeUnitOffset;
};

export type ColorideValidationState =
  | "ValidatedGreen"
  | "ReviewYellow"
  | "FailedRed"
  | "StaleOrange"
  | "UnchangedBlue";

export type TaskState =
  | "Created"
  | "ContextReady"
  | "Planned"
  | "Running"
  | "Verifying"
  | "AwaitingReview"
  | "Applied"
  | "Paused"
  | "Failed"
  | "Cancelled"
  | "NeedsReconciliation";

export type TransactionOrigin =
  | "User"
  | { Agent: { task_id: string } }
  | { Peer: { peer_id: string } }
  | { Extension: { extension_id: string } };

export type TextChange = {
  range_utf16: Utf16Span;
  range_utf8: Utf8Span | null;
  inserted_text: string;
};

export type EditorSelection = {
  anchor: Utf16CodeUnitOffset;
  head: Utf16CodeUnitOffset;
  cursor_line_col: LineCol | null;
};

export type EditorTransaction = {
  schema_version: number;
  document_id: string;
  session_generation: number;
  base_revision: number;
  op_id: string;
  changes: Array<TextChange>;
  selection: EditorSelection;
  origin: TransactionOrigin;
  ime_composing: boolean;
};

export type EditorSnapshot = {
  schema_version: number;
  document_id: string;
  session_generation: number;
  interactive_revision: number;
  journaled_revision: number;
  disk_saved_revision: number;
  content_blake3_hash: string;
  has_unsaved_changes: boolean;
};

export type TargetEnvironment =
  | "LocalWorktree"
  | "LocalOciSandbox"
  | "Staging"
  | "Production"
  | "SanitizedDatabaseClone";

export type AutonomyLevel = "ProposalOnly" | "SupervisedSandbox" | "BoundedAutoCorrect";

export type ExecutionPolicy = {
  autonomy_level: AutonomyLevel;
  network_allowed: boolean;
  allowed_paths: Array<string>;
  forbidden_paths: Array<string>;
  max_auto_retries: number;
  workspace_trusted: boolean;
};

export type BudgetLimits = {
  max_cost_usd_micros: number;
  max_tokens: number;
  max_cpu_ms: number;
  max_tool_calls: number;
};

export type TaskSpec = {
  schema_version: number;
  task_id: string;
  objective: string;
  workspace_id: string;
  base_snapshot_id: string;
  target_env: TargetEnvironment;
  policy: ExecutionPolicy;
  budget_limits: BudgetLimits;
  acceptance_criteria: Array<string>;
  state: TaskState;
};

export type ConfidenceLevel = "ExactAstLsp" | "LexicalBm25" | "VectorSemantic" | "HeuristicText";

export type ExcerptFreshness = "LiveUnsavedBuffer" | "IndexedCommit" | "StaleNeedsReindex";

export type DataClassification = "Public" | "Internal" | "Confidential" | "RestrictedFiltered";

export type AuthorizedDestination =
  | "LocalOnly"
  | { ByokProvider: { provider_id: string } }
  | "ManagedCloudEu"
  | "PrivateEnterpriseVllm";

export type ContextExcerpt = {
  source_path: string;
  document_revision: number;
  content_blake3_hash: string;
  span_utf8: Utf8Span;
  start_line_col: LineCol;
  end_line_col: LineCol;
  content: string;
  confidence: ConfidenceLevel;
  freshness: ExcerptFreshness;
};

export type ContextBundle = {
  schema_version: number;
  bundle_id: string;
  workspace_version: string;
  excerpts: Array<ContextExcerpt>;
  token_budget_used: number;
  token_budget_max: number;
  classification: DataClassification;
  authorized_destination: AuthorizedDestination;
  cache_control_prefix: string | null;
};

export type ModelProviderKind =
  | "LocalLlamaCpp"
  | "LocalOllama"
  | "ByokCloud"
  | "ManagedColorideCloud"
  | "PrivateVllm"
  | "AcpExternalAgent";

export type ModelCapabilities = {
  supports_streaming: boolean;
  supports_structured_tool_calls: boolean;
  supports_prompt_caching: boolean;
  max_context_tokens: number;
  max_output_tokens: number;
};

export type ModelUsageMetrics = {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  latency_ms: number;
  cost_usd_micros: number;
};

export type ModelProvider = {
  schema_version: number;
  provider_id: string;
  model_name: string;
  kind: ModelProviderKind;
  capabilities: ModelCapabilities;
  streaming_enabled: boolean;
  structured_tool_calls: boolean;
  cancellation_token_id: string;
  usage_metrics: ModelUsageMetrics;
};

export type ToolArgValue =
  | { Text: string }
  | { Integer: number }
  | { Boolean: boolean }
  | { StringList: Array<string> };

export type ToolCapability =
  | "ReadWorkspace"
  | "WriteWorktree"
  | "RunSandboxCommand"
  | "QueryLocalMcp"
  | "NetworkEgress"
  | "DatabaseRead"
  | "DatabaseMigrate"
  | "DeployPreview"
  | "DeployProduction";

export type ToolPrecondition = {
  description: string;
  required_snapshot_hash: string | null;
  requires_human_approval: boolean;
};

export type ToolCall = {
  schema_version: number;
  call_id: string;
  task_id: string;
  tool_name: string;
  validated_args: { [key in string]?: ToolArgValue };
  required_capabilities: Array<ToolCapability>;
  preconditions: Array<ToolPrecondition>;
  idempotency_key: string;
};

export type ChangeOperation =
  | {
      AstNodeReplace: {
        file_path: string;
        symbol_fqn: string;
        ast_node_kind: string;
        expected_span_utf8: Utf8Span;
        expected_block_blake3: string;
        replacement_code: string;
      };
    }
  | {
      SymbolSearchReplace: {
        file_path: string;
        anchor_symbol: string;
        search_block: string;
        replace_block: string;
        expected_before_blake3: string;
      };
    };

export type ChangeSet = {
  schema_version: number;
  changeset_id: string;
  task_id: string;
  base_revision: number;
  operations: Array<ChangeOperation>;
  affected_files: Array<string>;
  result_digest: string;
};

export type ExecutedCommandRecord = {
  command: string;
  args: Array<string>;
  exit_code: number;
  duration_ms: number;
  impacted_tests_only: boolean;
};

export type DiagnosticSeverity = "Error" | "Warning" | "Information";

export type DiagnosticSource = "Vtsls" | "Biome" | "Compiler" | "TestRunner" | "PreviewRuntime";

export type DiagnosticEntry = {
  file_path: string;
  span_utf16: Utf16Span;
  line_col: LineCol;
  source: DiagnosticSource;
  severity: DiagnosticSeverity;
  code: string;
  message: string;
};

export type QualityDiagnosticsSummary = {
  vtsls_error_count: number;
  vtsls_warning_count: number;
  biome_error_count: number;
  biome_warning_count: number;
  items: Array<DiagnosticEntry>;
};

export type PreviewRuntimeReport = {
  inspected_url: string;
  console_error_count: number;
  uncaught_exception_count: number;
  failed_network_request_count: number;
  crashed: boolean;
  dom_snapshot_hash: string | null;
};

export type EvidenceArtifact = {
  name: string;
  kind: string;
  digest_blake3: string;
  byte_size: number;
};

export type Evidence = {
  schema_version: number;
  evidence_id: string;
  task_id: string;
  tested_snapshot_hash: string;
  checkpoint_ref: string;
  commands: Array<ExecutedCommandRecord>;
  diagnostics: QualityDiagnosticsSummary;
  preview_report: PreviewRuntimeReport;
  artifacts: Array<EvidenceArtifact>;
  verdict: ColorideValidationState;
};

export type ApprovalActionKind =
  | "ApplyChangeSet"
  | "ExecuteToolCall"
  | "RunDatabaseMigration"
  | "DeployInfrastructure"
  | "PublishRelease";

export type Approval = {
  schema_version: number;
  approval_id: string;
  actor_identity: string;
  target_env: TargetEnvironment;
  action_kind: ApprovalActionKind;
  approved_digest: string;
  expires_at: number;
};
