/**
 * Secret detection shared by every UI surface that shows workspace or config content
 * (workspace search excerpts, imported MCP server environments).
 */

/** Placeholder shown instead of an imported environment value that looks sensitive. */
export const REDACTED_ENV_VALUE = "•••••••• [REDACTED]";

/** Placeholder written over a token found inside a line of text. */
export const REDACTED_SECRET_TOKEN = "[REDACTED_SECRET]";

/** Well-known token shapes (OpenAI-style keys, GitHub PATs, AWS access keys, Slack tokens). */
const SECRET_TOKEN_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bghp_[A-Za-z0-9]{12,}\b/g,
  /\bAKIA[0-9A-Z]{12,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
];

/** Environment variable names that usually carry credentials. */
const SENSITIVE_ENV_KEY_MARKERS: readonly string[] = [
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

/** Value prefixes that identify a credential even under an innocent-looking name (JWTs start with `eyJ`). */
const SENSITIVE_VALUE_PREFIXES: readonly string[] = ["sk-", "ghp_", "xoxb-", "eyJ"];

/** Files whose content is never searched or excerpted (`.env*` except `.env.example`, keys, certificates). */
export function isSecretBearingPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const base = normalized.split("/").pop() ?? normalized;
  return (
    base === ".env" ||
    (base.startsWith(".env.") && base !== ".env.example") ||
    base.endsWith(".pem") ||
    base.endsWith(".key")
  );
}

/** Replaces every known token shape in `line` and reports how many were hidden. */
export function redactSecretsInLine(line: string): {
  readonly sanitized: string;
  readonly redactedCount: number;
} {
  let sanitized = line;
  let redactedCount = 0;
  for (const regex of SECRET_TOKEN_PATTERNS) {
    sanitized = sanitized.replace(regex, () => {
      redactedCount += 1;
      return REDACTED_SECRET_TOKEN;
    });
  }
  return { sanitized, redactedCount };
}

/** True when an environment entry must be redacted, judging by its name or by its value. */
export function isSensitiveEnvEntry(key: string, value: string): boolean {
  const upper = key.toUpperCase();
  if (SENSITIVE_ENV_KEY_MARKERS.some((marker) => upper.includes(marker))) {
    return true;
  }
  const trimmed = value.trim();
  return SENSITIVE_VALUE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}
