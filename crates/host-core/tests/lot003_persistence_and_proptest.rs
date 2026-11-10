use std::fs::OpenOptions;
use std::io::Write;
use std::time::Instant;

use host_core::{
    compute_rope_blake3_hex, line_col_to_utf16, recover_workspace_from_journal, utf16_span_to_utf8,
    utf16_to_line_col, utf16_to_utf8, utf8_span_to_utf16, utf8_to_utf16, ColorideValidationState,
    DocumentError, DocumentService, EditorSelection, EditorTransaction, OffsetConversionError,
    TextChange, TransactionOrigin, Utf16CodeUnitOffset, Utf16Span, Utf8ByteOffset,
    CONTRACT_SCHEMA_VERSION,
};
use proptest::prelude::*;
use ropey::Rope;
use tempfile::tempdir;

/// Reference UTF-16 document model that only allows edits at valid scalar character boundaries.
#[derive(Debug, Clone)]
struct Utf16ReferenceModel {
    text: String,
    utf16_units: Vec<u16>,
    valid_utf16_boundaries: Vec<u32>,
}

impl Utf16ReferenceModel {
    fn new(initial: &str) -> Self {
        let mut model = Self {
            text: String::new(),
            utf16_units: Vec::new(),
            valid_utf16_boundaries: vec![0],
        };
        model.rebuild(initial.to_string());
        model
    }

    fn rebuild(&mut self, next_text: String) {
        self.utf16_units = next_text.encode_utf16().collect();
        let mut boundaries = Vec::with_capacity(next_text.chars().count() + 1);
        let mut cu_offset = 0u32;
        boundaries.push(0);
        for ch in next_text.chars() {
            cu_offset += ch.len_utf16() as u32;
            boundaries.push(cu_offset);
        }
        self.text = next_text;
        self.valid_utf16_boundaries = boundaries;
    }

    fn apply_utf16_edit(&mut self, start_cu: u32, end_cu: u32, inserted: &str) {
        let start_usize = start_cu as usize;
        let end_usize = end_cu as usize;
        let mut next_units = Vec::with_capacity(
            self.utf16_units.len() - (end_usize - start_usize) + inserted.encode_utf16().count(),
        );
        next_units.extend_from_slice(&self.utf16_units[..start_usize]);
        next_units.extend(inserted.encode_utf16());
        next_units.extend_from_slice(&self.utf16_units[end_usize..]);

        let decoded =
            String::from_utf16(&next_units).expect("reference edit must preserve valid UTF-16");
        self.rebuild(decoded);
    }
}

#[derive(Debug, Clone)]
struct GeneratedEditStep {
    start_boundary_idx: usize,
    end_boundary_idx: usize,
    inserted_text: String,
}

fn rich_unicode_fragment_strategy() -> impl Strategy<Value = String> {
    prop::sample::select(vec![
        "",
        "a",
        "const x = 42;",
        "\n",
        "\r\n",
        "日本語のテキスト",
        "漢字とかな",
        "한국어",
        "🦀",
        "👩‍💻",
        "👨‍👩‍👧‍👦",
        "🏳️‍🌈",
        "éàçüö",
        "fn calc() -> Result<(), Error> {\r\n    Ok(())\n}\n",
        "// 👩‍💻 CJK: 東京 🚀\r\n",
    ])
    .prop_map(str::to_string)
}

