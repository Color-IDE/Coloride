use std::collections::BTreeMap;
use std::path::Path;

use host_core::{Utf8ByteOffset, Utf8Span};
use serde::{Deserialize, Serialize};

/// Categories of secrets detected and redacted by `AclAndSecretScanner` (`LOT-008`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum SecretRuleKind {
    AwsAccessKeyId,
    GitHubToken,
    AiProviderApiKey,
    SlackOrStripeToken,
    PemPrivateKey,
    DatabaseConnectionUrl,
    GenericSecretAssignment,
    HighEntropySecret,
}

impl SecretRuleKind {
    #[must_use]
    pub const fn redaction_placeholder(self) -> &'static str {
        match self {
            Self::AwsAccessKeyId => "[REDACTED_SECRET:AWS_ACCESS_KEY_ID]",
            Self::GitHubToken => "[REDACTED_SECRET:GITHUB_TOKEN]",
            Self::AiProviderApiKey => "[REDACTED_SECRET:AI_API_KEY]",
            Self::SlackOrStripeToken => "[REDACTED_SECRET:SERVICE_TOKEN]",
            Self::PemPrivateKey => "[REDACTED_SECRET:PEM_PRIVATE_KEY]",
            Self::DatabaseConnectionUrl => "[REDACTED_SECRET:DATABASE_URL_CREDENTIALS]",
            Self::GenericSecretAssignment => "[REDACTED_SECRET:SECRET_ASSIGNMENT]",
            Self::HighEntropySecret => "[REDACTED_SECRET:HIGH_ENTROPY_TOKEN]",
        }
    }
}

/// Reason why a file path was blocked from indexing or export by `AclAndSecretScanner`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AclDenialReason {
    SensitiveFilePattern { matched_rule: String },
    GitignoreRule { pattern: String },
    ColorideignoreRule { pattern: String },
    ExplicitForbiddenPath { pattern: String },
    OutsideAllowedPaths { path: String },
}

/// Audit event emitted when `AclAndSecretScanner` redacts a secret.
/// Stores only a `blake3` fingerprint of the secret, never the plaintext secret itself (`LOT-008`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditSecretRedactionEvent {
    pub file_path: String,
    pub line_number: u32,
    pub rule_kind: SecretRuleKind,
    pub redacted_span_utf8: Utf8Span,
    pub secret_blake3_fingerprint: String,
}

/// Result of running `AclAndSecretScanner::sanitize_text` on a document or excerpt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SanitizedDocument {
    pub sanitized_text: String,
    pub redaction_count: usize,
    pub audit_events: Vec<AuditSecretRedactionEvent>,
}

impl SanitizedDocument {
    #[must_use]
    pub const fn contains_redactions(&self) -> bool {
        self.redaction_count > 0
    }
}

#[derive(Debug, Clone)]
struct IgnoreRule {
    pattern: String,
    negated: bool,
    dir_only: bool,
}

/// Security filter enforced **before SQLite indexing** and **before `ContextBundle` export** (`LOT-008`).
/// Prefix of every placeholder that replaces a secret (`[REDACTED_SECRET:<KIND>]`).
pub const REDACTED_SECRET_MARKER: &str = "[REDACTED_SECRET:";

#[derive(Debug, Clone)]
pub struct AclAndSecretScanner {
    gitignore_rules: Vec<IgnoreRule>,
    colorideignore_rules: Vec<IgnoreRule>,
    allowed_paths: Vec<String>,
    forbidden_paths: Vec<String>,
    entropy_threshold_bits: f64,
    audit_log: Vec<AuditSecretRedactionEvent>,
}

impl Default for AclAndSecretScanner {
    fn default() -> Self {
        Self::new()
    }
}

impl AclAndSecretScanner {
    /// Default Shannon entropy threshold (in bits per character) for candidate secret tokens.
    pub const DEFAULT_ENTROPY_THRESHOLD_BITS: f64 = 4.35;

    #[must_use]
    pub fn new() -> Self {
        Self {
            gitignore_rules: Vec::new(),
            colorideignore_rules: Vec::new(),
            allowed_paths: Vec::new(),
            forbidden_paths: Vec::new(),
            entropy_threshold_bits: Self::DEFAULT_ENTROPY_THRESHOLD_BITS,
            audit_log: Vec::new(),
        }
    }

