//! Declarative `.vsix` archives: zip loading and theme / snippet / keybinding contributions (`LOT-006`).

use super::*;

// ============================================================================
// Tier-1 Declarative OpenVSX (`.vsix`) Native Archive Loader (`LOT-006`)
// ============================================================================

/// Declarative color theme extracted from a `.vsix` package.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VsixThemeContribution {
    pub label: String,
    pub ui_theme: String,
    pub path: String,
    pub editor_background: Option<String>,
    pub editor_foreground: Option<String>,
}

/// Declarative code snippet extracted from a `.vsix` package.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VsixSnippetContribution {
    pub language: String,
    pub name: String,
    pub prefix: String,
    pub body: Vec<String>,
    pub description: Option<String>,
}

/// Summary of a loaded Tier-1 declarative `.vsix` extension (`LOT-006`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoadedDeclarativeVsix {
    pub extension_id: String,
    pub name: String,
    pub publisher: String,
    pub version: String,
    pub display_name: Option<String>,
    pub themes: Vec<VsixThemeContribution>,
    pub icon_themes: Vec<String>,
    pub snippets: Vec<VsixSnippetContribution>,
    pub keybindings: Vec<ImportedKeybinding>,
    pub languages: Vec<String>,
    /// True if the `.vsix` contained a `main` or `browser` JS entrypoint that was quarantined
    /// in Tier-1 mode (`LOT-029` handles imperative `vscode.*` execution in an isolated Host Shim).
    pub imperative_entrypoint_quarantined: bool,
    /// Strictly `0` during Tier-1 declarative `.vsix` loading.
    pub executed_js_entrypoints: u32,
}

/// Build an uncompressed (ZIP `STORE`, method `0`) `.vsix` archive in memory from `(path, bytes)` entries.
/// Used for packaging declarative `.vsix` bundles and deterministic cross-OS unit testing.
#[must_use]
pub fn build_vsix_zip_archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut archive = Vec::new();
    let mut central_directory = Vec::new();

    for (name, data) in entries {
        let name_bytes = name.as_bytes();
        let local_header_offset = archive.len() as u32;
        let data_len = data.len() as u32;
        let name_len = name_bytes.len() as u16;

        // Local file header signature: PK\x03\x04
        archive.extend_from_slice(&[0x50, 0x4b, 0x03, 0x04]);
        archive.extend_from_slice(&20u16.to_le_bytes()); // version needed (2.0)
        archive.extend_from_slice(&0u16.to_le_bytes()); // flags
        archive.extend_from_slice(&0u16.to_le_bytes()); // compression method 0 (STORE)
        archive.extend_from_slice(&0u16.to_le_bytes()); // mod time
        archive.extend_from_slice(&0u16.to_le_bytes()); // mod date
        archive.extend_from_slice(&0u32.to_le_bytes()); // crc32 (0 for store reader)
        archive.extend_from_slice(&data_len.to_le_bytes()); // compressed size
        archive.extend_from_slice(&data_len.to_le_bytes()); // uncompressed size
        archive.extend_from_slice(&name_len.to_le_bytes()); // file name length
        archive.extend_from_slice(&0u16.to_le_bytes()); // extra field length
        archive.extend_from_slice(name_bytes);
        archive.extend_from_slice(data);

        // Central directory file header signature: PK\x01\x02
        central_directory.extend_from_slice(&[0x50, 0x4b, 0x01, 0x02]);
        central_directory.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central_directory.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central_directory.extend_from_slice(&0u16.to_le_bytes()); // flags
        central_directory.extend_from_slice(&0u16.to_le_bytes()); // compression method 0
        central_directory.extend_from_slice(&0u16.to_le_bytes()); // mod time
        central_directory.extend_from_slice(&0u16.to_le_bytes()); // mod date
        central_directory.extend_from_slice(&0u32.to_le_bytes()); // crc32
        central_directory.extend_from_slice(&data_len.to_le_bytes());
        central_directory.extend_from_slice(&data_len.to_le_bytes());
        central_directory.extend_from_slice(&name_len.to_le_bytes());
        central_directory.extend_from_slice(&0u16.to_le_bytes()); // extra len
        central_directory.extend_from_slice(&0u16.to_le_bytes()); // comment len
        central_directory.extend_from_slice(&0u16.to_le_bytes()); // disk number
        central_directory.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        central_directory.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        central_directory.extend_from_slice(&local_header_offset.to_le_bytes());
        central_directory.extend_from_slice(name_bytes);
    }

    let cd_offset = archive.len() as u32;
    let cd_size = central_directory.len() as u32;
    let count = entries.len() as u16;
    archive.extend_from_slice(&central_directory);

    // End of central directory record: PK\x05\x06
    archive.extend_from_slice(&[0x50, 0x4b, 0x05, 0x06]);
    archive.extend_from_slice(&0u16.to_le_bytes()); // disk number
    archive.extend_from_slice(&0u16.to_le_bytes()); // start disk
    archive.extend_from_slice(&count.to_le_bytes());
    archive.extend_from_slice(&count.to_le_bytes());
    archive.extend_from_slice(&cd_size.to_le_bytes());
    archive.extend_from_slice(&cd_offset.to_le_bytes());
    archive.extend_from_slice(&0u16.to_le_bytes()); // comment len

    archive
}

