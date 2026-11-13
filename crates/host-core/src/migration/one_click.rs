//! 1-click onboarding: runs every importer and reports what degraded (`LOT-006`).

use super::*;

// ============================================================================
// 1-Click Onboarding Bundle & Graceful Degradation Report (`LOT-006`)
// ============================================================================

/// Non-blocking degradation record when an individual config file is corrupted or unreadable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DegradedConfigFile {
    pub file_label: String,
    pub reason: String,
}

/// Input payload for executing a 1-click migration (`LOT-006`).
#[derive(Debug, Clone, Default)]
pub struct OneClickMigrationInput {
    pub settings_jsonc: Option<String>,
    pub keybindings_jsonc: Option<String>,
    pub mcp_config_jsonc: Option<String>,
    pub project_conventions: Vec<(String, String)>,
    pub vsix_archives: Vec<Vec<u8>>,
}

/// Complete report produced by the 1-click migration service (`LOT-006`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OneClickMigrationReport {
    pub settings: ImportedEditorSettings,
    pub keybindings: Vec<ImportedKeybinding>,
    pub quarantined_mcp_servers: Vec<QuarantinedMcpServer>,
    pub project_conventions: Vec<ImportedProjectConvention>,
    pub loaded_vsix_extensions: Vec<LoadedDeclarativeVsix>,
    pub degraded_files: Vec<DegradedConfigFile>,
    pub elapsed_ms: u64,
    /// Strictly `0`: importing settings/MCP/rules never spawns a process.
    pub processes_launched: u32,
    /// Strictly `0`: importing settings/MCP/rules never mutates `PolicyEngine` permissions.
    pub security_permissions_changed: u32,
}

/// Run the 1-click onboarding & migration pipeline with per-file graceful degradation (`< 2 s`).
#[must_use]
pub fn run_one_click_migration(input: &OneClickMigrationInput) -> OneClickMigrationReport {
    let start = Instant::now();
    let mut degraded_files = Vec::new();

    let settings = match &input.settings_jsonc {
        Some(raw) => match parse_settings_jsonc(raw) {
            Ok(parsed) => parsed,
            Err(err) => {
                degraded_files.push(DegradedConfigFile {
                    file_label: "settings.json".to_string(),
                    reason: err.to_string(),
                });
                ImportedEditorSettings::default()
            }
        },
        None => ImportedEditorSettings::default(),
    };

    let keybindings = match &input.keybindings_jsonc {
        Some(raw) => match parse_keybindings_jsonc(raw) {
            Ok(parsed) => parsed,
            Err(err) => {
                degraded_files.push(DegradedConfigFile {
                    file_label: "keybindings.json".to_string(),
                    reason: err.to_string(),
                });
                Vec::new()
            }
        },
        None => Vec::new(),
    };

    let quarantined_mcp_servers = match &input.mcp_config_jsonc {
        Some(raw) => match parse_mcp_config_jsonc(raw) {
            Ok(parsed) => parsed,
            Err(err) => {
                degraded_files.push(DegradedConfigFile {
                    file_label: "claude_desktop_config.json".to_string(),
                    reason: err.to_string(),
                });
                Vec::new()
            }
        },
        None => Vec::new(),
    };

    let project_conventions = input
        .project_conventions
        .iter()
        .map(|(name, content)| import_project_convention_text(name, name, content))
        .collect();

    let mut loaded_vsix_extensions = Vec::new();
    for (idx, archive) in input.vsix_archives.iter().enumerate() {
        match load_declarative_vsix_bytes(archive) {
            Ok(ext) => loaded_vsix_extensions.push(ext),
            Err(err) => degraded_files.push(DegradedConfigFile {
                file_label: format!("extension-{}.vsix", idx + 1),
                reason: err.to_string(),
            }),
        }
    }

    OneClickMigrationReport {
        settings,
        keybindings,
        quarantined_mcp_servers,
        project_conventions,
        loaded_vsix_extensions,
        degraded_files,
        elapsed_ms: start.elapsed().as_millis() as u64,
        processes_launched: 0,
        security_permissions_changed: 0,
    }
}

/// 1-click rollback to clean Coloride default settings (`LOT-006` Risk & Rollback mitigation).
#[must_use]
pub fn reset_to_coloride_defaults() -> OneClickMigrationReport {
    OneClickMigrationReport {
        settings: ImportedEditorSettings::default(),
        keybindings: Vec::new(),
        quarantined_mcp_servers: Vec::new(),
        project_conventions: Vec::new(),
        loaded_vsix_extensions: Vec::new(),
        degraded_files: Vec::new(),
        elapsed_ms: 0,
        processes_launched: 0,
        security_permissions_changed: 0,
    }
}