fn edit_step_strategy() -> impl Strategy<Value = GeneratedEditStep> {
    (
        0usize..1024usize,
        0usize..1024usize,
        prop::collection::vec(rich_unicode_fragment_strategy(), 0..=3),
    )
        .prop_map(|(a, b, fragments)| GeneratedEditStep {
            start_boundary_idx: a,
            end_boundary_idx: b,
            inserted_text: fragments.concat(),
        })
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 1000,
        max_shrink_iters: 256,
        .. ProptestConfig::default()
    })]

    /// LOT-003 Mandatory Test #1:
    /// 1,000 random edit sequences mixing ASCII, CJK, multi-codepoint ZWJ emojis (`👩‍💻`),
    /// and `\n`/`\r\n` verifying 100% equivalence between `ropey` (`DocumentService`)
    /// and a UTF-16 reference model, plus roundtrip UTF-8 <-> UTF-16 & LineCol conversions.
    #[test]
    fn proptest_1000_random_unicode_edit_sequences_match_utf16_reference(
        initial_fragments in prop::collection::vec(rich_unicode_fragment_strategy(), 0..=6),
        steps in prop::collection::vec(edit_step_strategy(), 1..=12),
    ) {
        let initial_text = initial_fragments.concat();
        let mut reference = Utf16ReferenceModel::new(&initial_text);
        let mut service = DocumentService::new_in_memory();

        let doc_id = "doc-proptest";
        let generation = 1;
        let initial_snap = service
            .open_document_from_str(doc_id, generation, None, &initial_text)
            .expect("open_document_from_str should succeed");
        prop_assert_eq!(initial_snap.interactive_revision, 0);
        prop_assert!(!initial_snap.has_unsaved_changes);

        for (step_idx, step) in steps.iter().enumerate() {
            let boundary_count = reference.valid_utf16_boundaries.len();
            let idx_a = step.start_boundary_idx % boundary_count;
            let idx_b = step.end_boundary_idx % boundary_count;
            let (start_idx, end_idx) = if idx_a <= idx_b { (idx_a, idx_b) } else { (idx_b, idx_a) };

            let start_cu = reference.valid_utf16_boundaries[start_idx];
            let end_cu = reference.valid_utf16_boundaries[end_idx];

            reference.apply_utf16_edit(start_cu, end_cu, &step.inserted_text);

            let head_cu = start_cu + step.inserted_text.encode_utf16().count() as u32;
            let tx = EditorTransaction {
                schema_version: CONTRACT_SCHEMA_VERSION,
                document_id: doc_id.to_string(),
                session_generation: generation,
                base_revision: step_idx as u32,
                op_id: format!("op-{step_idx}"),
                changes: vec![TextChange {
                    range_utf16: Utf16Span::new(
                        Utf16CodeUnitOffset::new(start_cu),
                        Utf16CodeUnitOffset::new(end_cu),
                    ),
                    range_utf8: None,
                    inserted_text: step.inserted_text.clone(),
                }],
                selection: EditorSelection {
                    anchor: Utf16CodeUnitOffset::new(head_cu),
                    head: Utf16CodeUnitOffset::new(head_cu),
                    cursor_line_col: None,
                },
                origin: TransactionOrigin::User,
                ime_composing: false,
            };

            let snap = service
                .apply_transaction(tx)
                .expect("apply_transaction must succeed on valid scalar boundaries");

            let session = service.session(doc_id, generation).expect("session exists");
            prop_assert_eq!(session.text(), reference.text.as_str());
            prop_assert_eq!(
                session.rope().len_utf16_cu(),
                reference.utf16_units.len()
            );
            prop_assert_eq!(snap.interactive_revision, (step_idx + 1) as u32);
            prop_assert_eq!(snap.journaled_revision, (step_idx + 1) as u32);

            let expected_hash = blake3::hash(reference.text.as_bytes()).to_hex().to_string();
            prop_assert_eq!(snap.content_blake3_hash, expected_hash);
        }

        // Verify bidirectional UTF-16 <-> UTF-8 and LineCol roundtrips across all character boundaries
        let session = service.session(doc_id, generation).expect("session exists");
        let rope = session.rope();
        let mut byte_cursor = 0u32;
        let mut cu_cursor = 0u32;

        for ch in reference.text.chars() {
            let offset_utf16 = Utf16CodeUnitOffset::new(cu_cursor);
            let offset_utf8 = Utf8ByteOffset::new(byte_cursor);

            let converted_utf8 = utf16_to_utf8(rope, offset_utf16).expect("utf16_to_utf8 valid");
            let converted_utf16 = utf8_to_utf16(rope, offset_utf8).expect("utf8_to_utf16 valid");
            prop_assert_eq!(converted_utf8, offset_utf8);
            prop_assert_eq!(converted_utf16, offset_utf16);

            // For non-CR characters before LF (since a bare \r in \r\n is part of the line terminator),
            // verify utf16_to_line_col -> line_col_to_utf16 roundtrip.
            if ch != '\r' && ch != '\n' {
                let lc = utf16_to_line_col(rope, offset_utf16).expect("utf16_to_line_col valid");
                let roundtrip_cu = line_col_to_utf16(rope, lc).expect("line_col_to_utf16 valid");
                prop_assert_eq!(roundtrip_cu, offset_utf16);
            }

            byte_cursor += ch.len_utf8() as u32;
            cu_cursor += ch.len_utf16() as u32;
        }

        let end_utf16 = Utf16CodeUnitOffset::new(cu_cursor);
        let end_utf8 = Utf8ByteOffset::new(byte_cursor);
        prop_assert_eq!(utf16_to_utf8(rope, end_utf16).unwrap(), end_utf8);
        prop_assert_eq!(utf8_to_utf16(rope, end_utf8).unwrap(), end_utf16);
    }
}

