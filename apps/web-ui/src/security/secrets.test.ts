import { describe, expect, it } from "vitest";
import {
  REDACTED_SECRET_TOKEN,
  isSecretBearingPath,
  isSensitiveEnvEntry,
  redactSecretsInLine,
} from "./secrets.js";

describe("security/secrets", () => {
  it("redacts every known token shape in a line and counts them", () => {
    const { sanitized, redactedCount } = redactSecretsInLine(
      "key=sk-abcdefghijklmnop gh=ghp_ABCDEFGHIJKLMNOP aws=AKIAABCDEFGHIJKLMN",
    );
    expect(redactedCount).toBe(3);
    expect(sanitized).toBe(
      `key=${REDACTED_SECRET_TOKEN} gh=${REDACTED_SECRET_TOKEN} aws=${REDACTED_SECRET_TOKEN}`,
    );
    expect(redactSecretsInLine("const sk = 1;").redactedCount).toBe(0);
  });

  it("excludes env files, keys and certificates but keeps .env.example searchable", () => {
    expect(isSecretBearingPath(".env")).toBe(true);
    expect(isSecretBearingPath("apps\\api\\.env.local")).toBe(true);
    expect(isSecretBearingPath("certs/server.pem")).toBe(true);
    expect(isSecretBearingPath(".env.example")).toBe(false);
    expect(isSecretBearingPath("src/env.ts")).toBe(false);
  });

  it("flags env entries by name or by value prefix", () => {
    expect(isSensitiveEnvEntry("GITHUB_TOKEN", "abc")).toBe(true);
    expect(isSensitiveEnvEntry("CONFIG", "eyJhbGciOiJIUzI1NiJ9")).toBe(true);
    expect(isSensitiveEnvEntry("LOG_LEVEL", "debug")).toBe(false);
  });
});