/// Extract stored files from a `.vsix` (ZIP) archive into a map of normalized relative paths to UTF-8 strings.
pub fn extract_vsix_zip_entries(
    archive_bytes: &[u8],
) -> Result<BTreeMap<String, Vec<u8>>, MigrationError> {
    if archive_bytes.len() < 4 || &archive_bytes[0..4] != b"PK\x03\x04" {
        return Err(MigrationError::InvalidVsixArchive(
            "Missing ZIP PK\\x03\\x04 signature".into(),
        ));
    }

    let mut entries = BTreeMap::new();
    let mut offset = 0usize;
    let total = archive_bytes.len();

    while offset + 4 <= total {
        let sig = &archive_bytes[offset..offset + 4];
        if sig == b"PK\x01\x02" || sig == b"PK\x05\x06" {
            break;
        }
        if sig != b"PK\x03\x04" {
            return Err(MigrationError::InvalidVsixArchive(format!(
                "Unexpected ZIP header signature at byte offset {offset}"
            )));
        }
        if offset + 30 > total {
            return Err(MigrationError::InvalidVsixArchive(
                "Truncated local file header".into(),
            ));
        }

        let compression_method =
            u16::from_le_bytes([archive_bytes[offset + 8], archive_bytes[offset + 9]]);
        if compression_method != 0 {
            return Err(MigrationError::InvalidVsixArchive(format!(
                "Unsupported ZIP compression method {compression_method} (expected STORE=0)"
            )));
        }

        let compressed_size = u32::from_le_bytes([
            archive_bytes[offset + 18],
            archive_bytes[offset + 19],
            archive_bytes[offset + 20],
            archive_bytes[offset + 21],
        ]) as usize;
        let name_len =
            u16::from_le_bytes([archive_bytes[offset + 26], archive_bytes[offset + 27]]) as usize;
        let extra_len =
            u16::from_le_bytes([archive_bytes[offset + 28], archive_bytes[offset + 29]]) as usize;

        let name_start = offset + 30;
        let name_end = name_start + name_len;
        let data_start = name_end + extra_len;
        let data_end = data_start + compressed_size;

        if data_end > total {
            return Err(MigrationError::InvalidVsixArchive(
                "ZIP entry payload exceeds archive bounds".into(),
            ));
        }

        let raw_name =
            String::from_utf8_lossy(&archive_bytes[name_start..name_end]).replace('\\', "/");
        let normalized_name = raw_name
            .strip_prefix("extension/")
            .unwrap_or(&raw_name)
            .trim_start_matches("./")
            .to_string();

        entries.insert(
            normalized_name,
            archive_bytes[data_start..data_end].to_vec(),
        );
        offset = data_end;
    }

    Ok(entries)
}

fn normalize_rel_asset_path(raw: &str) -> String {
    raw.replace('\\', "/")
        .trim_start_matches("./")
        .trim_start_matches('/')
        .to_string()
}