/// LOT-003 Mandatory Test #2 (Section 5 Blocking Scenario):
/// Edit during an active disk save and simulate a process crash;
/// verify zero false "saved" state (`has_unsaved_changes == true`) and 100% recovery
/// of the latest journaled revision (`T+1`) with `disk_saved_revision == T`.
#[test]
fn concurrent_save_and_crash_recovery_preserves_unsaved_state_and_restores_latest_revision() {
    let dir = tempdir().expect("create tempdir");
    let wal_path = dir.path().join("workspace.wal");
    let file_path = dir.path().join("src").join("engine.ts");
    std::fs::create_dir_all(file_path.parent().unwrap()).unwrap();
    let initial_source = "export const version = 1;\n";
    std::fs::write(&file_path, initial_source).unwrap();

    let doc_id = "src/engine.ts";
    let generation = 1;

    let expected_t1_hash: String;
    let expected_t2_hash: String;

    {
        let mut service = DocumentService::with_journal(&wal_path).expect("open WAL service");
        let open_snap = service
            .open_document_from_disk(doc_id, generation, &file_path)
            .expect("open document from disk");
        assert_eq!(open_snap.interactive_revision, 0);
        assert_eq!(open_snap.disk_saved_revision, 0);
        assert!(!open_snap.has_unsaved_changes);

        // Apply Transaction T=1: replace `1` with `2` ("export const version = 2;\n")
        let tx_t1 = EditorTransaction {
            schema_version: CONTRACT_SCHEMA_VERSION,
            document_id: doc_id.to_string(),
            session_generation: generation,
            base_revision: 0,
            op_id: "op-t1".to_string(),
            changes: vec![TextChange {
                range_utf16: Utf16Span::new(
                    Utf16CodeUnitOffset::new(23),
                    Utf16CodeUnitOffset::new(24),
                ),
                range_utf8: None,
                inserted_text: "2".to_string(),
            }],
            selection: EditorSelection {
                anchor: Utf16CodeUnitOffset::new(24),
                head: Utf16CodeUnitOffset::new(24),
                cursor_line_col: None,
            },
            origin: TransactionOrigin::User,
            ime_composing: false,
        };
        let snap_t1 = service.apply_transaction(tx_t1).expect("apply T=1");
        assert_eq!(snap_t1.interactive_revision, 1);
        assert_eq!(snap_t1.journaled_revision, 1);
        assert_eq!(snap_t1.disk_saved_revision, 0);
        assert!(snap_t1.has_unsaved_changes);
        expected_t1_hash = snap_t1.content_blake3_hash.clone();

        // Begin atomic disk save for revision T=1.
        let pending_save_t1 = service
            .begin_atomic_save(doc_id, generation)
            .expect("begin_atomic_save for T=1");
        assert_eq!(pending_save_t1.target_revision, 1);

        // Flush T=1 to disk while transaction T+1 (revision 2) arrives concurrently!
        pending_save_t1
            .flush_to_disk()
            .expect("flush T=1 to disk succeeds");

        // Transaction T+1 (revision 2) arrives BEFORE T=1 save completion is committed:
        // append `export const status = "👩‍💻 active";\n`
        let tx_t2 = EditorTransaction {
            schema_version: CONTRACT_SCHEMA_VERSION,
            document_id: doc_id.to_string(),
            session_generation: generation,
            base_revision: 1,
            op_id: "op-t2".to_string(),
            changes: vec![TextChange {
                range_utf16: Utf16Span::new(
                    Utf16CodeUnitOffset::new(26),
                    Utf16CodeUnitOffset::new(26),
                ),
                range_utf8: None,
                inserted_text: "export const status = \"👩‍💻 active\";\n".to_string(),
            }],
            selection: EditorSelection {
                anchor: Utf16CodeUnitOffset::new(26),
                head: Utf16CodeUnitOffset::new(26),
                cursor_line_col: None,
            },
            origin: TransactionOrigin::User,
            ime_composing: false,
        };
        let snap_t2 = service.apply_transaction(tx_t2).expect("apply T=2");
        assert_eq!(snap_t2.interactive_revision, 2);
        assert_eq!(snap_t2.journaled_revision, 2);
        assert_eq!(snap_t2.disk_saved_revision, 0);
        assert!(snap_t2.has_unsaved_changes);
        expected_t2_hash = snap_t2.content_blake3_hash.clone();

        // Now complete the atomic save for T=1.
        // INVARIANT: disk_saved_revision must update to 1 (NOT 2), and has_unsaved_changes MUST stay true!
        let post_save_snap = service
            .complete_atomic_save(&pending_save_t1)
            .expect("complete_atomic_save for T=1");
        assert_eq!(post_save_snap.interactive_revision, 2);
        assert_eq!(post_save_snap.journaled_revision, 2);
        assert_eq!(post_save_snap.disk_saved_revision, 1);
        assert!(
            post_save_snap.has_unsaved_changes,
            "Must NEVER report a false saved state when T+1 arrived during save of T"
        );
        assert!(!post_save_snap.is_disk_saved());

        // Verify disk file currently holds T=1 content.
        let on_disk_text = std::fs::read_to_string(&file_path).unwrap();
        assert_eq!(on_disk_text, "export const version = 2;\n");
        assert_eq!(
            blake3::hash(on_disk_text.as_bytes()).to_hex().to_string(),
            expected_t1_hash
        );
        // Simulate abrupt process crash here (service is dropped without saving T=2 to disk).
    }

    // Also append a torn/incomplete WAL frame at the tail to simulate a power loss mid-write.
    {
        let mut wal_file = OpenOptions::new().append(true).open(&wal_path).unwrap();
        wal_file
            .write_all(b"CLRWAL01\x99\x00\x00\x00partial_torn_payload")
            .unwrap();
        wal_file.flush().unwrap();
    }

    // Recover the workspace from the WAL journal after the simulated crash.
    let recovered_service =
        recover_workspace_from_journal(&wal_path).expect("recover_workspace_from_journal succeeds");
    let recovered_session = recovered_service
        .session(doc_id, generation)
        .expect("recovered session exists");
    let recovered_snap = recovered_session.snapshot();

    assert_eq!(
        recovered_session.text(),
        "export const version = 2;\nexport const status = \"👩‍💻 active\";\n"
    );
    assert_eq!(recovered_snap.interactive_revision, 2);
    assert_eq!(recovered_snap.journaled_revision, 2);
    assert_eq!(recovered_snap.disk_saved_revision, 1);
    assert_eq!(recovered_snap.content_blake3_hash, expected_t2_hash);
    assert!(
        recovered_snap.has_unsaved_changes,
        "Recovered session must preserve unsaved status for revision T+1"
    );
}

