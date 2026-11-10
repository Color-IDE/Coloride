import { describe, expect, it } from "vitest";
import {
  type Approval,
  COLORIDE_STATE_META,
  COLORIDE_VALIDATION_STATES,
  CONTRACT_SCHEMA_VERSION,
  type ChangeSet,
  type ContextBundle,
  type EditorSnapshot,
  type EditorTransaction,
  type Evidence,
  type ModelProvider,
  TASK_STATES,
  type TaskSpec,
  type ToolCall,
  isApprovalValidFor,
} from "./index.js";

describe("@coloride/protocol-types", () => {
  it("defines all 5 accessible Coloride validation states with distinct icons", () => {
    expect(COLORIDE_VALIDATION_STATES).toHaveLength(5);
    const icons = new Set(Object.values(COLORIDE_STATE_META).map((m) => m.icon));
    expect(icons.size).toBe(5);
    expect(COLORIDE_STATE_META.ValidatedGreen.icon).toBe("✓");
    expect(COLORIDE_STATE_META.StaleOrange.icon).toBe("⟳");
  });

  it("defines all 11 canonical task states", () => {
    expect(TASK_STATES).toEqual([
      "Created",
      "ContextReady",
      "Planned",
      "Running",
      "Verifying",
      "AwaitingReview",
      "Applied",
      "Paused",
      "Failed",
      "Cancelled",
      "NeedsReconciliation",
    ]);
  });

  it("exports all 9 canonical contracts and round-trips through JSON without precision loss", () => {
    const tx: EditorTransaction = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      document_id: "src/index.ts",
      session_generation: 1,
      base_revision: 10,
      op_id: "op-1",
      changes: [
        {
          range_utf16: { start: 0, end: 5 },
          range_utf8: { start: 0, end: 5 },
          inserted_text: "const 👩‍💻 = 1;",
        },
      ],
      selection: {
        anchor: 14,
        head: 14,
        cursor_line_col: { line: 0, col_utf16: 14 },
      },
      origin: "User",
      ime_composing: false,
    };

    const snapshot: EditorSnapshot = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      document_id: "src/index.ts",
      session_generation: 1,
      interactive_revision: 11,
      journaled_revision: 11,
      disk_saved_revision: 10,
      content_blake3_hash: "a".repeat(64),
      has_unsaved_changes: true,
    };

    const spec: TaskSpec = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      task_id: "task-1",
      objective: "Add strict contract types",
      workspace_id: "ws-1",
      base_snapshot_id: snapshot.content_blake3_hash,
      target_env: "LocalWorktree",
      policy: {
        autonomy_level: "BoundedAutoCorrect",
        network_allowed: false,
        allowed_paths: ["src/**"],
        forbidden_paths: [".env"],
        max_auto_retries: 2,
        workspace_trusted: true,
      },
      budget_limits: {
        max_cost_usd_micros: 1_000_000,
        max_tokens: 200_000,
        max_cpu_ms: 60_000,
        max_tool_calls: 20,
      },
      acceptance_criteria: ["All 9 contracts exported"],
      state: "Running",
    };

    const bundle: ContextBundle = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      bundle_id: "bundle-1",
      workspace_version: "v1",
      excerpts: [
        {
          source_path: "src/index.ts",
          document_revision: 11,
          content_blake3_hash: snapshot.content_blake3_hash,
          span_utf8: { start: 0, end: 18 },
          start_line_col: { line: 0, col_utf16: 0 },
          end_line_col: { line: 0, col_utf16: 14 },
          content: "const 👩‍💻 = 1;",
          confidence: "ExactAstLsp",
          freshness: "LiveUnsavedBuffer",
        },
      ],
      token_budget_used: 128,
      token_budget_max: 16_000,
      classification: "Internal",
      authorized_destination: "LocalOnly",
      cache_control_prefix: "prefix-v1",
    };

    const provider: ModelProvider = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      provider_id: "local-ollama",
      model_name: "qwen2.5-coder:7b",
      kind: "LocalOllama",
      capabilities: {
        supports_streaming: true,
        supports_structured_tool_calls: true,
        supports_prompt_caching: false,
        max_context_tokens: 32_768,
        max_output_tokens: 4_096,
      },
      streaming_enabled: true,
      structured_tool_calls: true,
      cancellation_token_id: "cancel-1",
      usage_metrics: {
        input_tokens: 512,
        output_tokens: 128,
        cached_input_tokens: 0,
        latency_ms: 190,
        cost_usd_micros: 0,
      },
    };

    const toolCall: ToolCall = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      call_id: "call-1",
      task_id: spec.task_id,
      tool_name: "sandbox.test",
      validated_args: {
        target: { Text: "packages/protocol-types" },
      },
      required_capabilities: ["ReadWorkspace", "RunSandboxCommand"],
      preconditions: [
        {
          description: "Clean snapshot",
          required_snapshot_hash: snapshot.content_blake3_hash,
          requires_human_approval: false,
        },
      ],
      idempotency_key: "idem-1",
    };

    const changeSet: ChangeSet = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      changeset_id: "cs-1",
      task_id: spec.task_id,
      base_revision: 11,
      operations: [
        {
          SymbolSearchReplace: {
            file_path: "src/index.ts",
            anchor_symbol: "main",
            search_block: "const x = 1;",
            replace_block: "const x = 2;",
            expected_before_blake3: snapshot.content_blake3_hash,
          },
        },
      ],
      affected_files: ["src/index.ts"],
      result_digest: "b".repeat(64),
    };

    const evidence: Evidence = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      evidence_id: "ev-1",
      task_id: spec.task_id,
      tested_snapshot_hash: changeSet.result_digest,
      checkpoint_ref: "refs/coloride/checkpoints/task-1",
      commands: [
        {
          command: "pnpm",
          args: ["test"],
          exit_code: 0,
          duration_ms: 350,
          impacted_tests_only: true,
        },
      ],
      diagnostics: {
        vtsls_error_count: 0,
        vtsls_warning_count: 0,
        biome_error_count: 0,
        biome_warning_count: 0,
        items: [],
      },
      preview_report: {
        inspected_url: "http://127.0.0.1:3000",
        console_error_count: 0,
        uncaught_exception_count: 0,
        failed_network_request_count: 0,
        crashed: false,
        dom_snapshot_hash: "c".repeat(64),
      },
      artifacts: [],
      verdict: "ValidatedGreen",
    };

    const approval: Approval = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      approval_id: "appr-1",
      actor_identity: "founder@coloride.dev",
      target_env: "Staging",
      action_kind: "ApplyChangeSet",
      approved_digest: changeSet.result_digest,
      expires_at: 2_000_000,
    };

    for (const contract of [
      tx,
      snapshot,
      spec,
      bundle,
      provider,
      toolCall,
      changeSet,
      evidence,
      approval,
    ]) {
      expect(JSON.parse(JSON.stringify(contract))).toEqual(contract);
    }
  });

  it("invalidates Approval when digest, target environment, or expiration changes", () => {
    const h1 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const h2 = "1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const approval: Approval = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      approval_id: "appr-sec",
      actor_identity: "reviewer@coloride.dev",
      target_env: "Staging",
      action_kind: "ApplyChangeSet",
      approved_digest: h1,
      expires_at: 5_000,
    };

    expect(isApprovalValidFor(approval, "Staging", h1, 4_999)).toBe(true);
    expect(isApprovalValidFor(approval, "Staging", h2, 4_999)).toBe(false);
    expect(isApprovalValidFor(approval, "Production", h1, 4_999)).toBe(false);
    expect(isApprovalValidFor(approval, "Staging", h1, 5_000)).toBe(false);
  });
});
