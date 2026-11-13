//! Automated TypeScript binding generator for `packages/protocol-types`.

use super::*;

// ============================================================================
// 12. Automated TypeScript Binding Generator (`packages/protocol-types`)
// ============================================================================

/// Format a `ts-rs` declaration into Biome-compliant TypeScript (`export type ...`).
fn format_ts_decl(raw_decl: &str) -> String {
    let normalized = raw_decl.trim();
    let exported = if normalized.starts_with("export ") {
        normalized.to_string()
    } else {
        format!("export {normalized}")
    };

    // Format single-line `{ a: T, b: U, }` struct declarations from `ts-rs` into
    // multi-line 2-space indented Biome-compliant declarations.
    if !exported.contains(" } | { ") {
        if let Some((prefix, rest)) = exported.split_once(" = { ") {
            if let Some(fields_str) = rest.strip_suffix(" };") {
                let fields: Vec<&str> = fields_str
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .collect();
                let mut out = format!("{prefix} = {{\n");
                for field in fields {
                    out.push_str("  ");
                    out.push_str(field);
                    out.push_str(";\n");
                }
                out.push_str("};");
                return out;
            }
        }
    }

    // Format union declarations that contain inline object variants or exceed 100 chars.
    if let Some((prefix, rest)) = exported.split_once(" = ") {
        if let Some(body) = rest.strip_suffix(';') {
            if body.contains(" | ") && (exported.len() > 100 || body.contains("{ ")) {
                let variants: Vec<&str> = body.split(" | ").map(str::trim).collect();
                let mut out = format!("{prefix} =\n");
                for (idx, variant) in variants.iter().enumerate() {
                    let formatted_variant = format_inline_object_variant(variant);
                    out.push_str("  | ");
                    out.push_str(&formatted_variant);
                    if idx + 1 == variants.len() {
                        out.push(';');
                    }
                    out.push('\n');
                }
                return out.trim_end().to_string();
            }
        }
    }

    exported
}

fn format_inline_object_variant(variant: &str) -> String {
    if let Some(inner) = variant
        .strip_prefix("{ ")
        .and_then(|s| s.strip_suffix(" }"))
    {
        if let Some((tag_raw, obj)) = inner.split_once(": { ") {
            let tag = tag_raw.trim_matches('"');
            if let Some(fields_raw) = obj.strip_suffix(" }") {
                let fields: Vec<&str> = fields_raw
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .collect();
                if fields.len() == 1 && variant.len() <= 75 {
                    return format!("{{ {tag}: {{ {} }} }}", fields[0]);
                }
                let mut out = format!("{{\n      {tag}: {{\n");
                for field in fields {
                    out.push_str("        ");
                    out.push_str(field);
                    out.push_str(";\n");
                }
                out.push_str("      };\n    }");
                return out;
            }
        } else if let Some((tag_raw, val)) = inner.split_once(": ") {
            let tag = tag_raw.trim_matches('"');
            return format!("{{ {tag}: {val} }}");
        }
    }
    variant.to_string()
}

/// Generates the complete, deterministic TypeScript module for `@coloride/protocol-types`.
#[must_use]
pub fn generate_typescript_bindings() -> String {
    let declarations = [
        Utf8ByteOffset::decl(),
        Utf16CodeUnitOffset::decl(),
        LineCol::decl(),
        Utf8Span::decl(),
        Utf16Span::decl(),
        ColorideValidationState::decl(),
        TaskState::decl(),
        TransactionOrigin::decl(),
        TextChange::decl(),
        EditorSelection::decl(),
        EditorTransaction::decl(),
        EditorSnapshot::decl(),
        TargetEnvironment::decl(),
        AutonomyLevel::decl(),
        ExecutionPolicy::decl(),
        BudgetLimits::decl(),
        TaskSpec::decl(),
        ConfidenceLevel::decl(),
        ExcerptFreshness::decl(),
        DataClassification::decl(),
        AuthorizedDestination::decl(),
        ContextExcerpt::decl(),
        ContextBundle::decl(),
        ModelProviderKind::decl(),
        ModelCapabilities::decl(),
        ModelUsageMetrics::decl(),
        ModelProvider::decl(),
        ToolArgValue::decl(),
        ToolCapability::decl(),
        ToolPrecondition::decl(),
        ToolCall::decl(),
        ChangeOperation::decl(),
        ChangeSet::decl(),
        ExecutedCommandRecord::decl(),
        DiagnosticSeverity::decl(),
        DiagnosticSource::decl(),
        DiagnosticEntry::decl(),
        DocumentDiagnostics::decl(),
        QualityDiagnosticsSummary::decl(),
        PreviewRuntimeReport::decl(),
        EvidenceArtifact::decl(),
        Evidence::decl(),
        ApprovalActionKind::decl(),
        Approval::decl(),
    ];

    let mut output = String::from(
        "// AUTO-GENERATED FILE — DO NOT EDIT MANUALLY.\n\
         // Source of truth: crates/host-core/src/contracts.rs (LOT-002)\n\
         // Regenerate with: cargo test --package host-core export_bindings\n\n\
         export const CONTRACT_SCHEMA_VERSION = 1 as const;\n\n",
    );

    for (idx, decl) in declarations.iter().enumerate() {
        output.push_str(&format_ts_decl(decl));
        output.push('\n');
        if idx + 1 < declarations.len() {
            output.push('\n');
        }
    }

    output
}

/// Resolves the path to `packages/protocol-types/src/generated.ts` from `crates/host-core`.
#[must_use]
pub fn default_generated_ts_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("packages")
        .join("protocol-types")
        .join("src")
        .join("generated.ts")
}

/// Writes the generated TypeScript bindings to `target_path`, preserving the file's existing
/// line ending style (`\r\n` vs `\n`) if already present on disk so `git diff --exit-code`
/// remains clean across Windows, macOS, and Linux checkouts.
pub fn write_typescript_bindings(target_path: &Path) -> Result<String, ContractCodecError> {
    let canonical_lf = generate_typescript_bindings();
    let existing = std::fs::read_to_string(target_path).ok();
    let desired = match &existing {
        Some(content) if content.contains("\r\n") => canonical_lf.replace('\n', "\r\n"),
        _ => canonical_lf.clone(),
    };

    if existing.as_deref() != Some(desired.as_str()) {
        std::fs::write(target_path, desired.as_bytes())?;
    }

    Ok(canonical_lf)
}