/// LOT-003 Mandatory Test #3:
/// Load a 1 MB local file into `Rope` in p95 <= 50 ms on the Rust side.
#[test]
fn load_1mb_file_into_rope_under_50ms_p95() {
    let dir = tempdir().expect("create tempdir");
    let file_path = dir.path().join("one_megabyte.ts");

    let line = "export const item_👩‍💻_東京 = { id: 12345, label: \"Coloride Fast Rope Buffer\" };\n";
    let target_bytes = 1_048_576usize; // 1 MiB
    let mut content = String::with_capacity(target_bytes + line.len());
    while content.len() < target_bytes {
        content.push_str(line);
    }
    content.truncate(target_bytes);
    while !content.is_char_boundary(content.len()) {
        content.pop();
    }
    std::fs::write(&file_path, &content).expect("write 1MB test file");
    let expected_hash = compute_rope_blake3_hex(&Rope::from_str(&content));
    // Warm up OS filesystem cache once before measuring p95 Rope load latency
    let _ = std::fs::read(&file_path).expect("warm up file cache");

    let iterations = 20usize;
    let mut durations_ms = Vec::with_capacity(iterations);

    for i in 0..iterations {
        let mut service = DocumentService::new_in_memory();
        let start = Instant::now();
        let snap = service
            .open_document_from_disk(format!("doc-{i}"), 1, &file_path)
            .expect("open 1MB file into Rope");
        let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        durations_ms.push(elapsed_ms);

        let session = service.session(&format!("doc-{i}"), 1).unwrap();
        assert_eq!(session.rope().len_bytes(), content.len());
        assert_eq!(snap.content_blake3_hash, expected_hash);
    }

    durations_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p95_idx = ((iterations as f64 * 0.95).ceil() as usize).saturating_sub(1);
    let p95_ms = durations_ms[p95_idx];
    assert!(
        p95_ms <= 50.0,
        "1 MB file load p95 was {p95_ms:.2} ms, exceeding the 50 ms budget (samples: {durations_ms:?})"
    );
}

