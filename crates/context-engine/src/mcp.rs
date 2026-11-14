//! Read-only local MCP JSON-RPC server. No request may start processes or change policy.
use std::io::{BufRead, Write};

use host_core::AuthorizedDestination;
use serde_json::{json, Value};

use crate::{ContextBundleAssembler, SqliteWalContextEngine};

const MAX_MESSAGE_BYTES: usize = 1_048_576;
const TOOLS: [&str; 5] = [
    "search_codebase",
    "get_symbol_definition",
    "get_impact_graph",
    "get_diagnostics",
    "build_context_bundle",
];

pub struct LocalMcpServer {
    pub engine: SqliteWalContextEngine,
    assembler: ContextBundleAssembler,
    initialized: bool,
    #[cfg(feature = "vector")]
    vectors: Option<crate::vectors::VectorIndex>,
    #[cfg(feature = "vector")]
    vector_worker: Option<std::thread::JoinHandle<Result<crate::vectors::VectorIndex, String>>>,
    #[cfg(feature = "vector")]
    vector_cursor: Option<crate::vectors::VectorCursor>,
    #[cfg(feature = "vector")]
    vector_config: Option<(std::path::PathBuf, crate::vectors::CompactEmbeddingModel)>,
    vector_state: crate::VectorState,
    diagnostics: std::collections::BTreeMap<String, (String, Vec<host_core::DiagnosticEntry>)>,
}

impl LocalMcpServer {
    pub fn new(engine: SqliteWalContextEngine, assembler: ContextBundleAssembler) -> Self {
        Self {
            engine,
            assembler,
            initialized: false,
            #[cfg(feature = "vector")]
            vectors: None,
            #[cfg(feature = "vector")]
            vector_worker: None,
            #[cfg(feature = "vector")]
            vector_config: None,
            #[cfg(feature = "vector")]
            vector_cursor: None,
            vector_state: crate::VectorState::Disabled,
            diagnostics: Default::default(),
        }
    }

    /// A trusted host diagnostics provider publishes results bound to the source hash.
    /// MCP clients cannot publish diagnostics or start a language server.
    pub fn publish_diagnostics(
        &mut self,
        path: String,
        hash: String,
        entries: Vec<host_core::DiagnosticEntry>,
    ) -> Result<(), String> {
        self.engine
            .scanner()
            .check_path_acl(&path)
            .map_err(|_| "Path denied")?;
        if entries.iter().any(|entry| entry.file_path != path) {
            return Err("Diagnostic path mismatch".into());
        }
        let mut entries = entries;
        for entry in &mut entries {
            entry.message = self
                .engine
                .scanner_mut()
                .sanitize_text(&path, &entry.message)
                .sanitized_text;
            entry.code = self
                .engine
                .scanner_mut()
                .sanitize_text(&path, &entry.code)
                .sanitized_text;
        }
        self.diagnostics.insert(path, (hash, entries));
        Ok(())
    }

    /// Publishes the Host's revision-tagged batches for one document (`LOT-010`), typically
    /// `LatestDiagnostics::current`: every tool's diagnostics for one content hash, together.
    /// Batches for different contents, or different documents, are refused.
    pub fn publish_document_diagnostics(
        &mut self,
        batches: &[host_core::DocumentDiagnostics],
    ) -> Result<(), String> {
        let first = batches.first().ok_or("No diagnostics to publish")?;
        if batches.iter().any(|batch| {
            batch.document_id != first.document_id
                || batch.content_blake3_hash != first.content_blake3_hash
        }) {
            return Err("Diagnostics batches describe different contents".into());
        }
        let entries = batches
            .iter()
            .flat_map(|batch| batch.items.iter().cloned())
            .collect();
        self.publish_diagnostics(
            first.document_id.clone(),
            first.content_blake3_hash.clone(),
            entries,
        )
    }

    /// Host-only opt-in. Downloads and index construction never block the MCP hot path.
    #[cfg(feature = "vector")]
    pub fn enable_vectors(&mut self, cache: std::path::PathBuf) {
        self.enable_vectors_with_model(cache, crate::vectors::CompactEmbeddingModel::default());
    }

    #[cfg(feature = "vector")]
    pub fn enable_vectors_with_model(
        &mut self,
        cache: std::path::PathBuf,
        model: crate::vectors::CompactEmbeddingModel,
    ) {
        // A model change starts a separate scope; no stale reader can use the old model.
        if let Some(worker) = self.vector_worker.take() {
            let _ = worker.join();
        }
        self.vector_config = Some((cache, model));
        self.vectors = None;
        self.vector_cursor = None;
        self.start_vector_update();
    }

