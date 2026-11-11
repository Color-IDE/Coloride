use std::sync::Arc;
use std::time::{Duration, Instant};

use context_engine::{
    AclAndSecretScanner, DebouncedIndexer, IndexerEvent, SqliteWalContextEngine,
    DEFAULT_INDEX_DEBOUNCE_MS, DEFAULT_SQLITE_MMAP_SIZE_BYTES,
};
use host_core::{
    AuthorizedDestination, DataClassification, DocumentService, EditorSelection, EditorTransaction,
    ExcerptFreshness, TextChange, TransactionOrigin, Utf16CodeUnitOffset, Utf16Span,
    CONTRACT_SCHEMA_VERSION,
};
use tempfile::tempdir;
use tokio::sync::Mutex;

fn percentile_95_micros(samples_us: &[u128]) -> u128 {
    if samples_us.is_empty() {
        return 0;
    }
    let mut sorted = samples_us.to_vec();
    sorted.sort_unstable();
    let idx = ((sorted.len() * 95).div_ceil(100)).saturating_sub(1);
    sorted[idx.min(sorted.len() - 1)]
}

#[test]
fn blocking_unsaved_buffer_priority_over_stale_disk_file() {
    let dir = tempdir().expect("create tempdir");
    let workspace_root = dir.path();
    let db_path = workspace_root.join(".coloride/context.sqlite");
    let tax_file_disk_path = workspace_root.join("src/tax.ts");
    std::fs::create_dir_all(tax_file_disk_path.parent().expect("parent")).expect("mkdir src");

    let disk_content = "export const TAX_RATE = 0.20;\nexport function computeTax(amount: number): number { return amount * TAX_RATE; }\n";
    std::fs::write(&tax_file_disk_path, disk_content).expect("write disk tax.ts");

    let mut engine =
        SqliteWalContextEngine::open_or_rebuild_from_workspace(&db_path, workspace_root, "main")
            .expect("open context engine");

    // Verify 0 MB model download requirement & WAL/mmap pragmas
    assert_eq!(engine.pragmas().journal_mode, "WAL");
    assert_eq!(engine.pragmas().synchronous, "NORMAL");
    assert_eq!(engine.pragmas().mmap_size, DEFAULT_SQLITE_MMAP_SIZE_BYTES);
    assert!(engine.pragmas().zero_mb_model_download_required);

    // Initially, querying TAX_RATE returns the disk-indexed 0.20 value
    let initial_hits = engine.query_hybrid("TAX_RATE", 5);
    assert!(!initial_hits.is_empty());
    assert!(initial_hits[0].excerpt.content.contains("0.20"));
    assert!(!initial_hits[0].unsaved_buffer);
    assert_eq!(
        initial_hits[0].excerpt.freshness,
        ExcerptFreshness::IndexedCommit
    );

    // Open `src/tax.ts` in `host_core::DocumentService` and modify it in memory WITHOUT saving to disk
    let mut doc_service = DocumentService::new_in_memory();
    let opened_snap = doc_service
        .open_document_from_disk("src/tax.ts", 1, &tax_file_disk_path)
        .expect("open in DocumentService");
    assert_eq!(opened_snap.interactive_revision, 0);
    assert_eq!(opened_snap.disk_saved_revision, 0);

    // Replace "export const TAX_RATE = 0.20;" (29 UTF-16 code units) with "export const TAX_RATE = 0.055; // unsaved_marker"
    let updated_line = "export const TAX_RATE = 0.055; // unsaved_marker";
    let updated_snap = doc_service
        .apply_transaction(EditorTransaction {
            schema_version: CONTRACT_SCHEMA_VERSION,
            document_id: "src/tax.ts".to_string(),
            session_generation: 1,
            base_revision: 0,
            op_id: "op-unsaved-tax-1".to_string(),
            changes: vec![TextChange {
                range_utf16: Utf16Span::new(
                    Utf16CodeUnitOffset::new(0),
                    Utf16CodeUnitOffset::new(29),
                ),
                range_utf8: None,
                inserted_text: updated_line.to_string(),
            }],
            selection: EditorSelection::default(),
            origin: TransactionOrigin::User,
            ime_composing: false,
        })
        .expect("apply in-memory transaction");

    assert_eq!(updated_snap.interactive_revision, 1);
    assert_eq!(updated_snap.disk_saved_revision, 0);
    assert!(updated_snap.has_unsaved_changes);

    // Sync UnsavedBufferOverlay from DocumentService
    engine
        .overlay_mut()
        .sync_from_document_service(Some(workspace_root), &doc_service);

    // 1. Querying `TAX_RATE` must return exclusively `0.055` (never `0.20`), with the in-memory hash and `unsaved_buffer = true`
    let hits_tax = engine.query_hybrid("TAX_RATE", 10);
    assert!(!hits_tax.is_empty());
    let top_hit = &hits_tax[0];
    assert!(
        top_hit.excerpt.content.contains("0.055"),
        "Expected live unsaved value 0.055, got: {}",
        top_hit.excerpt.content
    );
    assert!(
        hits_tax.iter().all(|h| !h.excerpt.content.contains("0.20")),
        "Stale disk value 0.20 must never be returned when unsaved buffer is active"
    );
    assert!(top_hit.unsaved_buffer);
    assert_eq!(
        top_hit.excerpt.freshness,
        ExcerptFreshness::LiveUnsavedBuffer
    );
    assert_eq!(
        top_hit.excerpt.document_revision,
        updated_snap.interactive_revision
    );
    assert_eq!(
        top_hit.excerpt.content_blake3_hash,
        updated_snap.content_blake3_hash
    );

    // 2. Querying `unsaved_marker` (only present in memory) must also match immediately
    let hits_marker = engine.query_hybrid("unsaved_marker", 5);
    assert_eq!(hits_marker.len(), 1);
    assert!(hits_marker[0].unsaved_buffer);
    assert_eq!(
        hits_marker[0].excerpt.content_blake3_hash,
        updated_snap.content_blake3_hash
    );
}