    /// Load `.gitignore` and `.colorideignore` directly from `workspace_root` if present.
    #[must_use]
    pub fn from_workspace_root(workspace_root: &Path) -> Self {
        let mut scanner = Self::new();
        let gitignore_path = workspace_root.join(".gitignore");
        if let Ok(content) = std::fs::read_to_string(&gitignore_path) {
            scanner.add_gitignore_rules(&content);
        }
        let colorideignore_path = workspace_root.join(".colorideignore");
        if let Ok(content) = std::fs::read_to_string(&colorideignore_path) {
            scanner.add_colorideignore_rules(&content);
        }
        scanner
    }

    /// Add `.gitignore` rules from raw text content.
    pub fn add_gitignore_rules(&mut self, content: &str) {
        Self::parse_ignore_lines(content, &mut self.gitignore_rules);
    }

    /// Add `.colorideignore` rules from raw text content.
    pub fn add_colorideignore_rules(&mut self, content: &str) {
        Self::parse_ignore_lines(content, &mut self.colorideignore_rules);
    }

    /// Configure explicit ACL allowed path prefixes.
    pub fn set_allowed_paths(&mut self, paths: Vec<String>) {
        self.allowed_paths = paths
            .into_iter()
            .map(|p| normalize_rel_path(&p))
            .filter(|p| !p.is_empty())
            .collect();
    }

    /// Configure explicit ACL forbidden path prefixes or patterns.
    pub fn set_forbidden_paths(&mut self, paths: Vec<String>) {
        self.forbidden_paths = paths
            .into_iter()
            .map(|p| normalize_rel_path(&p))
            .filter(|p| !p.is_empty())
            .collect();
    }

    /// Return all audit events recorded so far (never containing plaintext secrets).
    #[must_use]
    pub fn audit_log(&self) -> &[AuditSecretRedactionEvent] {
        &self.audit_log
    }

    /// Clear recorded audit events.
    pub fn clear_audit_log(&mut self) {
        self.audit_log.clear();
    }

    /// Most audit events kept in memory: every indexing pass and every export re-scans text, so
    /// an unbounded log would grow for the whole session. The oldest half goes when it is full.
    pub const MAX_AUDIT_EVENTS: usize = 10_000;

    fn record_audit_event(&mut self, event: AuditSecretRedactionEvent) {
        if self.audit_log.len() >= Self::MAX_AUDIT_EVENTS {
            self.audit_log.drain(..Self::MAX_AUDIT_EVENTS / 2);
        }
        self.audit_log.push(event);
    }

    /// Verify whether a workspace-relative path is permitted by ACL, `.gitignore`, `.colorideignore`,
    /// and mandatory sensitive-file rules (`.env`, `.pem`, `.key`, etc.).
    pub fn check_path_acl(&self, relative_path: &str) -> Result<(), AclDenialReason> {
        let norm = normalize_rel_path(relative_path);
        let file_name = norm.rsplit_once('/').map(|(_, f)| f).unwrap_or(&norm);
        let lower_name = file_name.to_ascii_lowercase();

        // 1. Always-blocked sensitive files (.env, .env.*, private key files, git internals)
        if norm == ".git" || norm.starts_with(".git/") || norm.contains("/.git/") {
            return Err(AclDenialReason::SensitiveFilePattern {
                matched_rule: ".git/**".to_string(),
            });
        }

        if is_sensitive_env_or_key_filename(&lower_name) {
            return Err(AclDenialReason::SensitiveFilePattern {
                matched_rule: lower_name,
            });
        }

        // 2. Explicit ACL forbidden paths
        for forbidden in &self.forbidden_paths {
            if path_matches_pattern(&norm, file_name, forbidden, false) {
                return Err(AclDenialReason::ExplicitForbiddenPath {
                    pattern: forbidden.clone(),
                });
            }
        }

        // 3. Explicit ACL allowed paths (when non-empty, path must match at least one allowed prefix/pattern)
        if !self.allowed_paths.is_empty()
            && !self
                .allowed_paths
                .iter()
                .any(|allowed| path_matches_pattern(&norm, file_name, allowed, false))
        {
            return Err(AclDenialReason::OutsideAllowedPaths { path: norm });
        }

        // 4. .gitignore rules
        if let Some(matched_pattern) =
            Self::evaluate_ignore_rules(&norm, file_name, &self.gitignore_rules)
        {
            return Err(AclDenialReason::GitignoreRule {
                pattern: matched_pattern,
            });
        }

        // 5. .colorideignore rules
        if let Some(matched_pattern) =
            Self::evaluate_ignore_rules(&norm, file_name, &self.colorideignore_rules)
        {
            return Err(AclDenialReason::ColorideignoreRule {
                pattern: matched_pattern,
            });
        }

        Ok(())
    }