/// Parse and load a declarative `.vsix` package from raw archive bytes (`LOT-006`).
/// Extracts themes, icon themes, snippets, keybindings, and languages while quarantining any
/// imperative `main` / `browser` JavaScript entrypoints (`executed_js_entrypoints = 0`).
pub fn load_declarative_vsix_bytes(
    archive_bytes: &[u8],
) -> Result<LoadedDeclarativeVsix, MigrationError> {
    let entries = extract_vsix_zip_entries(archive_bytes)?;
    let manifest_bytes = entries
        .get("package.json")
        .ok_or(MigrationError::MissingVsixManifest)?;
    let manifest_str = String::from_utf8_lossy(manifest_bytes);
    let manifest = parse_jsonc(&manifest_str)?;
    let obj = manifest.as_object().ok_or_else(|| {
        MigrationError::JsoncSyntax("VSIX package.json must be a JSON object".into())
    })?;

    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown-extension")
        .to_string();
    let publisher = obj
        .get("publisher")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown-publisher")
        .to_string();
    let version = obj
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0")
        .to_string();
    let display_name = obj
        .get("displayName")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    let imperative_entrypoint_quarantined =
        obj.get("main").is_some() || obj.get("browser").is_some();

    let mut themes = Vec::new();
    let mut icon_themes = Vec::new();
    let mut snippets = Vec::new();
    let mut keybindings = Vec::new();
    let mut languages = Vec::new();

    if let Some(contributes) = obj.get("contributes").and_then(|v| v.as_object()) {
        // 1. Themes
        if let Some(theme_arr) = contributes.get("themes").and_then(|v| v.as_array()) {
            for t in theme_arr {
                if let Some(t_obj) = t.as_object() {
                    let label = t_obj
                        .get("label")
                        .or_else(|| t_obj.get("id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unnamed Theme")
                        .to_string();
                    let ui_theme = t_obj
                        .get("uiTheme")
                        .and_then(|v| v.as_str())
                        .unwrap_or("vs-dark")
                        .to_string();
                    let raw_path = t_obj
                        .get("path")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();
                    let rel_path = normalize_rel_asset_path(raw_path);

                    let mut editor_background = None;
                    let mut editor_foreground = None;
                    if let Some(theme_bytes) = entries.get(&rel_path) {
                        if let Ok(theme_json) = parse_jsonc(&String::from_utf8_lossy(theme_bytes)) {
                            if let Some(colors) =
                                theme_json.get("colors").and_then(|c| c.as_object())
                            {
                                editor_background = colors
                                    .get("editor.background")
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string);
                                editor_foreground = colors
                                    .get("editor.foreground")
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string);
                            }
                        }
                    }

                    themes.push(VsixThemeContribution {
                        label,
                        ui_theme,
                        path: rel_path,
                        editor_background,
                        editor_foreground,
                    });
                }
            }
        }

        // 2. Icon Themes
        if let Some(icons_arr) = contributes.get("iconThemes").and_then(|v| v.as_array()) {
            for icon in icons_arr {
                if let Some(label) = icon
                    .as_object()
                    .and_then(|o| o.get("label").or_else(|| o.get("id")))
                    .and_then(|v| v.as_str())
                {
                    icon_themes.push(label.to_string());
                }
            }
        }

        // 3. Snippets
        if let Some(snip_arr) = contributes.get("snippets").and_then(|v| v.as_array()) {
            for snip in snip_arr {
                if let Some(s_obj) = snip.as_object() {
                    let language = s_obj
                        .get("language")
                        .and_then(|v| v.as_str())
                        .unwrap_or("plaintext")
                        .to_string();
                    let rel_path = normalize_rel_asset_path(
                        s_obj
                            .get("path")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default(),
                    );
                    if let Some(snip_bytes) = entries.get(&rel_path) {
                        if let Ok(snip_json) = parse_jsonc(&String::from_utf8_lossy(snip_bytes)) {
                            if let Some(snip_map) = snip_json.as_object() {
                                for (snip_name, snip_def) in snip_map {
                                    if let Some(def_obj) = snip_def.as_object() {
                                        let prefix = def_obj
                                            .get("prefix")
                                            .and_then(|p| {
                                                p.as_str().map(str::to_string).or_else(|| {
                                                    p.as_array()
                                                        .and_then(|a| a.first())
                                                        .and_then(|v| v.as_str())
                                                        .map(str::to_string)
                                                })
                                            })
                                            .unwrap_or_default();
                                        let body = match def_obj.get("body") {
                                            Some(serde_json::Value::String(s)) => {
                                                vec![s.clone()]
                                            }
                                            Some(serde_json::Value::Array(arr)) => arr
                                                .iter()
                                                .filter_map(|v| v.as_str().map(str::to_string))
                                                .collect(),
                                            _ => Vec::new(),
                                        };
                                        let description = def_obj
                                            .get("description")
                                            .and_then(|v| v.as_str())
                                            .map(str::to_string);
                                        if !prefix.is_empty() && !body.is_empty() {
                                            snippets.push(VsixSnippetContribution {
                                                language: language.clone(),
                                                name: snip_name.clone(),
                                                prefix,
                                                body,
                                                description,
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // 4. Keybindings
        if let Some(kb_val) = contributes.get("keybindings") {
            if let Ok(kb_str) = serde_json::to_string(kb_val) {
                if let Ok(parsed_kbs) = parse_keybindings_jsonc(&kb_str) {
                    keybindings.extend(parsed_kbs);
                }
            }
        }

        // 5. Languages
        if let Some(lang_arr) = contributes.get("languages").and_then(|v| v.as_array()) {
            for lang in lang_arr {
                if let Some(id) = lang
                    .as_object()
                    .and_then(|o| o.get("id"))
                    .and_then(|v| v.as_str())
                {
                    languages.push(id.to_string());
                }
            }
        }
    }

    Ok(LoadedDeclarativeVsix {
        extension_id: format!("{publisher}.{name}"),
        name,
        publisher,
        version,
        display_name,
        themes,
        icon_themes,
        snippets,
        keybindings,
        languages,
        imperative_entrypoint_quarantined,
        executed_js_entrypoints: 0,
    })
}