#[test]
fn blocking_acl_and_secret_filtering_zero_occurrences_in_sqlite_file_and_exports() {
    let dir = tempdir().expect("create tempdir");
    let workspace_root = dir.path();
    let db_path = workspace_root.join(".coloride/context.sqlite");

    // 1. Create `.gitignore` and `.colorideignore`
    std::fs::write(
        workspace_root.join(".gitignore"),
        "ignored_dir/\n*.secret.log\n",
    )
    .expect("write .gitignore");
    std::fs::write(
        workspace_root.join(".colorideignore"),
        "private_vault/**\ninternal_only.ts\n",
    )
    .expect("write .colorideignore");

    // 2. Construct test secrets dynamically so literal scanners don't flag test source
    let aws_secret = ["AKIA", "IOSFODNN7EXAMPLE"].concat();
    let gh_secret = ["ghp_", "99887766554433221100aabbccddeeffGGHH"].concat();
    let openai_secret = ["sk-proj-", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"].concat();
    let db_url_secret = "postgres://dbadmin:SuperSecretPass99!@prod-db.internal:5432/coloride";
    let pem_begin = ["-----BEGIN ", "RSA PRIVATE KEY-----"].concat();
    let pem_body = "MIIEpAIBAAKCAQEA3Tz2mr7SZiAMfQyuvBjM9OiZ1234567890ABCDEF";
    let pem_end = ["-----END ", "RSA PRIVATE KEY-----"].concat();

    // 3. Create `.env` file and `.colorideignore`-blocked files
    std::fs::write(
        workspace_root.join(".env"),
        format!("AWS_ACCESS_KEY_ID={aws_secret}\nGITHUB_TOKEN={gh_secret}\n"),
    )
    .expect("write .env");

    std::fs::write(
        workspace_root.join("internal_only.ts"),
        "export const TOP_SECRET_INTERNAL_MARKER = 'DO_NOT_INDEX_INTERNAL_ONLY';\n",
    )
    .expect("write internal_only.ts");

    std::fs::create_dir_all(workspace_root.join("src")).expect("mkdir src");
    std::fs::write(
        workspace_root.join("src/config.ts"),
        format!(
            "export const APP_NAME = \"ColorideCockpit\";\n\
             export const AWS_KEY = \"{aws_secret}\";\n\
             export const GITHUB_PAT = \"{gh_secret}\";\n\
             export const AI_KEY = \"{openai_secret}\";\n\
             export const DATABASE_URL = \"{db_url_secret}\";\n\
             export const PEM = `\n\
             {pem_begin}\n\
             {pem_body}\n\
             {pem_end}\n\
             `;\n"
        ),
    )
    .expect("write src/config.ts");

    // 4. Run full indexing and persist `.sqlite` to disk
    let mut engine =
        SqliteWalContextEngine::open_or_rebuild_from_workspace(&db_path, workspace_root, "main")
            .expect("open and index workspace");

    // Excluded files must not be present in the `files` table
    assert!(!engine.files_table().contains_key(".env"));
    assert!(!engine.files_table().contains_key("internal_only.ts"));
    assert!(engine.files_table().contains_key("src/config.ts"));

    // Inspect raw `.sqlite` and `.sqlite-wal` bytes directly on disk
    let raw_sqlite_bytes = std::fs::read(&db_path).expect("read .sqlite file from disk");
    let raw_sqlite_lossy = String::from_utf8_lossy(&raw_sqlite_bytes);

    for forbidden in [
        aws_secret.as_str(),
        gh_secret.as_str(),
        openai_secret.as_str(),
        "SuperSecretPass99!",
        pem_body,
        "DO_NOT_INDEX_INTERNAL_ONLY",
    ] {
        assert!(
            !raw_sqlite_lossy.contains(forbidden),
            "Plaintext secret or excluded content '{forbidden}' must have 0 occurrences in .sqlite on disk"
        );
    }

    if engine.wal_path().exists() {
        let raw_wal_bytes = std::fs::read(engine.wal_path()).expect("read .sqlite-wal");
        let raw_wal_lossy = String::from_utf8_lossy(&raw_wal_bytes);
        for forbidden in [
            aws_secret.as_str(),
            gh_secret.as_str(),
            openai_secret.as_str(),
            "SuperSecretPass99!",
            pem_body,
            "DO_NOT_INDEX_INTERNAL_ONLY",
        ] {
            assert!(
                !raw_wal_lossy.contains(forbidden),
                "Plaintext secret '{forbidden}' must have 0 occurrences in .sqlite-wal on disk"
            );
        }
    }

    // Export a ContextBundle for `src/config.ts` and verify 0 secrets in the exported bundle
    let bundle = engine.export_context_bundle(
        "bundle-sec-001",
        "APP_NAME AWS_KEY GITHUB_PAT DATABASE_URL",
        8_000,
        AuthorizedDestination::LocalOnly,
    );
    assert_eq!(
        bundle.classification,
        DataClassification::RestrictedFiltered
    );
    let bundle_json = serde_json::to_string(&bundle).expect("serialize bundle");
    for forbidden in [
        aws_secret.as_str(),
        gh_secret.as_str(),
        openai_secret.as_str(),
        "SuperSecretPass99!",
        pem_body,
        "DO_NOT_INDEX_INTERNAL_ONLY",
    ] {
        assert!(
            !bundle_json.contains(forbidden),
            "Plaintext secret '{forbidden}' must have 0 occurrences in exported ContextBundle"
        );
    }

    // Audit log must record redaction events with BLAKE3 fingerprints and zero plaintext secrets
    assert!(!engine.audit_log().is_empty());
    let audit_json = serde_json::to_string(engine.audit_log()).expect("serialize audit log");
    assert!(!audit_json.contains(&aws_secret));
    assert!(!audit_json.contains(&gh_secret));
}

#[test]
fn blocking_100_hybrid_queries_complete_under_300ms_p95() {
    let dir = tempdir().expect("create tempdir");
    let workspace_root = dir.path();
    let db_path = workspace_root.join(".coloride/context.sqlite");

    let mut engine = SqliteWalContextEngine::open(&db_path, "main", AclAndSecretScanner::new())
        .expect("open engine");

    // Populate a reference TypeScript corpus of 60 interconnected modules & test files
    for idx in 0..60u32 {
        let module_path = format!("src/modules/service_{idx}.ts");
        let next_idx = (idx + 1) % 60;
        let source = format!(
            "import {{ computeBilling_{next_idx} }} from \"./service_{next_idx}\";\n\
             export interface InvoiceRecord_{idx} {{ readonly id: string; readonly totalCents: number; }}\n\
             export function computeBilling_{idx}(amount: number): number {{\n\
                 return computeBilling_{next_idx}(amount) + {};\n\
             }}\n\
             export const DEFAULT_CURRENCY_{idx} = \"EUR\";\n",
            idx * 10
        );
        engine
            .index_file(&module_path, 1, &source)
            .expect("index module");

        if idx % 3 == 0 {
            let test_path = format!("src/modules/service_{idx}.test.ts");
            let test_source = format!(
                "import {{ computeBilling_{idx} }} from \"./service_{idx}\";\n\
                 export function testBillingSuite_{idx}(): boolean {{ return computeBilling_{idx}(100) > 0; }}\n"
            );
            engine
                .index_file(&test_path, 1, &test_source)
                .expect("index test");
        }
    }

    let queries = [
        "computeBilling_0",
        "InvoiceRecord_15 totalCents",
        "DEFAULT_CURRENCY_42 EUR",
        "testBillingSuite_9",
        "computeBilling_33 amount",
    ];

    let mut latencies_us = Vec::with_capacity(100);
    for i in 0..100usize {
        let q = queries[i % queries.len()];
        let t0 = Instant::now();
        let hits = engine.query_hybrid(q, 10);
        latencies_us.push(t0.elapsed().as_micros());
        assert!(!hits.is_empty(), "Expected non-empty hits for query '{q}'");
    }

    let p95_us = percentile_95_micros(&latencies_us);
    // Blocking threshold: p95 <= 300 ms (300,000 microseconds)
    assert!(
        p95_us <= 300_000,
        "Expected 100 hybrid queries p95 <= 300,000 us (300 ms), got {p95_us} us"
    );
}

#[tokio::test]
async fn debounced_indexer_branch_switch_and_deterministic_rebuild() {
    let dir = tempdir().expect("create tempdir");
    let workspace_root = dir.path();
    let db_path = workspace_root.join(".coloride/context.sqlite");

    std::fs::create_dir_all(workspace_root.join("src")).expect("mkdir src");
    std::fs::write(
        workspace_root.join("src/feature.ts"),
        "export function launchRocket(): string { return 'liftoff'; }\n",
    )
    .expect("write src/feature.ts");

    let engine = Arc::new(Mutex::new(
        SqliteWalContextEngine::open_or_rebuild_from_workspace(&db_path, workspace_root, "main")
            .expect("open engine"),
    ));

    {
        let mut guard = engine.lock().await;
        let hits = guard.query_hybrid("launchRocket", 5);
        assert_eq!(hits.len(), 1);
    }

    // Spawn background debounced worker (50 ms window for fast test verification, while verifying default constant is 300 ms)
    assert_eq!(DEFAULT_INDEX_DEBOUNCE_MS, 300);
    let tx = DebouncedIndexer::spawn_background_worker(Arc::clone(&engine), 40);

    // Send rapid modifications to `src/orbital.ts`; only the latest revision should be indexed after quiet period
    tx.send(IndexerEvent::FileModified {
        relative_path: "src/orbital.ts".to_string(),
        document_revision: 1,
        content: "export const ORBIT_STAGE = 'stage_one';\n".to_string(),
    })
    .expect("send rev 1");
    tx.send(IndexerEvent::FileModified {
        relative_path: "src/orbital.ts".to_string(),
        document_revision: 2,
        content: "export const ORBIT_STAGE = 'stage_two_final';\n".to_string(),
    })
    .expect("send rev 2");

    tokio::time::sleep(Duration::from_millis(90)).await;

    {
        let mut guard = engine.lock().await;
        let hits = guard.query_hybrid("stage_two_final", 5);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].excerpt.document_revision, 2);
    }

    // Switch Git branch -> invalidates previous branch index
    tx.send(IndexerEvent::BranchSwitched {
        new_branch: "feat/lot-008".to_string(),
    })
    .expect("send branch switch");
    tokio::time::sleep(Duration::from_millis(30)).await;

    {
        let guard = engine.lock().await;
        assert_eq!(guard.active_git_branch(), "feat/lot-008");
        assert!(guard.files_table().is_empty());
    }
}