    /// Scan and redact all secrets from `text` before SQLite indexing or before `ContextBundle` export.
    /// Records an `AuditSecretRedactionEvent` (with a `blake3` fingerprint, never the secret) for every redaction.
    pub fn sanitize_text(&mut self, relative_path: &str, text: &str) -> SanitizedDocument {
        let norm_path = normalize_rel_path(relative_path);
        let skip_raw_entropy = is_standard_lockfile(&norm_path);

        let mut sanitized_lines = Vec::new();
        let mut events = Vec::new();
        let mut inside_pem_private_key = false;
        let mut pem_start_byte: u32 = 0;
        let mut pem_start_line: u32 = 1;
        let mut pem_accumulator = String::new();
        let mut current_byte_offset: u32 = 0;

        for (idx, raw_line) in text.split_inclusive('\n').enumerate() {
            let line_number = (idx + 1) as u32;
            let line_byte_len = raw_line.len() as u32;
            let (line_body, line_ending) = if let Some(stripped) = raw_line.strip_suffix("\r\n") {
                (stripped, "\r\n")
            } else if let Some(stripped) = raw_line.strip_suffix('\n') {
                (stripped, "\n")
            } else {
                (raw_line, "")
            };

            if inside_pem_private_key {
                pem_accumulator.push_str(raw_line);
                if line_body.contains("-----END ") && line_body.contains("PRIVATE KEY-----") {
                    inside_pem_private_key = false;
                    let span = Utf8Span::new(
                        Utf8ByteOffset::new(pem_start_byte),
                        Utf8ByteOffset::new(current_byte_offset + line_byte_len),
                    );
                    let fingerprint = blake3::hash(pem_accumulator.as_bytes())
                        .to_hex()
                        .to_string();
                    let event = AuditSecretRedactionEvent {
                        file_path: norm_path.clone(),
                        line_number: pem_start_line,
                        rule_kind: SecretRuleKind::PemPrivateKey,
                        redacted_span_utf8: span,
                        secret_blake3_fingerprint: fingerprint,
                    };
                    self.record_audit_event(event.clone());
                    events.push(event);
                    pem_accumulator.clear();
                    sanitized_lines.push(format!(
                        "{}{line_ending}",
                        SecretRuleKind::PemPrivateKey.redaction_placeholder()
                    ));
                }
                current_byte_offset += line_byte_len;
                continue;
            }

            if line_body.contains("-----BEGIN ") && line_body.contains("PRIVATE KEY-----") {
                if line_body.contains("-----END ") && line_body.contains("PRIVATE KEY-----") {
                    let span = Utf8Span::new(
                        Utf8ByteOffset::new(current_byte_offset),
                        Utf8ByteOffset::new(current_byte_offset + line_body.len() as u32),
                    );
                    let fingerprint = blake3::hash(line_body.as_bytes()).to_hex().to_string();
                    let event = AuditSecretRedactionEvent {
                        file_path: norm_path.clone(),
                        line_number,
                        rule_kind: SecretRuleKind::PemPrivateKey,
                        redacted_span_utf8: span,
                        secret_blake3_fingerprint: fingerprint,
                    };
                    self.record_audit_event(event.clone());
                    events.push(event);
                    sanitized_lines.push(format!(
                        "{}{line_ending}",
                        SecretRuleKind::PemPrivateKey.redaction_placeholder()
                    ));
                } else {
                    inside_pem_private_key = true;
                    pem_start_byte = current_byte_offset;
                    pem_start_line = line_number;
                    pem_accumulator.clear();
                    pem_accumulator.push_str(raw_line);
                }
                current_byte_offset += line_byte_len;
                continue;
            }

            let (redacted_line, line_events) = self.sanitize_single_line(
                &norm_path,
                line_body,
                line_number,
                current_byte_offset,
                skip_raw_entropy,
            );
            for ev in line_events {
                self.record_audit_event(ev.clone());
                events.push(ev);
            }
            sanitized_lines.push(format!("{redacted_line}{line_ending}"));
            current_byte_offset += line_byte_len;
        }

        // Handle unclosed PEM block at EOF
        if inside_pem_private_key {
            let span = Utf8Span::new(
                Utf8ByteOffset::new(pem_start_byte),
                Utf8ByteOffset::new(current_byte_offset),
            );
            let fingerprint = blake3::hash(pem_accumulator.as_bytes())
                .to_hex()
                .to_string();
            let event = AuditSecretRedactionEvent {
                file_path: norm_path,
                line_number: pem_start_line,
                rule_kind: SecretRuleKind::PemPrivateKey,
                redacted_span_utf8: span,
                secret_blake3_fingerprint: fingerprint,
            };
            self.record_audit_event(event.clone());
            events.push(event);
            sanitized_lines.push(
                SecretRuleKind::PemPrivateKey
                    .redaction_placeholder()
                    .to_string(),
            );
        }

        SanitizedDocument {
            sanitized_text: sanitized_lines.concat(),
            redaction_count: events.len(),
            audit_events: events,
        }
    }