#[test]
fn rejects_unaligned_utf16_surrogate_and_utf8_mid_codepoint_offsets() {
    let rope = Rope::from_str("👩‍💻");
    assert_eq!(rope.len_bytes(), 11);
    assert_eq!(rope.len_utf16_cu(), 5);

    // UTF-16 offset 1 splits the high/low surrogate pair of 👩
    let err_utf16 = utf16_to_utf8(&rope, Utf16CodeUnitOffset::new(1)).unwrap_err();
    assert_eq!(
        err_utf16,
        OffsetConversionError::UnalignedUtf16Surrogate {
            offset: Utf16CodeUnitOffset::new(1)
        }
    );

    // UTF-16 offset 4 splits the surrogate pair of 💻
    let err_utf16_2 = utf16_to_utf8(&rope, Utf16CodeUnitOffset::new(4)).unwrap_err();
    assert_eq!(
        err_utf16_2,
        OffsetConversionError::UnalignedUtf16Surrogate {
            offset: Utf16CodeUnitOffset::new(4)
        }
    );

    // UTF-8 offset 2 is inside the 4-byte sequence of 👩
    let err_utf8 = utf8_to_utf16(&rope, Utf8ByteOffset::new(2)).unwrap_err();
    assert_eq!(
        err_utf8,
        OffsetConversionError::UnalignedUtf8CharBoundary {
            offset: Utf8ByteOffset::new(2)
        }
    );

    // Valid boundaries convert cleanly
    let span_utf8 = utf16_span_to_utf8(
        &rope,
        Utf16Span::new(Utf16CodeUnitOffset::new(0), Utf16CodeUnitOffset::new(5)),
    )
    .unwrap();
    assert_eq!(span_utf8.start, Utf8ByteOffset::new(0));
    assert_eq!(span_utf8.end, Utf8ByteOffset::new(11));
    assert_eq!(
        utf8_span_to_utf16(&rope, span_utf8).unwrap(),
        Utf16Span::new(Utf16CodeUnitOffset::new(0), Utf16CodeUnitOffset::new(5))
    );
}