#[test]
fn sqlite_wal_replay_file_removal_and_corrupted_store_rebuild() {
    let dir = tempdir().expect("create tempdir");
    let workspace_root = dir.path();
    let db_path = workspace_root.join(".coloride/context.sqlite");

    std::fs::create_dir_all(workspace_root.join("src")).expect("mkdir src");
    std::fs::write(
        workspace_root.join("src/a.ts"),
        "export function alpha CoreFn(): number { return 42; }\n",
    )
    .expect("write src/a.ts");

    {
        let mut engine = SqliteWalContextEngine::open_or_rebuild_from_workspace(
            &db_path,
            workspace_root,
            "main",
        )
        .expect("initial open");

        // Index `src/b.ts` and `src/c.ts` incrementally (appended to `.sqlite-wal` without full snapshot checkpoint)
        engine
            .index_file(
                "src/b.ts",
                3,
                "import { alpha } from \"./a\";\nexport function betaCaller(): number { return alpha(); }\n",
            )
            .expect("index b.ts");
        engine
            .index_file(
                "src/c.ts",
                1,
                "export const TEMPORARY_SYMBOL = 'to_be_deleted';\n",
            )
            .expect("index c.ts");

        // Remove `src/c.ts` (appends FileRemoved frame to `.sqlite-wal`)
        assert!(engine.remove_file("src/c.ts").expect("remove c.ts"));
        let wal_meta = std::fs::metadata(engine.wal_path()).expect("wal metadata");
        assert!(
            wal_meta.len() > 0,
            "Expected non-empty .sqlite-wal before checkpoint"
        );
    }

    // Reopen engine without checkpointing: must replay `.sqlite-wal` frames accurately
    {
        let mut reopened = SqliteWalContextEngine::open(
            &db_path,
            "main",
            AclAndSecretScanner::from_workspace_root(workspace_root),
        )
        .expect("reopen from snapshot + wal");

        assert!(reopened.files_table().contains_key("src/a.ts"));
        assert!(reopened.files_table().contains_key("src/b.ts"));
        assert!(!reopened.files_table().contains_key("src/c.ts"));

        let hits_beta = reopened.query_hybrid("betaCaller", 5);
        assert!(!hits_beta.is_empty());
        assert_eq!(hits_beta[0].excerpt.document_revision, 3);

        let hits_deleted = reopened.query_hybrid("TEMPORARY_SYMBOL", 5);
        assert!(hits_deleted.is_empty());

        // Checkpoint compacts `.sqlite-wal` into `.sqlite` and truncates `.sqlite-wal`
        reopened.checkpoint_wal().expect("checkpoint wal");
        let wal_meta_after = std::fs::metadata(reopened.wal_path()).expect("wal metadata after");
        assert_eq!(wal_meta_after.len(), 0);
    }

    // Corrupt `.sqlite` on disk and verify `open_or_rebuild_from_workspace` deterministically rebuilds
    std::fs::write(&db_path, b"corrupted-sqlite-bytes").expect("corrupt .sqlite");
    let mut recovered =
        SqliteWalContextEngine::open_or_rebuild_from_workspace(&db_path, workspace_root, "main")
            .expect("recover from corrupted .sqlite");
    assert!(recovered.files_table().contains_key("src/a.ts"));
    assert!(!recovered.query_hybrid("alpha", 5).is_empty());
}