    /// Check whether `text` is completely free of unredacted secrets (`true` if clean).
    #[must_use]
    pub fn is_clean_of_secrets(&self, relative_path: &str, text: &str) -> bool {
        let mut probe = self.clone();
        let result = probe.sanitize_text(relative_path, text);
        result.redaction_count == 0
    }

    fn sanitize_single_line(
        &self,
        file_path: &str,
        line: &str,
        line_number: u32,
        line_start_byte: u32,
        skip_raw_entropy: bool,
    ) -> (String, Vec<AuditSecretRedactionEvent>) {
        let mut events = Vec::new();
        let mut current = line.to_string();

        // 1. Database connection URLs with credentials (e.g. postgres://user:pass@host/db)
        while let Some((start, end)) = find_database_url_with_credentials(&current) {
            let matched = &current[start..end];
            events.push(AuditSecretRedactionEvent {
                file_path: file_path.to_string(),
                line_number,
                rule_kind: SecretRuleKind::DatabaseConnectionUrl,
                redacted_span_utf8: Utf8Span::new(
                    Utf8ByteOffset::new(line_start_byte + start as u32),
                    Utf8ByteOffset::new(line_start_byte + end as u32),
                ),
                secret_blake3_fingerprint: blake3::hash(matched.as_bytes()).to_hex().to_string(),
            });
            current.replace_range(
                start..end,
                SecretRuleKind::DatabaseConnectionUrl.redaction_placeholder(),
            );
        }

        // 2. Exact token patterns (AWS AKIA/ASIA, GitHub ghp_/github_pat_, OpenAI/Anthropic sk-, Slack/Stripe)
        loop {
            let mut found_match: Option<(usize, usize, SecretRuleKind)> = None;
            for (start, end, token) in iterate_candidate_tokens(&current) {
                if token.starts_with("REDACTED_SECRET") {
                    continue;
                }
                if let Some(rule) = classify_exact_secret_token(token) {
                    found_match = Some((start, end, rule));
                    break;
                }
            }
            if let Some((start, end, rule)) = found_match {
                let matched = &current[start..end];
                events.push(AuditSecretRedactionEvent {
                    file_path: file_path.to_string(),
                    line_number,
                    rule_kind: rule,
                    redacted_span_utf8: Utf8Span::new(
                        Utf8ByteOffset::new(line_start_byte + start as u32),
                        Utf8ByteOffset::new(line_start_byte + end as u32),
                    ),
                    secret_blake3_fingerprint: blake3::hash(matched.as_bytes())
                        .to_hex()
                        .to_string(),
                });
                current.replace_range(start..end, rule.redaction_placeholder());
            } else {
                break;
            }
        }

        // 3. Generic secret assignment (e.g., API_KEY = "my_super_secret_value_12345")
        if let Some((val_start, val_end)) = find_secret_assignment_literal(&current) {
            let matched = &current[val_start..val_end];
            if !matched.contains("[REDACTED_SECRET:") {
                events.push(AuditSecretRedactionEvent {
                    file_path: file_path.to_string(),
                    line_number,
                    rule_kind: SecretRuleKind::GenericSecretAssignment,
                    redacted_span_utf8: Utf8Span::new(
                        Utf8ByteOffset::new(line_start_byte + val_start as u32),
                        Utf8ByteOffset::new(line_start_byte + val_end as u32),
                    ),
                    secret_blake3_fingerprint: blake3::hash(matched.as_bytes())
                        .to_hex()
                        .to_string(),
                });
                current.replace_range(
                    val_start..val_end,
                    SecretRuleKind::GenericSecretAssignment.redaction_placeholder(),
                );
            }
        }

        // 4. High-entropy string literals (skipped on standard lockfiles per LOT-008 Section 4.8)
        if !skip_raw_entropy {
            loop {
                let mut found_entropy: Option<(usize, usize)> = None;
                for (start, end, literal) in iterate_quoted_literals(&current) {
                    if literal.contains("[REDACTED_SECRET:") {
                        continue;
                    }
                    if is_high_entropy_secret_literal(literal, self.entropy_threshold_bits) {
                        found_entropy = Some((start, end));
                        break;
                    }
                }
                if let Some((start, end)) = found_entropy {
                    let matched = &current[start..end];
                    events.push(AuditSecretRedactionEvent {
                        file_path: file_path.to_string(),
                        line_number,
                        rule_kind: SecretRuleKind::HighEntropySecret,
                        redacted_span_utf8: Utf8Span::new(
                            Utf8ByteOffset::new(line_start_byte + start as u32),
                            Utf8ByteOffset::new(line_start_byte + end as u32),
                        ),
                        secret_blake3_fingerprint: blake3::hash(matched.as_bytes())
                            .to_hex()
                            .to_string(),
                    });
                    current.replace_range(
                        start..end,
                        SecretRuleKind::HighEntropySecret.redaction_placeholder(),
                    );
                } else {
                    break;
                }
            }
        }

        (current, events)
    }

