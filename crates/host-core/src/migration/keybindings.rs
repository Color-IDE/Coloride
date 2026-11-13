//! Keybinding translation from VS Code / Cursor to CodeMirror 6 (`LOT-006`).

use super::*;

/// A keybinding translated from VS Code / Cursor / `.vsix` to CodeMirror 6 format.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportedKeybinding {
    pub raw_key: String,
    pub cm6_key: String,
    pub command: String,
    pub when_clause: Option<String>,
}

/// Translate a VS Code / Cursor key chord (e.g. `"ctrl+shift+p"` or `"cmd+k cmd+s"`)
/// into CodeMirror 6 normalized key syntax (`"Mod-Shift-p"`, `"Mod-k Mod-s"`).
#[must_use]
pub fn translate_vscode_key_to_cm6(raw_key: &str) -> String {
    let chords: Vec<String> = raw_key
        .split_whitespace()
        .filter(|s| !s.is_empty())
        .map(|chord| {
            let parts: Vec<&str> = chord.split('+').filter(|p| !p.is_empty()).collect();
            let mut normalized = Vec::with_capacity(parts.len());
            for part in parts {
                let lower = part.trim().to_ascii_lowercase();
                let mapped = match lower.as_str() {
                    "cmd" | "ctrl" | "meta" | "ctrlcmd" | "cmdorctrl" => "Mod".to_string(),
                    "shift" => "Shift".to_string(),
                    "alt" | "opt" | "option" => "Alt".to_string(),
                    "enter" | "return" => "Enter".to_string(),
                    "esc" | "escape" => "Escape".to_string(),
                    "backspace" => "Backspace".to_string(),
                    "delete" | "del" => "Delete".to_string(),
                    "tab" => "Tab".to_string(),
                    "space" => "Space".to_string(),
                    "up" | "arrowup" => "ArrowUp".to_string(),
                    "down" | "arrowdown" => "ArrowDown".to_string(),
                    "left" | "arrowleft" => "ArrowLeft".to_string(),
                    "right" | "arrowright" => "ArrowRight".to_string(),
                    other => other.to_string(),
                };
                normalized.push(mapped);
            }
            normalized.join("-")
        })
        .collect();
    chords.join(" ")
}

/// Parse `keybindings.json` (JSONC array) into a list of `ImportedKeybinding`s.
pub fn parse_keybindings_jsonc(input: &str) -> Result<Vec<ImportedKeybinding>, MigrationError> {
    let val = parse_jsonc(input)?;
    let arr = val.as_array().ok_or_else(|| {
        MigrationError::JsoncSyntax("keybindings.json root must be a JSON array".into())
    })?;

    let mut out = Vec::with_capacity(arr.len());
    for entry in arr {
        if let Some(obj) = entry.as_object() {
            let Some(raw_key) = obj.get("key").and_then(|v| v.as_str()) else {
                continue;
            };
            let Some(command) = obj.get("command").and_then(|v| v.as_str()) else {
                continue;
            };
            if raw_key.trim().is_empty() || command.trim().is_empty() {
                continue;
            }
            let when_clause = obj
                .get("when")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());

            out.push(ImportedKeybinding {
                raw_key: raw_key.trim().to_string(),
                cm6_key: translate_vscode_key_to_cm6(raw_key),
                command: command.trim().to_string(),
                when_clause,
            });
        }
    }
    Ok(out)
}
