use std::path::{Path, PathBuf};
use std::sync::Mutex;

use context_engine::{
    AclAndSecretScanner, ContextEngineStatus, ContextSearchHit, ExtractedSymbol,
    GraphEdgeConfidence, ImpactAnalyzer, IncrementalAstParser, RopeTextProvider,
    SqliteWalContextEngine, SupportedAstLanguage, SymbolKind, TestFileTarget,
};
use host_core::{
    decode_editor_transaction_ipc, discover_workspace_conventions, encode_editor_snapshot_ipc,
    parse_mcp_config_jsonc, resolve_external_ide_paths, run_one_click_migration,
    BackgroundServicesStatus, DegradedConfigFile, DocumentError, DocumentService, EditorSnapshot,
    ExcerptFreshness, HostHealthStatus, LazyBootError, LazyBootOrchestrator, LazyBootReadySnapshot,
    OneClickMigrationInput, OneClickMigrationReport, OsPlatform,
};
use judge_orchestrator::JudgeHealthStatus;
use sandbox_runner::SandboxCapabilities;
use serde::{Deserialize, Serialize};
use tauri::Manager;

struct DesktopAppState {
    bridge: Mutex<DesktopBinaryEditorBridge>,
    workspace_root: Mutex<Option<PathBuf>>,
    app_data_dir: PathBuf,
    context_engine: Mutex<Option<SqliteWalContextEngine>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFileNode {
    path: String,
    name: String,
    depth: usize,
    is_directory: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBackgroundServicesState {
    vtsls_lsp_ready: bool,
    biome_daemon_ready: bool,
    sqlite_fts5_ready: bool,
    sandbox_warm_pool_ready: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSearchResult {
    file_path: String,
    line: u32,
    snippet: String,
    freshness: &'static str,
    score: f64,
    secrets_redacted: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopAstSymbol {
    name: String,
    kind: &'static str,
    line: u32,
    exported: bool,
    confidence: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopImpactedTest {
    test_file_path: String,
    covered_symbol: String,
    confidence: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopAstAnalysis {
    symbols: Vec<DesktopAstSymbol>,
    impacted_tests: Vec<DesktopImpactedTest>,
}

fn collect_workspace_nodes(
    root: &Path,
    current: &Path,
    depth: usize,
    nodes: &mut Vec<WorkspaceFileNode>,
) -> Result<(), String> {
    if nodes.len() >= 50_000 {
        return Ok(());
    }
    let mut entries = std::fs::read_dir(current)
        .map_err(|error| format!("Failed to read {}: {error}", current.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to enumerate {}: {error}", current.display()))?;
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());

    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if matches!(name.as_str(), ".git" | "node_modules" | "target" | "dist") {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "Workspace path escaped its authorized root".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        nodes.push(WorkspaceFileNode {
            path: relative,
            name,
            depth,
            is_directory: file_type.is_dir(),
        });
        if file_type.is_dir() {
            collect_workspace_nodes(root, &path, depth + 1, nodes)?;
        }
        if nodes.len() >= 50_000 {
            break;
        }
    }
    Ok(())
}

#[tauri::command]
fn load_workspace_command(
    state: tauri::State<'_, DesktopAppState>,
    root: String,
) -> Result<Vec<WorkspaceFileNode>, String> {
    let canonical = PathBuf::from(root)
        .canonicalize()
        .map_err(|error| format!("Failed to open workspace: {error}"))?;
    if !canonical.is_dir() {
        return Err("Selected workspace is not a directory".to_string());
    }
    let mut nodes = Vec::new();
    collect_workspace_nodes(&canonical, &canonical, 0, &mut nodes)?;
    *state
        .context_engine
        .lock()
        .map_err(|_| "context engine lock poisoned".to_string())? = None;
    *state
        .workspace_root
        .lock()
        .map_err(|_| "workspace root lock poisoned".to_string())? = Some(canonical);
    Ok(nodes)
}

fn authorized_workspace_file(
    state: &tauri::State<'_, DesktopAppState>,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let root = state
        .workspace_root
        .lock()
        .map_err(|_| "workspace root lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "No workspace has been selected".to_string())?;
    resolve_authorized_workspace_file(&root, relative_path)
}

fn resolve_authorized_workspace_file(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let canonical = root
        .join(relative_path)
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace file: {error}"))?;
    if !canonical.starts_with(root) || !canonical.is_file() {
        return Err("Workspace file is outside the authorized root".to_string());
    }
    Ok(canonical)
}

#[tauri::command]
fn read_workspace_file_command(
    state: tauri::State<'_, DesktopAppState>,
    relative_path: String,
) -> Result<String, String> {
    let path = authorized_workspace_file(&state, &relative_path)?;
    let metadata = path
        .metadata()
        .map_err(|error| format!("Failed to inspect workspace file: {error}"))?;
    if metadata.len() > 4 * 1024 * 1024 {
        return Err("Files larger than 4 MB require Large File Mode".to_string());
    }
    std::fs::read_to_string(path).map_err(|error| format!("Failed to read workspace file: {error}"))
}

#[tauri::command]
fn load_session_cache_command(
    state: tauri::State<'_, DesktopAppState>,
) -> Result<Option<Vec<u8>>, String> {
    let path = state.app_data_dir.join("workspace_session_cache.bin");
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "Failed to load the workspace session cache: {error}"
        )),
    }
}

#[tauri::command]
fn save_session_cache_command(
    state: tauri::State<'_, DesktopAppState>,
    payload: Vec<u8>,
) -> Result<(), String> {
    let target = state.app_data_dir.join("workspace_session_cache.bin");
    let temporary = state.app_data_dir.join(".workspace_session_cache.bin.tmp");
    std::fs::write(&temporary, payload)
        .map_err(|error| format!("Failed to write the workspace session cache: {error}"))?;
    std::fs::rename(&temporary, &target)
        .map_err(|error| format!("Failed to commit the workspace session cache: {error}"))
}

#[tauri::command]
fn initialize_background_services_command(
    state: tauri::State<'_, DesktopAppState>,
) -> DesktopBackgroundServicesState {
    let workspace_root = state
        .workspace_root
        .lock()
        .ok()
        .and_then(|root| root.clone());
    let sqlite_fts5_ready = state
        .context_engine
        .lock()
        .map(|mut engine| {
            if engine.is_none() {
                *engine = match workspace_root.as_deref() {
                    Some(root) => SqliteWalContextEngine::open(
                        state.app_data_dir.join("context.sqlite3"),
                        "workspace",
                        AclAndSecretScanner::from_workspace_root(root),
                    )
                    .and_then(|mut context| {
                        context.rebuild_from_workspace(root)?;
                        Ok(context)
                    })
                    .ok(),
                    None => DesktopBinaryEditorBridge::open_context_engine(
                        &state.app_data_dir.join("context.sqlite3"),
                        "workspace",
                    )
                    .ok(),
                };
            }
            engine.is_some()
        })
        .unwrap_or(false);

    // Workspace-local language servers and tools remain disabled until an explicit
    // trust decision exists. Reporting them as ready here would violate fail-closed trust.
    DesktopBackgroundServicesState {
        vtsls_lsp_ready: false,
        biome_daemon_ready: false,
        sqlite_fts5_ready,
        sandbox_warm_pool_ready: false,
    }
}

#[tauri::command]
fn search_workspace_command(
    state: tauri::State<'_, DesktopAppState>,
    query: String,
    limit: usize,
) -> Result<Vec<DesktopSearchResult>, String> {
    let root = state
        .workspace_root
        .lock()
        .map_err(|_| "workspace root lock poisoned".to_string())?
        .clone();
    let bridge = state
        .bridge
        .lock()
        .map_err(|_| "desktop document bridge lock poisoned".to_string())?;
    let mut context_guard = state
        .context_engine
        .lock()
        .map_err(|_| "context engine lock poisoned".to_string())?;
    let context_engine = context_guard
        .as_mut()
        .ok_or_else(|| "Workspace search is not initialized".to_string())?;
    let hits =
        bridge.search_workspace_hybrid(context_engine, root.as_deref(), &query, limit.min(200));
    Ok(hits
        .into_iter()
        .map(|hit| {
            let freshness = match hit.excerpt.freshness {
                ExcerptFreshness::LiveUnsavedBuffer => "LiveUnsavedBuffer",
                ExcerptFreshness::IndexedCommit => "IndexedCommit",
                ExcerptFreshness::StaleNeedsReindex => "StaleNeedsReindex",
            };
            let secrets_redacted = hit.excerpt.content.matches("[REDACTED").count();
            DesktopSearchResult {
                file_path: hit.excerpt.source_path,
                line: hit.excerpt.start_line_col.line.saturating_add(1),
                snippet: hit.excerpt.content,
                freshness,
                score: hit.combined_score,
                secrets_redacted,
            }
        })
        .collect())
}

#[tauri::command]
fn analyze_document_command(
    state: tauri::State<'_, DesktopAppState>,
    document_id: String,
    session_generation: u32,
) -> Result<DesktopAstAnalysis, String> {
    let bridge = state
        .bridge
        .lock()
        .map_err(|_| "desktop document bridge lock poisoned".to_string())?;
    let (symbols, _) = bridge
        .analyze_document_ast_impact(&document_id, session_generation)
        .ok_or_else(|| "The active document session is unavailable".to_string())?;
    drop(bridge);
    let symbol_pairs: Vec<(&str, &str)> = symbols
        .iter()
        .map(|symbol| (document_id.as_str(), symbol.name.as_str()))
        .collect();
    let impacted_tests = state
        .context_engine
        .lock()
        .map_err(|_| "context engine lock poisoned".to_string())?
        .as_ref()
        .map(|engine| {
            engine
                .impact_analyzer()
                .find_impacted_tests(&symbol_pairs, 4)
        })
        .unwrap_or_default();
    let symbols = symbols
        .into_iter()
        .map(|symbol| DesktopAstSymbol {
            name: symbol.name,
            kind: match symbol.kind {
                SymbolKind::Function => "function",
                SymbolKind::ReactComponent => "component",
                SymbolKind::Class => "class",
                SymbolKind::Interface => "interface",
                SymbolKind::TypeAlias | SymbolKind::JsonKey => "type",
                SymbolKind::ConstOrVariable | SymbolKind::CssSelector => "const",
            },
            line: symbol.start_point.row.saturating_add(1),
            exported: symbol.exported,
            confidence: "ExactAstLsp",
        })
        .collect();
    let impacted_tests = impacted_tests
        .into_iter()
        .flat_map(|test| {
            let confidence = match test.confidence {
                GraphEdgeConfidence::ExactSemantic | GraphEdgeConfidence::SyntacticAst => {
                    "ExactAstLsp"
                }
                GraphEdgeConfidence::HeuristicText => "HeuristicText",
            };
            test.matched_symbols
                .into_iter()
                .map(move |covered_symbol| DesktopImpactedTest {
                    test_file_path: test.test_file_path.clone(),
                    covered_symbol,
                    confidence,
                })
        })
        .collect();
    Ok(DesktopAstAnalysis {
        symbols,
        impacted_tests,
    })
}

fn read_small_config(path: &Path) -> Option<String> {
    let metadata = path.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

#[tauri::command]
fn run_native_migration_command(
    state: tauri::State<'_, DesktopAppState>,
) -> Result<OneClickMigrationReport, String> {
    let home = std::env::var_os(if cfg!(target_os = "windows") {
        "USERPROFILE"
    } else {
        "HOME"
    })
    .map(PathBuf::from)
    .ok_or_else(|| "Unable to resolve the user configuration directory".to_string())?;
    let discovered = resolve_external_ide_paths(OsPlatform::current(), &home, None, None);
    let settings_jsonc = discovered
        .iter()
        .filter_map(|paths| paths.settings_json_path.as_deref())
        .find_map(read_small_config);
    let keybindings_jsonc = discovered
        .iter()
        .filter_map(|paths| paths.keybindings_json_path.as_deref())
        .find_map(read_small_config);
    let project_conventions = state
        .workspace_root
        .lock()
        .map_err(|_| "workspace root lock poisoned".to_string())?
        .as_deref()
        .map(discover_workspace_conventions)
        .unwrap_or_default()
        .into_iter()
        .map(|convention| (convention.file_name, convention.content))
        .collect();
    let mut report = run_one_click_migration(&OneClickMigrationInput {
        settings_jsonc,
        keybindings_jsonc,
        mcp_config_jsonc: None,
        project_conventions,
        vsix_archives: Vec::new(),
    });

    for (index, raw_config) in discovered
        .iter()
        .filter_map(|paths| paths.mcp_config_json_path.as_deref())
        .filter_map(read_small_config)
        .enumerate()
    {
        match parse_mcp_config_jsonc(&raw_config) {
            Ok(servers) => report.quarantined_mcp_servers.extend(servers),
            Err(error) => report.degraded_files.push(DegradedConfigFile {
                file_label: format!("mcp-config-{}.json", index + 1),
                reason: error.to_string(),
            }),
        }
    }
    report
        .quarantined_mcp_servers
        .sort_by(|left, right| left.server_name.cmp(&right.server_name));
    report
        .quarantined_mcp_servers
        .dedup_by(|left, right| left.server_name == right.server_name);
    Ok(report)
}

#[tauri::command]
fn open_document_binary_command(
    state: tauri::State<'_, DesktopAppState>,
    document_id: String,
    session_generation: u32,
    initial_text: String,
) -> Result<Vec<u8>, String> {
    let workspace_root = state
        .workspace_root
        .lock()
        .map_err(|_| "workspace root lock poisoned".to_string())?
        .clone();
    let mut bridge = state
        .bridge
        .lock()
        .map_err(|_| "desktop document bridge lock poisoned".to_string())?;
    match workspace_root {
        _ if document_id.starts_with("untitled:") => {
            bridge.open_document_binary(document_id, session_generation, &initial_text)
        }
        Some(root) => {
            let path = resolve_authorized_workspace_file(&root, &document_id)?;
            bridge.open_document_from_disk_binary(document_id, session_generation, path)
        }
        None => bridge.open_document_binary(document_id, session_generation, &initial_text),
    }
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn apply_binary_transaction_command(
    state: tauri::State<'_, DesktopAppState>,
    payload: Vec<u8>,
) -> Result<Vec<u8>, String> {
    state
        .bridge
        .lock()
        .map_err(|_| "desktop document bridge lock poisoned".to_string())?
        .apply_binary_transaction(&payload)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_document_binary_command(
    state: tauri::State<'_, DesktopAppState>,
    document_id: String,
    session_generation: u32,
) -> Result<Vec<u8>, String> {
    let mut bridge = state
        .bridge
        .lock()
        .map_err(|_| "desktop document bridge lock poisoned".to_string())?;
    let snapshot = bridge
        .documents_mut()
        .save_document_atomic(&document_id, session_generation)
        .map_err(|error| error.to_string())?;
    encode_editor_snapshot_ipc(&snapshot).map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let bridge = DesktopBinaryEditorBridge::with_journal(data_dir.join("documents.wal"))?;
            app.manage(DesktopAppState {
                bridge: Mutex::new(bridge),
                workspace_root: Mutex::new(None),
                app_data_dir: data_dir,
                context_engine: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_document_binary_command,
            apply_binary_transaction_command,
            save_document_binary_command,
            load_workspace_command,
            read_workspace_file_command,
            load_session_cache_command,
            save_session_cache_command,
            initialize_background_services_command,
            search_workspace_command,
            analyze_document_command,
            run_native_migration_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running Coloride");
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SystemDiagnosticsReport {
    pub host: HostHealthStatus,
    pub context: ContextEngineStatus,
    pub judge: JudgeHealthStatus,
    pub sandbox: SandboxCapabilities,
}

pub fn collect_system_diagnostics() -> SystemDiagnosticsReport {
    SystemDiagnosticsReport {
        host: host_core::healthcheck(),
        context: context_engine::healthcheck(),
        judge: judge_orchestrator::healthcheck(),
        sandbox: sandbox_runner::healthcheck(),
    }
}

/// Binary IPC bridge connecting the Tauri v2 shell and CodeMirror 6 (`LOT-004`, `LOT-005`)
/// to `host_core::DocumentService` and `LazyBootOrchestrator`.
#[derive(Debug)]
pub struct DesktopBinaryEditorBridge {
    documents: DocumentService,
    lazy_boot: LazyBootOrchestrator,
}

impl Default for DesktopBinaryEditorBridge {
    fn default() -> Self {
        Self::new_in_memory()
    }
}

impl DesktopBinaryEditorBridge {
    #[must_use]
    pub fn new_in_memory() -> Self {
        Self {
            documents: DocumentService::new_in_memory(),
            lazy_boot: LazyBootOrchestrator::new(),
        }
    }

    pub fn with_journal(
        journal_path: impl Into<std::path::PathBuf>,
    ) -> Result<Self, DocumentError> {
        Ok(Self {
            documents: DocumentService::with_journal(journal_path)?,
            lazy_boot: LazyBootOrchestrator::new(),
        })
    }

    /// Execute Lazy Boot Phase 1 (`workspace_session_cache.bin` + active buffer restoration in `< 3 s`).
    pub fn lazy_boot_restore(
        &mut self,
        cache_dir: Option<&Path>,
    ) -> Result<LazyBootReadySnapshot, LazyBootError> {
        self.lazy_boot
            .restore_interactive_session(cache_dir, &mut self.documents)
    }

    /// Spawn low-priority Tokio tasks to initialize heavy secondary services after window restoration.
    pub fn spawn_background_services(&self) -> tokio::task::JoinHandle<BackgroundServicesStatus> {
        self.lazy_boot.spawn_deferred_background_services()
    }

    #[must_use]
    pub fn background_services_status(&self) -> BackgroundServicesStatus {
        self.lazy_boot.background_status()
    }

    pub fn open_document_binary(
        &mut self,
        document_id: impl Into<String>,
        session_generation: u32,
        initial_text: &str,
    ) -> Result<Vec<u8>, DocumentError> {
        let snapshot: EditorSnapshot = self.documents.open_document_from_str(
            document_id,
            session_generation,
            None,
            initial_text,
        )?;
        encode_editor_snapshot_ipc(&snapshot).map_err(|error| {
            DocumentError::EditorIpc(format!("EditorSnapshot IPC encode failed: {error}"))
        })
    }

    pub fn open_document_from_disk_binary(
        &mut self,
        document_id: impl Into<String>,
        session_generation: u32,
        disk_path: impl Into<PathBuf>,
    ) -> Result<Vec<u8>, DocumentError> {
        let snapshot =
            self.documents
                .open_document_from_disk(document_id, session_generation, disk_path)?;
        encode_editor_snapshot_ipc(&snapshot).map_err(|error| {
            DocumentError::EditorIpc(format!("EditorSnapshot IPC encode failed: {error}"))
        })
    }

    pub fn apply_binary_transaction(&mut self, tx_bytes: &[u8]) -> Result<Vec<u8>, DocumentError> {
        let tx = decode_editor_transaction_ipc(tx_bytes).map_err(|error| {
            DocumentError::EditorIpc(format!("EditorTransaction IPC decode failed: {error}"))
        })?;
        let snapshot = self.documents.apply_transaction(tx)?;
        encode_editor_snapshot_ipc(&snapshot).map_err(|error| {
            DocumentError::EditorIpc(format!("EditorSnapshot IPC encode failed: {error}"))
        })
    }

    #[must_use]
    pub const fn document_service(&self) -> &DocumentService {
        &self.documents
    }

    pub fn documents_mut(&mut self) -> &mut DocumentService {
        &mut self.documents
    }

    /// Analyze AST symbols and impacted tests (`LOT-007`) for a live buffer in `DocumentService`.
    pub fn analyze_document_ast_impact(
        &self,
        document_id: &str,
        session_generation: u32,
    ) -> Option<(Vec<ExtractedSymbol>, Vec<TestFileTarget>)> {
        let session = self
            .documents
            .session(document_id, session_generation)
            .ok()?;
        let mut parser = IncrementalAstParser::new();
        let lang = SupportedAstLanguage::from_path(document_id);
        let provider = RopeTextProvider::new(session.rope());
        let tree = parser.parse_with(lang, &provider, None);
        let symbols = tree.symbols();
        let pairs: Vec<(&str, &str)> = symbols
            .iter()
            .map(|s| (document_id, s.name.as_str()))
            .collect();
        let mut analyzer = ImpactAnalyzer::new();
        analyzer.index_file(document_id, session.rope(), &tree);
        let impacted = analyzer.find_impacted_tests(&pairs, 4);
        Some((symbols, impacted))
    }

    /// Query `SqliteWalContextEngine` (`LOT-008`) after synchronizing `UnsavedBufferOverlay`
    /// from `DocumentService` so unsaved edits in CodeMirror 6 take 100% priority.
    pub fn search_workspace_hybrid(
        &self,
        context_engine: &mut SqliteWalContextEngine,
        workspace_root: Option<&Path>,
        query: &str,
        limit: usize,
    ) -> Vec<ContextSearchHit> {
        context_engine
            .overlay_mut()
            .sync_from_document_service(workspace_root, &self.documents);
        context_engine.query_hybrid(query, limit)
    }

    /// Create an initialized `SqliteWalContextEngine` at `db_path` with default `AclAndSecretScanner`.
    pub fn open_context_engine(
        db_path: &Path,
        git_branch: &str,
    ) -> Result<SqliteWalContextEngine, context_engine::ContextStorageError> {
        SqliteWalContextEngine::open(db_path, git_branch, AclAndSecretScanner::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use host_core::{
        encode_editor_transaction_ipc, EditorSelection, EditorTransaction, TextChange,
        TransactionOrigin, Utf16CodeUnitOffset, Utf16Span, CONTRACT_SCHEMA_VERSION,
    };

    #[test]
    fn desktop_shell_aggregates_all_four_rust_crates() {
        let report = collect_system_diagnostics();
        assert!(report.host.ready);
        assert!(report.context.zero_mb_boot_ready);
        assert!(report.judge.deterministic_evidence_required);
        assert!(!report.judge.policy_engine_operational);
        assert!(report.sandbox.fail_closed_enforced);
        assert!(!report.sandbox.execution_available);
    }

    #[test]
    fn workspace_file_resolution_rejects_parent_and_symlink_escapes() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("workspace");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("inside.ts"), "export const inside = true;\n").unwrap();
        std::fs::write(parent.path().join("outside.ts"), "secret\n").unwrap();
        let root = root.canonicalize().unwrap();

        assert_eq!(
            resolve_authorized_workspace_file(&root, "inside.ts").unwrap(),
            root.join("inside.ts")
        );
        assert!(resolve_authorized_workspace_file(&root, "../outside.ts").is_err());

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(parent.path().join("outside.ts"), root.join("link.ts"))
                .unwrap();
            assert!(resolve_authorized_workspace_file(&root, "link.ts").is_err());
        }
    }

    #[test]
    fn desktop_binary_editor_bridge_applies_transactions_and_guards_stale_generations() {
        let mut bridge = DesktopBinaryEditorBridge::new_in_memory();
        let open_bytes = bridge
            .open_document_binary("main.ts", 1, "const a = 1;\n")
            .unwrap();
        assert_eq!(&open_bytes[..4], &0x434c_534e_u32.to_le_bytes());
        assert_eq!(
            bridge
                .document_service()
                .session("main.ts", 1)
                .unwrap()
                .interactive_revision(),
            0
        );

        let tx = EditorTransaction {
            schema_version: CONTRACT_SCHEMA_VERSION,
            document_id: "main.ts".to_string(),
            session_generation: 1,
            base_revision: 0,
            op_id: "op-1".to_string(),
            changes: vec![TextChange {
                range_utf16: Utf16Span::new(
                    Utf16CodeUnitOffset::new(10),
                    Utf16CodeUnitOffset::new(11),
                ),
                range_utf8: None,
                inserted_text: "42".to_string(),
            }],
            selection: EditorSelection::default(),
            origin: TransactionOrigin::User,
            ime_composing: false,
        };
        let tx_bytes = encode_editor_transaction_ipc(&tx).unwrap();
        let snap_bytes = bridge.apply_binary_transaction(&tx_bytes).unwrap();
        assert_eq!(&snap_bytes[..4], &0x434c_534e_u32.to_le_bytes());
        assert_eq!(
            bridge
                .document_service()
                .session("main.ts", 1)
                .unwrap()
                .text(),
            "const a = 42;\n"
        );
    }

    #[test]
    fn desktop_binary_editor_bridge_rejects_malformed_ipc_without_panicking() {
        let mut bridge = DesktopBinaryEditorBridge::new_in_memory();
        bridge
            .open_document_binary("main.ts", 1, "const safe = true;\n")
            .unwrap();
        let error = bridge.apply_binary_transaction(&[0x43, 0x4c]).unwrap_err();
        assert!(error.to_string().contains("IPC decode failed"));
        assert_eq!(
            bridge
                .document_service()
                .session("main.ts", 1)
                .unwrap()
                .text(),
            "const safe = true;\n"
        );
    }

    #[tokio::test]
    async fn desktop_lazy_boot_restores_cached_session_and_accepts_first_keystroke_under_3s() {
        let dir = tempfile::tempdir().unwrap();
        let cache = host_core::WorkspaceSessionCache {
            schema_version: CONTRACT_SCHEMA_VERSION,
            workspace_root: "/workspace/app".to_string(),
            active_persona: "Develop".to_string(),
            active_activity_panel: "sessions".to_string(),
            grid_mode: 4,
            active_inspector_tab: "code-diff".to_string(),
            active_chat_id: "chat-1".to_string(),
            active_document_id: "src/app.ts".to_string(),
            active_document_content: "const ready = false;\n".to_string(),
            cursor_utf16_offset: 14,
            scroll_top_px: 0,
            ui_zoom_percent: 100,
            sidebar_visible: true,
        };
        host_core::save_workspace_session_cache(dir.path(), &cache).unwrap();

        let boot_start = std::time::Instant::now();
        let mut bridge = DesktopBinaryEditorBridge::new_in_memory();
        let boot_snap = bridge.lazy_boot_restore(Some(dir.path())).unwrap();
        let bg_handle = bridge.spawn_background_services();

        // First keystroke immediately after window restoration (before background services complete)
        let first_keystroke = EditorTransaction {
            schema_version: CONTRACT_SCHEMA_VERSION,
            document_id: boot_snap.session_cache.active_document_id.clone(),
            session_generation: 1,
            base_revision: 0,
            op_id: "first-keystroke".to_string(),
            changes: vec![TextChange {
                range_utf16: Utf16Span::new(
                    Utf16CodeUnitOffset::new(14),
                    Utf16CodeUnitOffset::new(19),
                ),
                range_utf8: None,
                inserted_text: "true".to_string(),
            }],
            selection: EditorSelection::default(),
            origin: TransactionOrigin::User,
            ime_composing: false,
        };
        let tx_bytes = encode_editor_transaction_ipc(&first_keystroke).unwrap();
        bridge.apply_binary_transaction(&tx_bytes).unwrap();
        let first_keystroke_elapsed = boot_start.elapsed();

        assert!(
            first_keystroke_elapsed.as_millis() <= 3_000,
            "Lazy Boot + first keystroke took {} ms (> 3000 ms)",
            first_keystroke_elapsed.as_millis()
        );
        assert_eq!(
            bridge
                .document_service()
                .session("src/app.ts", 1)
                .unwrap()
                .interactive_revision(),
            1
        );
        assert_eq!(
            bridge
                .document_service()
                .session("src/app.ts", 1)
                .unwrap()
                .text(),
            "const ready = true;\n"
        );

        let bg_status = bg_handle.await.unwrap();
        assert!(bg_status.all_ready());
    }
}
