#![cfg(feature = "vector")]
use context_engine::*;

#[test]
fn real_sqlite_vec_cosine_extension() {
    toolu_orm_sqlite_vec_register::register().unwrap();
    let db = rusqlite::Connection::open_in_memory().unwrap();
    let distance: f64 = db
        .query_row(
            "SELECT vec_distance_cosine('[1.0,0.0]', '[0.0,1.0]')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!((distance - 1.0).abs() < 0.0001);
}

#[test]
#[ignore = "downloads a compact model and requires ONNX Runtime; run explicitly with --ignored"]
fn background_vectors_reach_mcp_and_rebuild_after_edits() {
    use serde_json::{json, Value};
    let dir = tempfile::tempdir().unwrap();
    let mut engine =
        SqliteWalContextEngine::open(dir.path().join("index"), "main", AclAndSecretScanner::new())
            .unwrap();
    engine
        .index_file(
            "src/billing.ts",
            1,
            "export function calculateInvoiceTotal(price: number) { return price * 2; }",
        )
        .unwrap();
    let mut server = LocalMcpServer::new(engine, ContextBundleAssembler::default());
    server.handle_line(&json!({"jsonrpc":"2.0","id":1,"method":"initialize"}).to_string());
    let cache = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/lot009-model");
    let isolated_cache = tempfile::tempdir_in(cache).unwrap();
    // Reuse model downloads, while isolating persistent SQLite state from other tests.
    // The provider cache is shared through symlinks only in this fixture.
    for entry in std::fs::read_dir(isolated_cache.path().parent().unwrap())
        .unwrap()
        .flatten()
    {
        if entry.file_name().to_string_lossy().starts_with("models--") {
            #[cfg(unix)]
            std::os::unix::fs::symlink(entry.path(), isolated_cache.path().join(entry.file_name()))
                .unwrap();
        }
    }
    server.enable_vectors(isolated_cache.path().to_path_buf());
    let request = json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"build_context_bundle","arguments":{"query":"billing amount"}}}).to_string();
    let wait_for_hybrid = |server: &mut LocalMcpServer| {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            let response = server.handle_line(&request).unwrap();
            let data: Value =
                serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                    .unwrap();
            if data["retrieval_mode"] == "HybridVector" && data["vector_state"] == "Ready" {
                return data;
            }
            assert!(std::time::Instant::now() < deadline, "{data}");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    };
    let ready = wait_for_hybrid(&mut server);
    assert!(ready["bundle"]["excerpts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["source_path"] == "src/billing.ts"));
    server
        .engine
        .index_file(
            "src/billing.ts",
            2,
            "export function calculateInvoiceTotal(price: number) { return price * 3; }",
        )
        .unwrap();
    let response = server.handle_line(&request).unwrap();
    let data: Value =
        serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(data["retrieval_mode"], "HybridVector");
    let updated = wait_for_hybrid(&mut server);
    assert!(updated["bundle"]["excerpts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["content"].as_str().unwrap().contains("price * 3")));
}

#[test]
fn missing_runtime_reports_actionable_failure_over_mcp() {
    use serde_json::{json, Value};
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("model-cache");
    std::fs::create_dir(&cache).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_coloride-context-mcp"))
        .env_remove("ORT_DYLIB_PATH")
        .arg(dir.path())
        .arg(dir.path().join("context.sqlite"))
        .arg("main")
        .arg("--vectors")
        .arg(&cache)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    writeln!(
        input,
        "{}",
        json!({"jsonrpc":"2.0","id":1,"method":"initialize"})
    )
    .unwrap();
    input.flush().unwrap();
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        writeln!(input,"{}",json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"build_context_bundle","arguments":{"query":"none"}}})).unwrap();
        input.flush().unwrap();
        line.clear();
        output.read_line(&mut line).unwrap();
        let response: Value = serde_json::from_str(&line).unwrap();
        let data: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        if data["vector_state"].get("Failed").is_some() {
            assert!(data["degradation_reason"]
                .as_str()
                .unwrap()
                .contains("ORT_DYLIB_PATH"));
            assert_eq!(data["retrieval_mode"], "LexicalAndAstOnly");
            break;
        }
        assert!(std::time::Instant::now() < deadline, "{data}");
    }
    drop(input);
    assert!(child.wait().unwrap().success());
}