    fn parse_ignore_lines(content: &str, out: &mut Vec<IgnoreRule>) {
        for raw_line in content.lines() {
            let trimmed = raw_line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let (negated, rest) = if let Some(stripped) = trimmed.strip_prefix('!') {
                (true, stripped.trim())
            } else {
                (false, trimmed)
            };
            let dir_only = rest.ends_with('/');
            let normalized = normalize_rel_path(rest.trim_matches('/'));
            if !normalized.is_empty() {
                out.push(IgnoreRule {
                    pattern: normalized,
                    negated,
                    dir_only,
                });
            }
        }
    }

    fn evaluate_ignore_rules(
        norm_path: &str,
        file_name: &str,
        rules: &[IgnoreRule],
    ) -> Option<String> {
        let mut ignored_by: Option<String> = None;
        for rule in rules {
            if path_matches_pattern(norm_path, file_name, &rule.pattern, rule.dir_only) {
                if rule.negated {
                    ignored_by = None;
                } else {
                    ignored_by = Some(rule.pattern.clone());
                }
            }
        }
        ignored_by
    }
}

/// Normalize a workspace-relative path to forward slashes without leading `./` or `/`.
#[must_use]
pub fn normalize_rel_path(path: &str) -> String {
    let unified = path.replace('\\', "/");
    let mut parts = Vec::new();
    for segment in unified.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            parts.pop();
        } else {
            parts.push(segment);
        }
    }
    parts.join("/")
}

/// Standard lockfiles excluded from raw Shannon entropy heuristics (`LOT-008` Section 4.8).
#[must_use]
pub fn is_standard_lockfile(norm_path: &str) -> bool {
    let file_name = norm_path
        .rsplit_once('/')
        .map(|(_, f)| f)
        .unwrap_or(norm_path);
    matches!(
        file_name,
        "pnpm-lock.yaml"
            | "package-lock.json"
            | "yarn.lock"
            | "Cargo.lock"
            | "bun.lockb"
            | "poetry.lock"
            | "uv.lock"
            | "Gemfile.lock"
            | "composer.lock"
    )
}