#[test]
fn detects_external_disk_conflict_and_blocks_overwrite() {
    let dir = tempdir().expect("create tempdir");
    let file_path = dir.path().join("conflict.ts");
    std::fs::write(&file_path, "const a = 1;\n").unwrap();

    let mut service = DocumentService::new_in_memory();
    service
        .open_document_from_disk("conflict.ts", 1, &file_path)
        .unwrap();

    let tx = EditorTransaction {
        schema_version: CONTRACT_SCHEMA_VERSION,
        document_id: "conflict.ts".to_string(),
        session_generation: 1,
        base_revision: 0,
        op_id: "op-1".to_string(),
        changes: vec![TextChange {
            range_utf16: Utf16Span::new(Utf16CodeUnitOffset::new(10), Utf16CodeUnitOffset::new(11)),
            range_utf8: None,
            inserted_text: "2".to_string(),
        }],
        selection: EditorSelection::default(),
        origin: TransactionOrigin::User,
        ime_composing: false,
    };
    service.apply_transaction(tx).unwrap();

    // Another external process modifies the file on disk behind Coloride's back
    std::fs::write(&file_path, "const a = 999; // external edit\n").unwrap();

    let conflict = service
        .detect_external_disk_conflict("conflict.ts", 1)
        .unwrap();
    assert!(conflict.is_some());

    // Attempting an atomic save must fail with ExternalDiskConflict instead of silently overwriting
    let save_err = service.save_document_atomic("conflict.ts", 1).unwrap_err();
    assert!(matches!(
        save_err,
        DocumentError::ExternalDiskConflict { .. }
    ));
    assert_eq!(
        std::fs::read_to_string(&file_path).unwrap(),
        "const a = 999; // external edit\n"
    );
}

#[test]
fn local_user_edit_synchronously_downgrades_validated_green_to_stale_orange() {
    let mut service = DocumentService::new_in_memory();
    let initial = "function add(a: number, b: number) {\n  return a + b;\n}\n";
    service
        .open_document_from_str("math.ts", 1, None, initial)
        .unwrap();

    {
        let session = service.session_mut("math.ts", 1).unwrap();
        let len_cu = session.rope().len_utf16_cu() as u32;
        session
            .set_validation_ranges(vec![(
                Utf16Span::new(Utf16CodeUnitOffset::ZERO, Utf16CodeUnitOffset::new(len_cu)),
                ColorideValidationState::ValidatedGreen,
            )])
            .unwrap();
    }

    // Edit a single character inside the ValidatedGreen range (`+` -> `*`)
    let plus_idx = initial.find('+').unwrap() as u32;
    let tx = EditorTransaction {
        schema_version: CONTRACT_SCHEMA_VERSION,
        document_id: "math.ts".to_string(),
        session_generation: 1,
        base_revision: 0,
        op_id: "edit-plus".to_string(),
        changes: vec![TextChange {
            range_utf16: Utf16Span::new(
                Utf16CodeUnitOffset::new(plus_idx),
                Utf16CodeUnitOffset::new(plus_idx + 1),
            ),
            range_utf8: None,
            inserted_text: "*".to_string(),
        }],
        selection: EditorSelection::default(),
        origin: TransactionOrigin::User,
        ime_composing: false,
    };

    service.apply_transaction(tx).unwrap();
    let session = service.session("math.ts", 1).unwrap();
    assert_eq!(
        session.validation_ranges()[0].state,
        ColorideValidationState::StaleOrange
    );
}

