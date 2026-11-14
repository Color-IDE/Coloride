use context_engine::*;
use host_core::AuthorizedDestination;
use serde_json::{json, Value};
use std::time::Instant;

fn fixture() -> (tempfile::TempDir, LocalMcpServer) {
    let dir = tempfile::tempdir().unwrap();
    let mut engine = SqliteWalContextEngine::open(
        dir.path().join("context.sqlite"),
        "main",
        AclAndSecretScanner::new(),
    )
    .unwrap();
    for i in 0..100 {
        engine
            .index_file(
                &format!("src/money{i}.ts"),
                1,
                &format!("export function money{i}(value: number) {{ return value + {i}; }}"),
            )
            .unwrap();
    }
    engine
        .index_file("src/broken.ts", 1, "export function moneyBroken( {")
        .unwrap();
    (
        dir,
        LocalMcpServer::new(engine, ContextBundleAssembler::default()),
    )
}

fn initialize(server: &mut LocalMcpServer) {
    assert!(server.handle_line(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}).to_string()).unwrap().get("result").is_some());
}
fn call(server: &mut LocalMcpServer, name: &str, arguments: Value) -> Value {
    let result = server.handle_line(&json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":name,"arguments":arguments}}).to_string()).unwrap();
    assert_eq!(result["result"]["isError"], false, "{result}");
    serde_json::from_str(result["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
}

#[test]
fn blocking_mcp_200_calls_p95_under_20ms() {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    let (dir, server) = fixture();
    let mut process = Command::new(env!("CARGO_BIN_EXE_coloride-context-mcp"))
        .arg(dir.path())
        .arg(server.engine.db_path())
        .arg("main")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = process.stdin.take().unwrap();
    let mut output = BufReader::new(process.stdout.take().unwrap());
    let mut request = |message: Value| {
        writeln!(input, "{message}").unwrap();
        input.flush().unwrap();
        let mut line = String::new();
        assert!(output.read_line(&mut line).unwrap() > 0);
        serde_json::from_str::<Value>(&line).unwrap()
    };
    request(json!({"jsonrpc":"2.0","id":1,"method":"initialize"}));
    request(
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_codebase","arguments":{"query":"money"}}}),
    );
    let mut times = Vec::new();
    for i in 0..200 {
        let (name, args) = if i % 2 == 0 {
            ("search_codebase", json!({"query":"money","limit":20}))
        } else {
            ("get_impact_graph", json!({"file_path":"src/money0.ts"}))
        };
        let start = Instant::now();
        let response = request(
            json!({"jsonrpc":"2.0","id":i+3,"method":"tools/call","params":{"name":name,"arguments":args}}),
        );
        times.push(start.elapsed());
        assert_eq!(response["result"]["isError"], false, "{response}");
    }
    drop(input);
    assert!(process.wait().unwrap().success());
    times.sort();
    let p95 = times[189];
    eprintln!("LOT-009 warm 100-file index, 200 stdio round trips: p95={p95:?}");
    assert!(p95.as_millis() < 20, "p95={p95:?}");
}

#[test]
fn blocking_degraded_budget_determinism_and_incomplete_source() {
    let (_dir, mut server) = fixture();
    initialize(&mut server);
    let args = json!({"query":"money", "token_budget":8000});
    let first = call(&mut server, "build_context_bundle", args.clone());
    let second = call(&mut server, "build_context_bundle", args);
    assert_eq!(first, second);
    assert_eq!(first["retrieval_mode"], "LexicalAndAstOnly");
    assert!(first["bundle"]["token_budget_used"].as_u64().unwrap() <= 8000);
    let decoded: AssembledContextBundle = serde_json::from_value(first.clone()).unwrap();
    assert!(decoded.render_prompt().len() <= 8000);
    assert!(first.get("prompt").is_none());
    assert_eq!(first["token_accounting"], "ConservativeUtf8BytesUpperBound");
    assert_eq!(
        first["bundle"]["cache_control_prefix"]
            .as_str()
            .unwrap()
            .len(),
        64
    );
    let broken = call(
        &mut server,
        "build_context_bundle",
        json!({"query":"moneyBroken","token_budget":8000}),
    );
    assert!(broken["bundle"]["excerpts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["confidence"] == "HeuristicText"));
    for budget in [0, 1, 64] {
        let bundle = call(
            &mut server,
            "build_context_bundle",
            json!({"query":"money", "token_budget":budget}),
        );
        assert!(bundle["bundle"]["token_budget_used"].as_u64().unwrap() <= budget);
    }
}

#[test]
fn rpc_lifecycle_transport_policy_and_secrets() {
    let (_dir, mut server) = fixture();
    assert_eq!(server.handle_line("{").unwrap()["error"]["code"], -32700);
    assert_eq!(server.handle_line("[]").unwrap()["error"]["code"], -32600);
    assert_eq!(
        server
            .handle_line(r#"{"jsonrpc":"2.0","id":3,"method":"tools/list"}"#)
            .unwrap()["error"]["code"],
        -32002
    );
    initialize(&mut server);
    assert!(server
        .handle_line(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
        .is_none());
    let secret = ["ghp_", "1234567890abcdefghijklmnopqrstuvwxyzABCD"].concat();
    server
        .engine
        .index_file(
            "src/secret.ts",
            1,
            &format!("export const moneySecret = \"{secret}\";"),
        )
        .unwrap();
    let bundle = call(
        &mut server,
        "build_context_bundle",
        json!({"query":"moneySecret"}),
    );
    assert!(!bundle.to_string().contains(&secret));
    let decoded: AssembledContextBundle = serde_json::from_value(bundle).unwrap();
    assert!(decoded.render_prompt().contains("untrusted_source_excerpt"));
    assert!(ContextBundleAssembler::default()
        .assemble(
            &mut server.engine,
            "money",
            None,
            AuthorizedDestination::ManagedCloudEu
        )
        .is_err());
    let diagnostics = call(
        &mut server,
        "get_diagnostics",
        json!({"file_path":"src/money0.ts"}),
    );
    assert_eq!(diagnostics["status"], "Unavailable");
    let input = b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"ping\"}\n";
    let mut out = Vec::new();
    server.serve(&input[..], &mut out).unwrap();
    let response: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(response["id"], 9);
}

#[test]
fn diagnostics_are_revision_bound_and_unsaved_content_wins() {
    let (_dir, mut server) = fixture();
    initialize(&mut server);
    let path = "src/money0.ts";
    let hash = server.engine.files_table()[path]
        .content_blake3_hash
        .clone();
    server
        .publish_diagnostics(path.into(), hash, Vec::new())
        .unwrap();
    assert_eq!(
        call(&mut server, "get_diagnostics", json!({"file_path":path}))["status"],
        "Available"
    );
    server.engine.overlay_mut().upsert_buffer(
        path,
        ropey::Rope::from_str("export const liveOnlyMoney = 42;"),
        2,
        1,
        None,
    );
    let bundle = call(
        &mut server,
        "build_context_bundle",
        json!({"query":"liveOnlyMoney"}),
    );
    let excerpts = bundle["bundle"]["excerpts"].as_array().unwrap();
    assert!(!excerpts.is_empty());
    let live = excerpts
        .iter()
        .filter(|e| e["source_path"] == path)
        .collect::<Vec<_>>();
    assert!(!live.is_empty());
    assert!(live.iter().all(|e| e["freshness"] == "LiveUnsavedBuffer"));
    assert!(live
        .iter()
        .all(|e| e["content"].as_str().unwrap().contains("liveOnlyMoney")));
    assert_eq!(
        call(&mut server, "get_diagnostics", json!({"file_path":path}))["status"],
        "Stale"
    );
}

#[test]
fn stdio_binary_runs_the_mcp_handshake() {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("file.ts"), "export const hello = 1;").unwrap();
    let mut process = Command::new(env!("CARGO_BIN_EXE_coloride-context-mcp"))
        .arg(dir.path())
        .arg(dir.path().join("context.sqlite"))
        .arg("main")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = process.stdin.take().unwrap();
    writeln!(
        input,
        "{}",
        json!({"jsonrpc":"2.0","id":1,"method":"initialize"})
    )
    .unwrap();
    writeln!(
        input,
        "{}",
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})
    )
    .unwrap();
    drop(input);
    let output = process.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let lines: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[1]["result"]["tools"].as_array().unwrap().len(), 5);
}

#[test]
fn lot008_export_does_not_admit_an_oversized_first_excerpt() {
    let (_dir, mut server) = fixture();
    let count = server.engine.query_hybrid("money", 1).len();
    assert_eq!(count, 1);
    for budget in [0, 1] {
        let bundle = server.engine.export_context_bundle(
            "regression",
            "money",
            budget,
            AuthorizedDestination::LocalOnly,
        );
        assert!(bundle.excerpts.is_empty());
        assert_eq!(bundle.token_budget_used, 0);
    }
}

#[test]
fn exact_symbol_lookup_is_not_truncated_by_lexical_candidate_limit() {
    let dir = tempfile::tempdir().unwrap();
    let mut engine =
        SqliteWalContextEngine::open(dir.path().join("index"), "main", AclAndSecretScanner::new())
            .unwrap();
    // All definitions have the same name: lexical search was capped at 256.
    for i in 0..270 {
        engine
            .index_file(
                &format!("src/duplicate{i}.ts"),
                1,
                "export function commonSymbol() { return 1; }",
            )
            .unwrap();
    }
    assert_eq!(engine.get_symbol_definition("commonSymbol").len(), 270);
    engine.overlay_mut().upsert_buffer(
        "src/duplicate0.ts",
        ropey::Rope::from_str("export const renamedSymbol = 2;"),
        2,
        1,
        None,
    );
    assert_eq!(engine.get_symbol_definition("commonSymbol").len(), 269);
    assert_eq!(engine.get_symbol_definition("renamedSymbol").len(), 1);
    engine
        .scanner_mut()
        .add_colorideignore_rules("src/duplicate1.ts");
    assert_eq!(engine.get_symbol_definition("commonSymbol").len(), 268);
}

/// LOT-010: the Host's revision-tagged batches reach `get_diagnostics`, bound to their content.
#[test]
fn host_diagnostics_batches_are_published_for_their_content_hash() {
    let (_dir, mut server) = fixture();
    initialize(&mut server);
    let path = "src/money0.ts";
    let hash = server.engine.files_table()[path]
        .content_blake3_hash
        .clone();
    let entry = |source| host_core::DiagnosticEntry {
        file_path: path.into(),
        span_utf16: host_core::Utf16Span::new(
            host_core::Utf16CodeUnitOffset::new(0),
            host_core::Utf16CodeUnitOffset::new(6),
        ),
        line_col: host_core::LineCol::new(0, 0),
        source,
        severity: host_core::DiagnosticSeverity::Error,
        code: "2304".into(),
        message: "Cannot find name 'x'.".into(),
    };
    let batch = |source, hash: &str| host_core::DocumentDiagnostics {
        schema_version: host_core::CONTRACT_SCHEMA_VERSION,
        document_id: path.into(),
        session_generation: 1,
        base_revision: 3,
        content_blake3_hash: hash.into(),
        source,
        items: vec![entry(source)],
    };
    let both = [
        batch(host_core::DiagnosticSource::Vtsls, &hash),
        batch(host_core::DiagnosticSource::Biome, &hash),
    ];
    server.publish_document_diagnostics(&both).unwrap();
    let answer = call(&mut server, "get_diagnostics", json!({"file_path": path}));
    assert_eq!(answer["status"], "Available");
    assert_eq!(answer["items"].as_array().unwrap().len(), 2);

    // Mixed contents are refused; diagnostics for other content are reported as stale.
    assert!(server
        .publish_document_diagnostics(&[
            both[0].clone(),
            batch(host_core::DiagnosticSource::Biome, "other")
        ])
        .is_err());
    server
        .publish_document_diagnostics(&[batch(host_core::DiagnosticSource::Vtsls, "other")])
        .unwrap();
    let answer = call(&mut server, "get_diagnostics", json!({"file_path": path}));
    assert_eq!(answer["status"], "Stale");
}
