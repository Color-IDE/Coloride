//! 1-click migration from other editors (read-only discovery, quarantined MCP servers).

use std::path::{Path, PathBuf};

use host_core::{
    discover_workspace_conventions, parse_mcp_config_jsonc, resolve_external_ide_paths,
    run_one_click_migration, DegradedConfigFile, OneClickMigrationInput, OneClickMigrationReport,
    OsPlatform,
};

use crate::state::DesktopAppState;

fn read_small_config(path: &Path) -> Option<String> {
    let metadata = path.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

#[tauri::command]
pub fn run_native_migration_command(
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