#[test]
fn group_commit_journal_distinguishes_interactive_and_journaled_revisions() {
    let dir = tempdir().expect("create tempdir");
    let wal_path = dir.path().join("group_commit.wal");
    let mut service = DocumentService::with_journal(&wal_path).unwrap();

    service
        .open_document_from_str("notes.md", 1, None, "Hello")
        .unwrap();

    let tx = EditorTransaction {
        schema_version: CONTRACT_SCHEMA_VERSION,
        document_id: "notes.md".to_string(),
        session_generation: 1,
        base_revision: 0,
        op_id: "op-gc-1".to_string(),
        changes: vec![TextChange {
            range_utf16: Utf16Span::new(Utf16CodeUnitOffset::new(5), Utf16CodeUnitOffset::new(5)),
            range_utf8: None,
            inserted_text: " World".to_string(),
        }],
        selection: EditorSelection::default(),
        origin: TransactionOrigin::User,
        ime_composing: false,
    };

    let snap_unflushed = service.apply_transaction_unflushed(tx).unwrap();
    assert_eq!(snap_unflushed.interactive_revision, 1);
    assert_eq!(snap_unflushed.journaled_revision, 0);
    assert!(!snap_unflushed.is_fully_journaled());

    let flushed_snaps = service.flush_journal().unwrap();
    assert_eq!(flushed_snaps.len(), 1);
    assert_eq!(flushed_snaps[0].interactive_revision, 1);
    assert_eq!(flushed_snaps[0].journaled_revision, 1);
    assert!(flushed_snaps[0].is_fully_journaled());
}

#[test]
fn rejects_stale_session_generation_and_revision_mismatch_and_rolls_back_invalid_batch() {
    let mut service = DocumentService::new_in_memory();
    service
        .open_document_from_str("app.tsx", 1, None, "const count = 0;\n")
        .unwrap();
    // Re-open with generation 2 (e.g. tab reloaded)
    service
        .open_document_from_str("app.tsx", 2, None, "const count = 10;\n")
        .unwrap();

    // Delayed IPC transaction targeting generation 99 (stale/unknown)
    let stale_tx = EditorTransaction {
        schema_version: CONTRACT_SCHEMA_VERSION,
        document_id: "app.tsx".to_string(),
        session_generation: 99,
        base_revision: 0,
        op_id: "op-stale".to_string(),
        changes: vec![],
        selection: EditorSelection::default(),
        origin: TransactionOrigin::User,
        ime_composing: false,
    };
    let err_gen = service.apply_transaction(stale_tx).unwrap_err();
    assert!(matches!(
        err_gen,
        DocumentError::StaleSessionGeneration {
            expected: 2,
            actual: 99,
            ..
        }
    ));

    // Transaction with wrong base_revision on generation 2
    let bad_rev_tx = EditorTransaction {
        schema_version: CONTRACT_SCHEMA_VERSION,
        document_id: "app.tsx".to_string(),
        session_generation: 2,
        base_revision: 5,
        op_id: "op-bad-rev".to_string(),
        changes: vec![],
        selection: EditorSelection::default(),
        origin: TransactionOrigin::User,
        ime_composing: false,
    };
    let err_rev = service.apply_transaction(bad_rev_tx).unwrap_err();
    assert!(matches!(
        err_rev,
        DocumentError::RevisionMismatch {
            expected: 0,
            actual: 5,
            ..
        }
    ));

    // Multi-change batch where the 1st change is valid and the 2nd change is out-of-bounds:
    // the entire transaction must be rolled back atomically.
    let partial_invalid_tx = EditorTransaction {
        schema_version: CONTRACT_SCHEMA_VERSION,
        document_id: "app.tsx".to_string(),
        session_generation: 2,
        base_revision: 0,
        op_id: "op-atomic-rollback".to_string(),
        changes: vec![
            TextChange {
                range_utf16: Utf16Span::new(
                    Utf16CodeUnitOffset::new(0),
                    Utf16CodeUnitOffset::new(5),
                ),
                range_utf8: None,
                inserted_text: "let".to_string(),
            },
            TextChange {
                range_utf16: Utf16Span::new(
                    Utf16CodeUnitOffset::new(500),
                    Utf16CodeUnitOffset::new(505),
                ),
                range_utf8: None,
                inserted_text: "boom".to_string(),
            },
        ],
        selection: EditorSelection::default(),
        origin: TransactionOrigin::User,
        ime_composing: false,
    };
    assert!(service.apply_transaction(partial_invalid_tx).is_err());

    let session = service.session("app.tsx", 2).unwrap();
    assert_eq!(session.text(), "const count = 10;\n");
    assert_eq!(session.interactive_revision(), 0);
}
