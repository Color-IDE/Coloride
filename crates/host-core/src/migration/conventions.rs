//! Project convention files (`.cursorrules`, `CLAUDE.md`, `AGENTS.md`): untrusted text, never policy (`LOT-006`).

use super::*;

/// Provenance tag attached to imported `.cursorrules`, `CLAUDE.md`, and `AGENTS.md` files (`LOT-006`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ConventionProvenance {
    /// Untrusted project text convention: can NEVER alter `PolicyEngine` rules or execution permissions.
    UntrustedProjectConvention,
}

/// Imported project convention file (`.cursorrules`, `CLAUDE.md`, `AGENTS.md`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportedProjectConvention {
    pub file_name: String,
    pub relative_path: String,
    pub provenance: ConventionProvenance,
    pub content: String,
    pub content_blake3_hash: String,
    /// Strictly `false`: project convention text can never modify `PolicyEngine` security rules.
    pub can_modify_policy_engine: bool,
    /// Strictly `0`: number of execution permissions changed by importing this file.
    pub security_permissions_changed: u32,
    /// Suspicious prompt-injection or privilege-escalation directives flagged during import.
    pub flagged_injection_directives: Vec<String>,
}

fn scan_convention_for_privilege_escalation(content: &str) -> Vec<String> {
    let mut flagged = Vec::new();
    for (idx, line) in content.lines().enumerate() {
        let lower = line.to_ascii_lowercase();
        let suspicious = lower.contains("allow_unsandboxed")
            || lower.contains("disable_sandbox")
            || lower.contains("bypass_policy")
            || lower.contains("override policy")
            || lower.contains("policy_engine")
            || lower.contains("auto_approve_all")
            || lower.contains("chmod 777")
            || (lower.contains("curl ") && lower.contains("| sh"))
            || (lower.contains("wget ") && lower.contains("| sh"))
            || lower.contains("sudo ");
        if suspicious {
            flagged.push(format!("line {}: {}", idx + 1, line.trim()));
        }
    }
    flagged
}

/// Inspect and import a `.cursorrules`, `CLAUDE.md`, or `AGENTS.md` file with `UntrustedProjectConvention` provenance.
#[must_use]
pub fn import_project_convention_text(
    file_name: &str,
    relative_path: &str,
    content: &str,
) -> ImportedProjectConvention {
    let content_blake3_hash = blake3::hash(content.as_bytes()).to_hex().to_string();
    let flagged_injection_directives = scan_convention_for_privilege_escalation(content);

    ImportedProjectConvention {
        file_name: file_name.to_string(),
        relative_path: relative_path.to_string(),
        provenance: ConventionProvenance::UntrustedProjectConvention,
        content: content.to_string(),
        content_blake3_hash,
        can_modify_policy_engine: false,
        security_permissions_changed: 0,
        flagged_injection_directives,
    }
}

/// Discover and import `.cursorrules`, `CLAUDE.md`, and `AGENTS.md` from a workspace directory.
#[must_use]
pub fn discover_workspace_conventions(workspace_root: &Path) -> Vec<ImportedProjectConvention> {
    let candidates = [".cursorrules", "CLAUDE.md", "AGENTS.md"];
    let mut out = Vec::new();
    for candidate in candidates {
        let path = workspace_root.join(candidate);
        if let Ok(content) = fs::read_to_string(&path) {
            out.push(import_project_convention_text(
                candidate, candidate, &content,
            ));
        }
    }
    out
}