fn is_sensitive_env_or_key_filename(lower_name: &str) -> bool {
    if lower_name == ".env" {
        return true;
    }
    if lower_name.starts_with(".env.")
        && !matches!(lower_name, ".env.example" | ".env.sample" | ".env.template")
    {
        return true;
    }
    if lower_name.ends_with(".pem")
        || lower_name.ends_with(".key")
        || lower_name.ends_with(".p12")
        || lower_name.ends_with(".pfx")
        || lower_name == "id_rsa"
        || lower_name == "id_ed25519"
        || lower_name == ".npmrc"
        || lower_name == ".pypirc"
        || lower_name == ".netrc"
    {
        return true;
    }
    false
}

fn path_matches_pattern(norm_path: &str, file_name: &str, pattern: &str, dir_only: bool) -> bool {
    let clean_pat = pattern.trim_end_matches("/**").trim_end_matches("/*");
    if dir_only || pattern.ends_with("/**") || pattern.ends_with("/*") {
        if norm_path == clean_pat || norm_path.starts_with(&format!("{clean_pat}/")) {
            return true;
        }
        for segment in norm_path.split('/') {
            if segment == clean_pat {
                return true;
            }
        }
    }

    if !pattern.contains('/') {
        if wildcard_match(pattern, file_name) {
            return true;
        }
        for segment in norm_path.split('/') {
            if wildcard_match(pattern, segment) {
                return true;
            }
        }
    }

    if norm_path == clean_pat || norm_path.starts_with(&format!("{clean_pat}/")) {
        return true;
    }

    wildcard_match(pattern, norm_path)
}

fn wildcard_match(pattern: &str, text: &str) -> bool {
    if pattern == "*" || pattern == "**" {
        return true;
    }
    let pat_bytes = pattern.as_bytes();
    let txt_bytes = text.as_bytes();
    let mut p = 0usize;
    let mut t = 0usize;
    let mut star_idx: Option<usize> = None;
    let mut match_idx = 0usize;

    while t < txt_bytes.len() {
        if p < pat_bytes.len() && (pat_bytes[p] == b'?' || pat_bytes[p] == txt_bytes[t]) {
            p += 1;
            t += 1;
        } else if p < pat_bytes.len() && pat_bytes[p] == b'*' {
            while p < pat_bytes.len() && pat_bytes[p] == b'*' {
                p += 1;
            }
            star_idx = Some(p);
            match_idx = t;
        } else if let Some(s_idx) = star_idx {
            p = s_idx;
            match_idx += 1;
            t = match_idx;
        } else {
            return false;
        }
    }

    while p < pat_bytes.len() && pat_bytes[p] == b'*' {
        p += 1;
    }
    p == pat_bytes.len()
}

fn iterate_candidate_tokens(line: &str) -> Vec<(usize, usize, &str)> {
    let mut tokens = Vec::new();
    let mut start: Option<usize> = None;
    for (idx, ch) in line.char_indices() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            if start.is_none() {
                start = Some(idx);
            }
        } else if let Some(s) = start.take() {
            tokens.push((s, idx, &line[s..idx]));
        }
    }
    if let Some(s) = start {
        tokens.push((s, line.len(), &line[s..]));
    }
    tokens
}

fn classify_exact_secret_token(token: &str) -> Option<SecretRuleKind> {
    // 1. AWS Access Key ID: AKIA / ASIA + 16 uppercase alphanumeric chars (total length 20)
    if (token.starts_with("AKIA") || token.starts_with("ASIA"))
        && token.len() == 20
        && token[4..]
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
    {
        return Some(SecretRuleKind::AwsAccessKeyId);
    }

    // 2. GitHub personal / OAuth / app / fine-grained tokens
    if (token.starts_with("ghp_")
        || token.starts_with("gho_")
        || token.starts_with("ghu_")
        || token.starts_with("ghs_")
        || token.starts_with("ghr_"))
        && token.len() >= 20
    {
        return Some(SecretRuleKind::GitHubToken);
    }
    if token.starts_with("github_pat_") && token.len() >= 24 {
        return Some(SecretRuleKind::GitHubToken);
    }

    // 3. OpenAI / Anthropic API keys
    if (token.starts_with("sk-ant-") || token.starts_with("sk-proj-") || token.starts_with("sk-"))
        && token.len() >= 24
    {
        return Some(SecretRuleKind::AiProviderApiKey);
    }

    // 4. Slack / Stripe live tokens
    if (token.starts_with("xoxb-")
        || token.starts_with("xoxp-")
        || token.starts_with("xoxa-")
        || token.starts_with("xoxr-")
        || token.starts_with("xoxs-")
        || token.starts_with("sk_live_")
        || token.starts_with("rk_live_"))
        && token.len() >= 20
    {
        return Some(SecretRuleKind::SlackOrStripeToken);
    }

    None
}

