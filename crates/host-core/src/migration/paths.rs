//! External IDE discovery: where VS Code, Cursor and Claude Desktop keep their configuration (`LOT-006`).

use super::*;

/// Target operating system convention for external IDE discovery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum OsPlatform {
    MacOs,
    Windows,
    Linux,
}

impl OsPlatform {
    #[must_use]
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

/// External applications supported by the 1-click onboarding importer (`LOT-006`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum ExternalIdeSource {
    VsCode,
    Cursor,
    ClaudeDesktop,
}

/// Discovered file locations for an external IDE/assistant on macOS, Windows, or Linux.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalIdePaths {
    pub source: ExternalIdeSource,
    pub platform: OsPlatform,
    pub settings_json_path: Option<PathBuf>,
    pub keybindings_json_path: Option<PathBuf>,
    pub mcp_config_json_path: Option<PathBuf>,
}

/// Resolve the standard read-only configuration paths for VS Code, Cursor, and Claude Desktop
/// across macOS (`~/Library/Application Support/...`), Windows (`%APPDATA%\...`), and Linux (`~/.config/...`).
#[must_use]
pub fn resolve_external_ide_paths(
    platform: OsPlatform,
    home_dir: &Path,
    appdata_override: Option<&Path>,
    xdg_config_override: Option<&Path>,
) -> Vec<ExternalIdePaths> {
    let base_config_dir = match platform {
        OsPlatform::MacOs => home_dir.join("Library").join("Application Support"),
        OsPlatform::Windows => appdata_override
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home_dir.join("AppData").join("Roaming")),
        OsPlatform::Linux => xdg_config_override
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home_dir.join(".config")),
    };

    let vscode_user = base_config_dir.join("Code").join("User");
    let cursor_user = base_config_dir.join("Cursor").join("User");
    let claude_dir = base_config_dir.join("Claude");

    vec![
        ExternalIdePaths {
            source: ExternalIdeSource::VsCode,
            platform,
            settings_json_path: Some(vscode_user.join("settings.json")),
            keybindings_json_path: Some(vscode_user.join("keybindings.json")),
            mcp_config_json_path: Some(vscode_user.join("mcp.json")),
        },
        ExternalIdePaths {
            source: ExternalIdeSource::Cursor,
            platform,
            settings_json_path: Some(cursor_user.join("settings.json")),
            keybindings_json_path: Some(cursor_user.join("keybindings.json")),
            mcp_config_json_path: Some(home_dir.join(".cursor").join("mcp.json")),
        },
        ExternalIdePaths {
            source: ExternalIdeSource::ClaudeDesktop,
            platform,
            settings_json_path: None,
            keybindings_json_path: None,
            mcp_config_json_path: Some(claude_dir.join("claude_desktop_config.json")),
        },
    ]
}
