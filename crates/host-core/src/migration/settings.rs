//! Editor settings and keymap preset imported from `settings.json` (`LOT-006`).

use super::*;

/// Canonical keymap presets supported in 1-click selection (`LOT-006`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum KeymapPreset {
    #[default]
    VsCode,
    Vim,
    JetBrains,
}

/// Normalized editor preferences extracted during onboarding (`LOT-006`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportedEditorSettings {
    pub color_theme: String,
    pub icon_theme: String,
    pub font_family: String,
    pub font_size: u16,
    pub tab_size: u8,
    pub insert_spaces: bool,
    pub keymap_preset: KeymapPreset,
}

impl Default for ImportedEditorSettings {
    fn default() -> Self {
        Self {
            color_theme: DEFAULT_COLORIDE_THEME.to_string(),
            icon_theme: DEFAULT_COLORIDE_ICON_THEME.to_string(),
            font_family: DEFAULT_COLORIDE_FONT_FAMILY.to_string(),
            font_size: DEFAULT_COLORIDE_FONT_SIZE,
            tab_size: DEFAULT_COLORIDE_TAB_SIZE,
            insert_spaces: true,
            keymap_preset: KeymapPreset::VsCode,
        }
    }
}

/// Parse VS Code or Cursor `settings.json` (JSONC) into `ImportedEditorSettings`.
pub fn parse_settings_jsonc(input: &str) -> Result<ImportedEditorSettings, MigrationError> {
    let val = parse_jsonc(input)?;
    let obj = val
        .as_object()
        .ok_or_else(|| MigrationError::JsoncSyntax("Root settings must be a JSON object".into()))?;

    let mut settings = ImportedEditorSettings::default();

    if let Some(theme) = obj.get("workbench.colorTheme").and_then(|v| v.as_str()) {
        if !theme.trim().is_empty() {
            settings.color_theme = theme.trim().to_string();
        }
    }
    if let Some(icon_theme) = obj.get("workbench.iconTheme").and_then(|v| v.as_str()) {
        if !icon_theme.trim().is_empty() {
            settings.icon_theme = icon_theme.trim().to_string();
        }
    }
    if let Some(font_family) = obj.get("editor.fontFamily").and_then(|v| v.as_str()) {
        if !font_family.trim().is_empty() {
            settings.font_family = font_family.trim().to_string();
        }
    }
    if let Some(font_size) = obj.get("editor.fontSize").and_then(|v| v.as_u64()) {
        let clamped = font_size.clamp(8, 64) as u16;
        settings.font_size = clamped;
    }
    if let Some(tab_size) = obj.get("editor.tabSize").and_then(|v| v.as_u64()) {
        let clamped = tab_size.clamp(1, 16) as u8;
        settings.tab_size = clamped;
    }
    if let Some(insert_spaces) = obj.get("editor.insertSpaces").and_then(|v| v.as_bool()) {
        settings.insert_spaces = insert_spaces;
    }

    // Detect Vim or JetBrains keymap preference if configured in settings
    if let Some(keymap_raw) = obj
        .get("coloride.keymapPreset")
        .or_else(|| obj.get("keymap.preset"))
        .and_then(|v| v.as_str())
    {
        let lower = keymap_raw.to_ascii_lowercase();
        if lower.contains("vim") {
            settings.keymap_preset = KeymapPreset::Vim;
        } else if lower.contains("jetbrains") || lower.contains("intellij") {
            settings.keymap_preset = KeymapPreset::JetBrains;
        }
    } else if obj
        .get("vim.useSystemClipboard")
        .or_else(|| obj.get("vim.hlsearch"))
        .is_some()
    {
        settings.keymap_preset = KeymapPreset::Vim;
    }

    Ok(settings)
}