fn find_database_url_with_credentials(line: &str) -> Option<(usize, usize)> {
    const SCHEMES: [&str; 6] = [
        "postgres://",
        "postgresql://",
        "mysql://",
        "mongodb://",
        "mongodb+srv://",
        "redis://",
    ];
    for scheme in SCHEMES {
        let mut search_from = 0usize;
        while let Some(rel_idx) = line[search_from..].find(scheme) {
            let start = search_from + rel_idx;
            let rest = &line[start..];
            let end_rel = rest
                .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '`' || c == ';')
                .unwrap_or(rest.len());
            let candidate = &rest[..end_rel];
            let after_scheme = &candidate[scheme.len()..];
            if let Some(at_idx) = after_scheme.find('@') {
                let user_pass = &after_scheme[..at_idx];
                if user_pass.contains(':') && !user_pass.contains("[REDACTED_SECRET:") {
                    return Some((start, start + end_rel));
                }
            }
            search_from = start + scheme.len();
        }
    }
    None
}

fn find_secret_assignment_literal(line: &str) -> Option<(usize, usize)> {
    const SECRET_KEYS: [&str; 10] = [
        "api_key",
        "apikey",
        "secret_key",
        "private_key",
        "access_token",
        "auth_token",
        "client_secret",
        "db_password",
        "database_password",
        "aws_secret_access_key",
    ];

    let lower = line.to_ascii_lowercase();
    let has_secret_key = SECRET_KEYS.iter().any(|k| lower.contains(k));
    if !has_secret_key {
        return None;
    }

    for (start, end, literal) in iterate_quoted_literals(line) {
        if literal.len() >= 12
            && !literal.contains(' ')
            && !literal.starts_with("REDACTED")
            && !literal.starts_with("process.env")
            && !literal.starts_with("${")
        {
            return Some((start, end));
        }
    }
    None
}

fn iterate_quoted_literals(line: &str) -> Vec<(usize, usize, &str)> {
    let mut out = Vec::new();
    let bytes = line.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'"' || b == b'\'' {
            let quote = b;
            let content_start = i + 1;
            let mut j = content_start;
            while j < bytes.len() {
                if bytes[j] == b'\\' {
                    j += 2;
                    continue;
                }
                if bytes[j] == quote {
                    out.push((content_start, j, &line[content_start..j]));
                    i = j;
                    break;
                }
                j += 1;
            }
        }
        i += 1;
    }
    out
}

/// Compute Shannon entropy (in bits per character) of a string slice.
#[must_use]
pub fn shannon_entropy_bits(s: &str) -> f64 {
    if s.is_empty() {
        return 0.0;
    }
    let mut counts: BTreeMap<char, usize> = BTreeMap::new();
    let mut total = 0usize;
    for ch in s.chars() {
        *counts.entry(ch).or_insert(0) += 1;
        total += 1;
    }
    let total_f = total as f64;
    let mut entropy = 0.0;
    for &count in counts.values() {
        let p = (count as f64) / total_f;
        entropy -= p * p.log2();
    }
    entropy
}

