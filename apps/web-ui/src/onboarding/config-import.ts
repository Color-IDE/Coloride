import {
  type Cm6TranslatedKeybinding,
  DEFAULT_COLORIDE_CM6_THEME,
  type KeymapPresetId,
} from "@coloride/editor-cm6";
import { REDACTED_ENV_VALUE, isSensitiveEnvEntry } from "../security/secrets.js";
import { parseJsonc, parseJsoncObject } from "./jsonc.js";
import { scanConventionInjectionDirectives, scanMcpSecurityWarnings } from "./security-scan.js";
import type { ImportedProjectConventionEntry, QuarantinedMcpServerEntry } from "./types.js";
import { translateVsCodeKeybinding } from "./vsix-import.js";

/**
 * Pure parsers for the configuration files read during 1-click onboarding (`LOT-006`).
 * Each one throws on malformed input; the caller records the file as degraded and moves on.
 */

export interface ImportedEditorSettings {
  readonly colorTheme: string;
  readonly iconTheme: string;
  readonly fontFamily: string;
  readonly fontSizePx: number;
  readonly tabSize: number;
  readonly insertSpaces: boolean;
  /** Set when the settings reveal a Vim user; otherwise the current preset is kept. */
  readonly detectedPreset: KeymapPresetId | null;
}

export function defaultEditorSettings(): ImportedEditorSettings {
  return {
    colorTheme: DEFAULT_COLORIDE_CM6_THEME.label,
    iconTheme: "Coloride Geometric Icons",
    fontFamily: DEFAULT_COLORIDE_CM6_THEME.fontFamily ?? "JetBrains Mono, monospace",
    fontSizePx: DEFAULT_COLORIDE_CM6_THEME.fontSizePx ?? 14,
    tabSize: 2,
    insertSpaces: true,
    detectedPreset: null,
  };
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

/** Reads a VS Code / Cursor `settings.json`; fields it does not set keep the Coloride defaults. */
export function parseVsCodeSettings(settingsJsonc: string): ImportedEditorSettings {
  const parsed = parseJsoncObject(settingsJsonc, "Root settings.json");
  const defaults = defaultEditorSettings();
  const str = (key: string, fallback: string) =>
    typeof parsed[key] === "string" ? (parsed[key] as string).trim() : fallback;
  const num = (key: string) => (typeof parsed[key] === "number" ? (parsed[key] as number) : null);

  const fontSize = num("editor.fontSize");
  const tabSize = num("editor.tabSize");
  return {
    colorTheme: str("workbench.colorTheme", defaults.colorTheme),
    iconTheme: str("workbench.iconTheme", defaults.iconTheme),
    fontFamily: str("editor.fontFamily", defaults.fontFamily),
    fontSizePx: fontSize === null ? defaults.fontSizePx : clamp(fontSize, 8, 64),
    tabSize: tabSize === null ? defaults.tabSize : clamp(tabSize, 1, 16),
    insertSpaces:
      typeof parsed["editor.insertSpaces"] === "boolean"
        ? parsed["editor.insertSpaces"]
        : defaults.insertSpaces,
    detectedPreset:
      parsed["vim.useSystemClipboard"] !== undefined || parsed["vim.hlsearch"] !== undefined
        ? "Vim"
        : null,
  };
}

/** Reads a `keybindings.json` array, skipping malformed entries. */
export function parseVsCodeKeybindings(keybindingsJsonc: string): Cm6TranslatedKeybinding[] {
  const parsed = parseJsonc<unknown>(keybindingsJsonc);
  if (!Array.isArray(parsed)) {
    throw new Error("keybindings.json root must be a JSON array");
  }
  return parsed.flatMap((item) => translateVsCodeKeybinding(item) ?? []);
}

/**
 * Reads `mcpServers` from a Claude Desktop config. Every server lands disabled and pending
 * approval, with sensitive environment values redacted.
 */
export function parseQuarantinedMcpServers(mcpConfigJsonc: string): QuarantinedMcpServerEntry[] {
  const parsed = parseJsoncObject(mcpConfigJsonc, "claude_desktop_config.json root");
  const mcpServers =
    parsed.mcpServers && typeof parsed.mcpServers === "object"
      ? (parsed.mcpServers as Record<string, unknown>)
      : {};

  const servers: QuarantinedMcpServerEntry[] = [];
  for (const [serverName, rawSpec] of Object.entries(mcpServers)) {
    if (!rawSpec || typeof rawSpec !== "object") {
      continue;
    }
    const spec = rawSpec as Record<string, unknown>;
    const command = typeof spec.command === "string" ? spec.command.trim() : "";
    if (!command) {
      continue;
    }
    const args = Array.isArray(spec.args)
      ? spec.args.filter((a): a is string => typeof a === "string")
      : [];
    const redactedEnv: Record<string, string> = {};
    if (spec.env && typeof spec.env === "object") {
      for (const [envKey, envVal] of Object.entries(spec.env as Record<string, unknown>)) {
        const strVal = typeof envVal === "string" ? envVal : String(envVal ?? "");
        redactedEnv[envKey] = isSensitiveEnvEntry(envKey, strVal) ? REDACTED_ENV_VALUE : strVal;
      }
    }
    servers.push({
      serverName,
      command,
      args,
      redactedEnv,
      status: "PendingApproval",
      enabled: false,
      approvalRequired: true,
      securityWarnings: scanMcpSecurityWarnings(command, args),
    });
  }
  return servers;
}

/** Project rule files are kept as untrusted text that can never touch the PolicyEngine. */
export function importProjectConvention(
  fileName: string,
  content: string,
): ImportedProjectConventionEntry {
  return {
    fileName,
    provenance: "UntrustedProjectConvention",
    content,
    canModifyPolicyEngine: false,
    securityPermissionsChanged: 0,
    flaggedInjectionDirectives: scanConventionInjectionDirectives(content),
  };
}
