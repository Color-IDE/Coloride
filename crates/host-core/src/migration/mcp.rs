//! Imported MCP servers: always quarantined, secrets redacted, dangerous launch commands flagged (`LOT-006`).

use super::*;

/// Quarantine state for imported MCP servers (`LOT-006`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum McpQuarantineStatus {
    /// Locked on import: `enabled = false`, `approval_required = true`, `0` processes spawned.
    PendingApproval,
    /// Explicitly approved by the user after inspecting command, args, and scopes.
    ApprovedByUser,
    /// Explicitly rejected by the user.
    RejectedByUser,
}

/// Quarantined MCP server declaration extracted from `claude_desktop_config.json` or Cursor `mcp.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuarantinedMcpServer {
    pub server_name: String,
    pub command: String,
    pub args: Vec<String>,
    /// Sensitive values are replaced with `REDACTED_ENV_VALUE` for safe UI display.
    pub redacted_env: BTreeMap<String, String>,
    pub status: McpQuarantineStatus,
    pub enabled: bool,
    pub approval_required: bool,
    pub action_digest: String,
    pub security_warnings: Vec<String>,
}

fn is_sensitive_env_key_or_value(key: &str, value: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    let sensitive_markers = [
        "KEY",
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "CREDENTIAL",
        "AUTH",
        "PRIVATE",
        "BEARER",
        "COOKIE",
        "SESSION",
    ];
    if sensitive_markers.iter().any(|m| upper.contains(m)) {
        return true;
    }
    let val_trimmed = value.trim();
    val_trimmed.starts_with("sk-")
        || val_trimmed.starts_with("ghp_")
        || val_trimmed.starts_with("xoxb-")
        || val_trimmed.starts_with("eyJ")
}

fn detect_dangerous_command_patterns(command: &str, args: &[String]) -> Vec<String> {
    let mut warnings = Vec::new();
    let full_cmd = if args.is_empty() {
        command.to_string()
    } else {
        format!("{command} {}", args.join(" "))
    };
    let lower = full_cmd.to_ascii_lowercase();

    if (lower.contains("curl ") || lower.contains("wget "))
        && (lower.contains("| sh")
            || lower.contains("| bash")
            || lower.contains("|sh")
            || lower.contains("|bash")
            || lower.contains("| zsh"))
    {
        warnings.push(
            "CRITICAL: Remote shell pipe execution detected (`curl/wget | sh`). Quarantined."
                .to_string(),
        );
    }
    if lower.contains("sudo ") || lower.contains("chmod +s") || lower.contains("chown root") {
        warnings.push("Privilege escalation command detected (`sudo`/`root`). Quarantined.".into());
    }
    if lower.contains("nc -e") || lower.contains("/dev/tcp/") || lower.contains("mkfifo") {
        warnings.push("Reverse shell pattern detected. Quarantined.".into());
    }
    if lower.starts_with("sh ")
        || lower.starts_with("bash ")
        || lower.starts_with("/bin/sh")
        || lower.starts_with("/bin/bash")
        || lower.starts_with("powershell")
        || lower.starts_with("cmd.exe")
    {
        warnings
            .push("Direct shell interpreter invocation requires explicit scope inspection.".into());
    }
    warnings
}

/// Parse `claude_desktop_config.json` or Cursor `mcp.json` (JSONC) into quarantined MCP servers.
/// Never spawns any child process (`0` processes launched) and marks all servers `PendingApproval`.
pub fn parse_mcp_config_jsonc(input: &str) -> Result<Vec<QuarantinedMcpServer>, MigrationError> {
    let val = parse_jsonc(input)?;
    let obj = val.as_object().ok_or_else(|| {
        MigrationError::JsoncSyntax("MCP config root must be a JSON object".into())
    })?;

    let Some(servers_obj) = obj.get("mcpServers").and_then(|v| v.as_object()) else {
        return Ok(Vec::new());
    };

    let mut servers = Vec::with_capacity(servers_obj.len());
    for (server_name, spec) in servers_obj {
        let Some(spec_obj) = spec.as_object() else {
            continue;
        };
        let command = spec_obj
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        if command.is_empty() {
            continue;
        }

        let args: Vec<String> = spec_obj
            .get("args")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();

        let mut redacted_env = BTreeMap::new();
        if let Some(env_obj) = spec_obj.get("env").and_then(|v| v.as_object()) {
            for (k, v) in env_obj {
                let raw_val = v.as_str().unwrap_or_default();
                let safe_val = if is_sensitive_env_key_or_value(k, raw_val) {
                    REDACTED_ENV_VALUE.to_string()
                } else {
                    raw_val.to_string()
                };
                redacted_env.insert(k.clone(), safe_val);
            }
        }

        let mut hasher = blake3::Hasher::new();
        hasher.update(server_name.as_bytes());
        hasher.update(b"::");
        hasher.update(command.as_bytes());
        for arg in &args {
            hasher.update(b"::");
            hasher.update(arg.as_bytes());
        }
        let action_digest = hasher.finalize().to_hex().to_string();
        let security_warnings = detect_dangerous_command_patterns(&command, &args);

        servers.push(QuarantinedMcpServer {
            server_name: server_name.clone(),
            command,
            args,
            redacted_env,
            status: McpQuarantineStatus::PendingApproval,
            enabled: false,
            approval_required: true,
            action_digest,
            security_warnings,
        });
    }

    Ok(servers)
}
