//! Contract #8: `Evidence` (diagnostics, previews, executed commands).

use super::*;

// ============================================================================
// 10. Contract #8 — Evidence
// ============================================================================

/// Record of a command executed inside the isolated sandbox during verification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ExecutedCommandRecord {
    pub command: String,
    pub args: Vec<String>,
    pub exit_code: i32,
    pub duration_ms: u32,
    pub impacted_tests_only: bool,
}

/// Severity of a diagnostic reported by `vtsls`, Biome, or runtime checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Information,
}

/// Tool or subsystem that emitted a diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum DiagnosticSource {
    Vtsls,
    Biome,
    Compiler,
    TestRunner,
    PreviewRuntime,
}

/// Structured diagnostic entry anchored on explicit UTF-16 spans for CodeMirror 6 projection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct DiagnosticEntry {
    pub file_path: String,
    pub span_utf16: Utf16Span,
    pub line_col: LineCol,
    pub source: DiagnosticSource,
    pub severity: DiagnosticSeverity,
    pub code: String,
    pub message: String,
}

/// Aggregated `vtsls` and Biome diagnostics for an `Evidence` bundle.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub struct QualityDiagnosticsSummary {
    pub vtsls_error_count: u32,
    pub vtsls_warning_count: u32,
    pub biome_error_count: u32,
    pub biome_warning_count: u32,
    pub items: Vec<DiagnosticEntry>,
}

/// Runtime report captured by the isolated `Preview Service` (Browser Loop).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct PreviewRuntimeReport {
    pub inspected_url: String,
    pub console_error_count: u32,
    pub uncaught_exception_count: u32,
    pub failed_network_request_count: u32,
    pub crashed: bool,
    pub dom_snapshot_hash: Option<String>,
}

/// Verifiable artifact produced during sandbox validation (coverage, logs, screenshots, trace).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct EvidenceArtifact {
    pub name: String,
    pub kind: String,
    pub digest_blake3: String,
    pub byte_size: u32,
}

/// Contract #8: Cryptographically bound verification proof determining the Coloride state (`🟢/🟡/🔴`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Evidence {
    pub schema_version: u16,
    pub evidence_id: String,
    pub task_id: String,
    pub tested_snapshot_hash: String,
    pub checkpoint_ref: String,
    pub commands: Vec<ExecutedCommandRecord>,
    pub diagnostics: QualityDiagnosticsSummary,
    pub preview_report: PreviewRuntimeReport,
    pub artifacts: Vec<EvidenceArtifact>,
    pub verdict: ColorideValidationState,
}

impl Evidence {
    /// Enforces Invariant #4: `ValidatedGreen` (`🟢 ✓ Validated`) requires a matching
    /// `content_blake3_hash`, all executed commands succeeding (`exit_code == 0`),
    /// 0 `vtsls`/Biome errors, and 0 `Preview Service` crashes or `console.error`.
    #[must_use]
    pub fn satisfies_validated_green(&self, current_content_blake3_hash: &str) -> bool {
        !current_content_blake3_hash.is_empty()
            && self.tested_snapshot_hash == current_content_blake3_hash
            && !self.commands.is_empty()
            && self.commands.iter().all(|cmd| cmd.exit_code == 0)
            && self.diagnostics.vtsls_error_count == 0
            && self.diagnostics.biome_error_count == 0
            && !self.preview_report.crashed
            && self.preview_report.console_error_count == 0
            && self.preview_report.uncaught_exception_count == 0
            && self.verdict == ColorideValidationState::ValidatedGreen
    }
}