    #[cfg(feature = "vector")]
    fn start_vector_update(&mut self) {
        if self.vector_worker.is_some() {
            return;
        }
        let Some((cache, model)) = self.vector_config.clone() else {
            return;
        };
        let Some(update) = crate::vectors::changes(&mut self.engine, self.vector_cursor) else {
            return;
        };
        self.vector_cursor = Some(update.cursor);
        let existing = self
            .vectors
            .as_ref()
            .map(|index| index.fork(&update.branch));
        self.vector_state = crate::VectorState::Building;
        self.vector_worker = Some(std::thread::spawn(move || {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut index = match existing {
                    Some(index) => index?,
                    None => crate::vectors::VectorIndex::load(&cache, model, &update.branch)?,
                };
                index.sync(&update)?;
                Ok(index)
            })).unwrap_or_else(|panic| {
                let detail = panic.downcast_ref::<String>().map(String::as_str)
                    .or_else(|| panic.downcast_ref::<&str>().copied()).unwrap_or("unknown loader panic");
                Err(format!("Embedding initialization failed: {detail}. Check ORT_DYLIB_PATH and install ONNX Runtime 1.20+ for this architecture"))
            })
        }));
    }

    #[cfg(feature = "vector")]
    fn query_vectors(&mut self, query: &str) -> crate::bundle::VectorRetrieval {
        if self
            .vector_worker
            .as_ref()
            .is_some_and(|worker| worker.is_finished())
        {
            if let Some(worker) = self.vector_worker.take() {
                match worker.join() {
                    Ok(Ok(index)) => {
                        self.vectors = Some(index);
                        self.vector_state = crate::VectorState::Ready;
                    }
                    Ok(Err(reason)) => self.vector_state = crate::VectorState::Failed { reason },
                    Err(_) => {
                        self.vector_state = crate::VectorState::Failed {
                            reason: "Embedding worker panicked; check ONNX Runtime configuration"
                                .into(),
                        }
                    }
                }
            }
        }
        if !matches!(self.vector_state, crate::VectorState::Failed { .. }) {
            if self
                .vectors
                .as_ref()
                .is_some_and(|index| !index.matches(&self.engine))
            {
                self.vector_state = crate::VectorState::Stale;
            }
            self.start_vector_update();
            if let Some(index) = self
                .vectors
                .as_ref()
                .filter(|index| index.matches(&self.engine))
            {
                match index.search(&mut self.engine, query) {
                    Ok(hits) => {
                        return crate::bundle::VectorRetrieval::Available {
                            hits,
                            updating: self.vector_worker.is_some(),
                        }
                    }
                    Err(reason) => self.vector_state = crate::VectorState::Failed { reason },
                }
            }
        }
        crate::bundle::VectorRetrieval::Unavailable(self.vector_state.clone())
    }

    pub fn handle_line(&mut self, line: &str) -> Option<Value> {
        if line.len() > MAX_MESSAGE_BYTES {
            return Some(error(Value::Null, -32600, "Message too large"));
        }
        let request: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => return Some(error(Value::Null, -32700, "Parse error")),
        };
        let id = request.get("id").cloned();
        let method = request.get("method").and_then(Value::as_str);
        if !request.is_object()
            || request.get("jsonrpc") != Some(&json!("2.0"))
            || method.is_none()
            || id
                .as_ref()
                .is_some_and(|id| !(id.is_string() || id.is_number() || id.is_null()))
        {
            return Some(error(Value::Null, -32600, "Invalid request"));
        }
        let method = method.unwrap_or_default();
        let id = id?; // Notifications never receive a response.
        let params = request.get("params").cloned().unwrap_or(json!({}));
        if !params.is_object() {
            return Some(error(id, -32602, "Invalid params"));
        }
        let result = match method {
            "initialize" => {
                let version = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("2024-11-05");
                if !["2024-11-05", "2025-03-26", "2025-06-18"].contains(&version) {
                    return Some(error(id, -32602, "Unsupported protocol version"));
                }
                self.initialized = true;
                json!({"protocolVersion":version,"capabilities":{"tools":{}},"serverInfo":{"name":"coloride-context","version":env!("CARGO_PKG_VERSION")}})
            }
            "ping" => json!({}),
            _ if !self.initialized => return Some(error(id, -32002, "Initialize first")),
            "tools/list" => json!({"tools": TOOLS.iter().map(|name| json!({
                "name":name, "description":format!("Read workspace context: {name}"),
                "inputSchema": schema(name),
                "annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":false}
            })).collect::<Vec<_>>()}),
            "tools/call" => {
                let Some(name) = params.get("name").and_then(Value::as_str) else {
                    return Some(error(id, -32602, "Missing tool name"));
                };
                if !TOOLS.contains(&name) {
                    return Some(error(id, -32602, "Unknown tool"));
                }
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                if !args.is_object() {
                    return Some(error(id, -32602, "Invalid arguments"));
                }
                match self.call_tool(name, &args) {
                    Ok(data) => {
                        json!({"content":[{"type":"text","text":data.to_string()}],"isError":false})
                    }
                    Err(message) => {
                        json!({"content":[{"type":"text","text":message}],"isError":true})
                    }
                }
            }
            _ => return Some(error(id, -32601, "Method not found")),
        };
        Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
    }

    fn call_tool(&mut self, name: &str, args: &Value) -> Result<Value, String> {
        let required = |key: &str| {
            args.get(key)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("Missing or invalid {key}"))
        };
        match name {
            "search_codebase" => {
                let query = required("query")?;
                let limit = match args.get("limit") {
                    None => 20,
                    Some(value) => value
                        .as_u64()
                        .filter(|n| (1..=256).contains(n))
                        .ok_or("limit must be between 1 and 256")?
                        as usize,
                };
                Ok(json!(self.engine.query_hybrid(query, limit)))
            }
            "get_symbol_definition" => {
                let symbol = required("symbol")?;
                let hits = self.engine.get_symbol_definition(symbol);
                Ok(json!(hits))
            }
            "get_impact_graph" => {
                let path = required("file_path")?;
                self.engine
                    .scanner()
                    .check_path_acl(path)
                    .map_err(|_| "Path denied")?;
                let edges = self
                    .engine
                    .symbol_edges_table()
                    .iter()
                    .filter(|e| {
                        (e.importer_file == path || e.target_file == path)
                            && self
                                .engine
                                .scanner()
                                .check_path_acl(&e.importer_file)
                                .is_ok()
                            && self.engine.scanner().check_path_acl(&e.target_file).is_ok()
                    })
                    .collect::<Vec<_>>();
                Ok(json!({"edges":edges,"source":"indexed_ast","live_overlay_included":false}))
            }
            "get_diagnostics" => {
                let path = required("file_path")?;
                self.engine
                    .scanner()
                    .check_path_acl(path)
                    .map_err(|_| "Path denied")?;
                let current = self
                    .engine
                    .overlay()
                    .entries()
                    .get(path)
                    .map(|e| &e.content_blake3_hash)
                    .or_else(|| {
                        self.engine
                            .files_table()
                            .get(path)
                            .map(|e| &e.content_blake3_hash)
                    });
                match self.diagnostics.get(path) {
                    Some((hash, entries)) if current == Some(hash) => Ok(
                        json!({"file_path":path,"status":"Available","content_blake3_hash":hash,"items":entries}),
                    ),
                    Some(_) => Ok(json!({"file_path":path,"status":"Stale","items":[]})),
                    None => Ok(
                        json!({"file_path":path,"status":"Unavailable","reason":"LSP/Biome diagnostics provider not connected","items":[]}),
                    ),
                }
            }
            "build_context_bundle" => {
                let query = required("query")?;
                let budget = args
                    .get("token_budget")
                    .map(|v| {
                        v.as_u64()
                            .and_then(|n| u32::try_from(n).ok())
                            .ok_or("Invalid token_budget")
                    })
                    .transpose()?;
                let destination = args
                    .get("authorized_destination")
                    .map(|v| {
                        serde_json::from_value::<AuthorizedDestination>(v.clone())
                            .map_err(|_| "Invalid destination")
                    })
                    .transpose()?
                    .unwrap_or(AuthorizedDestination::LocalOnly);
                #[cfg(feature = "vector")]
                let retrieval = self.query_vectors(query);
                #[cfg(not(feature = "vector"))]
                let retrieval =
                    crate::bundle::VectorRetrieval::Unavailable(self.vector_state.clone());
                let bundle = self.assembler.assemble_hits(
                    &mut self.engine,
                    query,
                    budget,
                    destination,
                    retrieval,
                )?;
                Ok(json!(bundle))
            }
            _ => Err("Unknown tool".into()),
        }
    }

    /// Newline-delimited UTF-8 stdio transport, bounded before JSON allocation.
    pub fn serve(
        &mut self,
        mut input: impl BufRead,
        mut output: impl Write,
    ) -> std::io::Result<()> {
        loop {
            let mut bytes = Vec::new();
            let read = std::io::Read::take(&mut input, (MAX_MESSAGE_BYTES + 2) as u64)
                .read_until(b'\n', &mut bytes)?;
            if read == 0 {
                return Ok(());
            }
            if bytes.len() > MAX_MESSAGE_BYTES + 1 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "MCP message exceeds limit",
                ));
            }
            let response = match std::str::from_utf8(&bytes) {
                Ok(line) => self.handle_line(line.trim_end_matches(['\r', '\n'])),
                Err(_) => Some(error(Value::Null, -32700, "Invalid UTF-8")),
            };
            if let Some(response) = response {
                serde_json::to_writer(&mut output, &response)?;
                output.write_all(b"\n")?;
                output.flush()?;
            }
        }
    }
}

fn schema(name: &str) -> Value {
    match name {
        "search_codebase" => {
            json!({"type":"object","required":["query"],"properties":{"query":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":256}}})
        }
        "get_symbol_definition" => {
            json!({"type":"object","required":["symbol"],"properties":{"symbol":{"type":"string"}}})
        }
        "build_context_bundle" => {
            json!({"type":"object","required":["query"],"properties":{"query":{"type":"string"},"token_budget":{"type":"integer","minimum":0},"authorized_destination":{"description":"host-core AuthorizedDestination; workspace policy is enforced"}}})
        }
        _ => {
            json!({"type":"object","required":["file_path"],"properties":{"file_path":{"type":"string"}}})
        }
    }
}

fn error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
