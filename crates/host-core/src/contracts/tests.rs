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
fn editor_ipc_codec_matches_the_typescript_fixture() {
    // Produced by packages/editor-cm6 encodeEditorTransactionBinary; keep this fixture
    // cross-language so a valid CM6 packet can never be mistaken for bincode again.
    let hex = "58544c43010005000000c3a92e74730700000003000000020000006f700100000001000000020000000004000000f09f9a8003000000030000000100000000030000000000";
    let bytes: Vec<u8> = hex
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            u8::from_str_radix(std::str::from_utf8(pair).expect("ASCII hex"), 16)
                .expect("valid hex")
        })
        .collect();
    let transaction = decode_editor_transaction_ipc(&bytes).expect("TypeScript fixture");
    assert_eq!(transaction.document_id, "é.ts");
    assert_eq!(transaction.session_generation, 7);
    assert_eq!(transaction.changes[0].inserted_text, "🚀");
    assert_eq!(encode_editor_transaction_ipc(&transaction).unwrap(), bytes);
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
                expected_span_utf8: Utf8Span::new(Utf8ByteOffset::new(0), Utf8ByteOffset::new(48)),
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
    assert!(!approval.is_valid_for(&TargetEnvironment::Production, &approved_digest, 1_999_999));
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