fn is_high_entropy_secret_literal(literal: &str, threshold_bits: f64) -> bool {
    if literal.len() < 24 || literal.len() > 256 {
        return false;
    }
    // Ignore file paths, URLs, CSS classes, or natural language sentences with spaces
    if literal.contains(' ')
        || literal.starts_with("http://")
        || literal.starts_with("https://")
        || literal.starts_with("./")
        || literal.starts_with("../")
        || literal.starts_with('/')
    {
        return false;
    }

    let has_upper = literal.chars().any(|c| c.is_ascii_uppercase());
    let has_lower = literal.chars().any(|c| c.is_ascii_lowercase());
    let has_digit = literal.chars().any(|c| c.is_ascii_digit());
    if !(has_upper && has_lower && has_digit) {
        return false;
    }

    let valid_token_chars = literal
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '_' | '-'));
    if !valid_token_chars {
        return false;
    }

    shannon_entropy_bits(literal) >= threshold_bits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acl_scanner_blocks_dotenv_gitignore_and_colorideignore() {
        let mut scanner = AclAndSecretScanner::new();
        scanner.add_gitignore_rules("node_modules/\ndist/\n*.log\n");
        scanner.add_colorideignore_rules("secrets/**\ninternal_keys.ts\n");

        assert!(scanner.check_path_acl(".env").is_err());
        assert!(scanner.check_path_acl(".env.local").is_err());
        assert!(scanner.check_path_acl("config/.env.production").is_err());
        assert!(scanner.check_path_acl(".env.example").is_ok());
        assert!(scanner.check_path_acl("certs/server.pem").is_err());
        assert!(scanner.check_path_acl("node_modules/pkg/index.js").is_err());
        assert!(scanner.check_path_acl("secrets/prod/token.json").is_err());
        assert!(scanner.check_path_acl("internal_keys.ts").is_err());
        assert!(scanner.check_path_acl("src/index.ts").is_ok());
    }

    #[test]
    fn secret_scanner_redacts_aws_github_pem_and_db_urls_without_logging_secret() {
        let mut scanner = AclAndSecretScanner::new();
        let aws_key = ["AKIA", "IOSFODNN7EXAMPLE"].concat();
        let gh_token = ["ghp_", "1234567890abcdefghijklmnopqrstuvwxyzABCD"].concat();
        let pem_header = ["-----BEGIN ", "RSA PRIVATE KEY-----"].concat();
        let pem_footer = ["-----END ", "RSA PRIVATE KEY-----"].concat();
        let source = format!(
            "export const AWS = \"{aws_key}\";\n\
             export const GH = \"{gh_token}\";\n\
             export const DB = \"postgres://admin:s3cr3tP4ss@db.internal:5432/prod\";\n\
             {pem_header}\n\
             MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7M\n\
             {pem_footer}\n"
        );

        let sanitized = scanner.sanitize_text("src/config.ts", &source);
        assert_eq!(sanitized.redaction_count, 4);
        assert!(!sanitized.sanitized_text.contains(&aws_key));
        assert!(!sanitized.sanitized_text.contains(&gh_token));
        assert!(!sanitized.sanitized_text.contains("s3cr3tP4ss"));
        assert!(!sanitized.sanitized_text.contains("MIIEowIBAAKCAQEA"));

        // Verify audit log never contains plaintext secrets
        let audit_json = serde_json::to_string(scanner.audit_log()).expect("serialize audit");
        assert!(!audit_json.contains(&aws_key));
        assert!(!audit_json.contains(&gh_token));
        assert!(!audit_json.contains("s3cr3tP4ss"));
    }

    #[test]
    fn lockfiles_exempt_from_raw_entropy_false_positives_but_still_scan_exact_tokens() {
        let mut scanner = AclAndSecretScanner::new();
        let sri_integrity =
            "sha512-9b8R7xK2mN4pQ6vW1yZ3aB5cD7eF9gH1iJ3kL5mN7oP9qR1sT3uV5wX7yZ9aB==";
        let lockfile_line = format!("  integrity: \"{sri_integrity}\"\n");

        let lock_sanitized = scanner.sanitize_text("pnpm-lock.yaml", &lockfile_line);
        assert_eq!(lock_sanitized.redaction_count, 0);
        assert!(lock_sanitized.sanitized_text.contains(sri_integrity));

        // Exact credential in a lockfile is still redacted
        let gh_token = ["ghp_", "1234567890abcdefghijklmnopqrstuvwxyzABCD"].concat();
        let poisoned_lock = format!("  tarball: \"https://{gh_token}@github.com/org/repo.tgz\"\n");
        let poisoned_sanitized = scanner.sanitize_text("pnpm-lock.yaml", &poisoned_lock);
        assert_eq!(poisoned_sanitized.redaction_count, 1);
        assert!(!poisoned_sanitized.sanitized_text.contains(&gh_token));
    }
}
