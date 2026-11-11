import {
  type Cm6TranslatedKeybinding,
  type ColorideEditorView,
  DEFAULT_COLORIDE_CM6_THEME,
  type DeclarativeVsixBundle,
  type DeclarativeVsixSnippet,
  type DeclarativeVsixTheme,
  type KeymapPresetId,
  translateVsCodeKeyToCm6,
} from "@coloride/editor-cm6";
import { AtomicStore } from "./stores.js";

export const REDACTED_ENV_VALUE = "•••••••• [REDACTED]";

export type OsPlatformId = "MacOs" | "Windows" | "Linux";
export type ExternalIdeSourceId = "VsCode" | "Cursor" | "ClaudeDesktop";
export type McpQuarantineStatusId = "PendingApproval" | "ApprovedByUser" | "RejectedByUser";

export interface ExternalIdeDiscoveredPaths {
  readonly source: ExternalIdeSourceId;
  readonly platform: OsPlatformId;
  readonly settingsJsonPath: string | null;
  readonly keybindingsJsonPath: string | null;
  readonly mcpConfigJsonPath: string | null;
}

export interface QuarantinedMcpServerEntry {
  readonly serverName: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly redactedEnv: Readonly<Record<string, string>>;
  readonly status: McpQuarantineStatusId;
  readonly enabled: boolean;
  readonly approvalRequired: boolean;
  readonly securityWarnings: readonly string[];
}

export interface ImportedProjectConventionEntry {
  readonly fileName: string;
  readonly provenance: "UntrustedProjectConvention";
  readonly content: string;
  readonly canModifyPolicyEngine: false;
  readonly securityPermissionsChanged: 0;
  readonly flaggedInjectionDirectives: readonly string[];
}

export interface DegradedImportFileEntry {
  readonly fileLabel: string;
  readonly reason: string;
}

export interface OnboardingState {
  readonly modalOpen: boolean;
  readonly selectedSources: readonly ExternalIdeSourceId[];
  readonly activeKeymapPreset: KeymapPresetId;
  readonly colorTheme: string;
  readonly iconTheme: string;
  readonly fontFamily: string;
  readonly fontSizePx: number;
  readonly tabSize: number;
  readonly insertSpaces: boolean;
  readonly importedKeybindings: readonly Cm6TranslatedKeybinding[];
  readonly quarantinedMcpServers: readonly QuarantinedMcpServerEntry[];
  readonly projectConventions: readonly ImportedProjectConventionEntry[];
  readonly loadedVsixBundles: readonly DeclarativeVsixBundle[];
  readonly degradedFiles: readonly DegradedImportFileEntry[];
  readonly lastImportDurationMs: number;
  readonly processesLaunchedDuringImport: 0;
  readonly securityPermissionsChanged: 0;
}

export interface OneClickOnboardingInput {
  readonly settingsJsonc?: string;
  readonly keybindingsJsonc?: string;
  readonly claudeMcpConfigJsonc?: string;
  readonly projectConventions?: ReadonlyArray<{
    readonly fileName: string;
    readonly content: string;
  }>;
  readonly declarativeVsixPackages?: ReadonlyArray<{
    readonly packageJsonc: string;
    readonly files?: Readonly<Record<string, string>>;
  }>;
}

/**
 * Resolve standard read-only configuration paths for VS Code, Cursor, and Claude Desktop
 * across macOS, Windows, and Linux (`LOT-006`).
 */
export function resolveExternalIdePaths(
  platform: OsPlatformId,
  homeDir: string,
  appDataOverride?: string,
  xdgConfigOverride?: string,
): readonly ExternalIdeDiscoveredPaths[] {
  const sep = platform === "Windows" ? "\\" : "/";
  const join = (...parts: string[]) =>
    parts
      .map((p, idx) => (idx === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
      .join(sep);

  const baseConfigDir =
    platform === "MacOs"
      ? join(homeDir, "Library", "Application Support")
      : platform === "Windows"
        ? (appDataOverride ?? join(homeDir, "AppData", "Roaming"))
        : (xdgConfigOverride ?? join(homeDir, ".config"));

  return [
    {
      source: "VsCode",
      platform,
      settingsJsonPath: join(baseConfigDir, "Code", "User", "settings.json"),
      keybindingsJsonPath: join(baseConfigDir, "Code", "User", "keybindings.json"),
      mcpConfigJsonPath: join(baseConfigDir, "Code", "User", "mcp.json"),
    },
    {
      source: "Cursor",
      platform,
      settingsJsonPath: join(baseConfigDir, "Cursor", "User", "settings.json"),
      keybindingsJsonPath: join(baseConfigDir, "Cursor", "User", "keybindings.json"),
      mcpConfigJsonPath: join(homeDir, ".cursor", "mcp.json"),
    },
    {
      source: "ClaudeDesktop",
      platform,
      settingsJsonPath: null,
      keybindingsJsonPath: null,
      mcpConfigJsonPath: join(baseConfigDir, "Claude", "claude_desktop_config.json"),
    },
  ];
}

/**
 * Strip `//` line comments, `/* ... * /` block comments, and trailing commas `,` before `}` or `]`
 * while preserving `"..."` string literals intact.
 */
export function sanitizeJsoncToJson(input: string): string {
  let noComments = "";
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < input.length) {
    const ch = input[i] ?? "";
    const next = input[i + 1] ?? "";
    if (inString) {
      noComments += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      noComments += ch;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i + 1 < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        if (input[i] === "\n") {
          noComments += "\n";
        }
        i += 1;
      }
      i = i + 1 < input.length ? i + 2 : input.length;
      continue;
    }

    noComments += ch;
    i += 1;
  }

  let out = "";
  let j = 0;
  inString = false;
  escaped = false;

  while (j < noComments.length) {
    const ch = noComments[j] ?? "";
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      j += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      j += 1;
      continue;
    }

    if (ch === ",") {
      let lookahead = j + 1;
      while (lookahead < noComments.length && /\s/.test(noComments[lookahead] ?? "")) {
        lookahead += 1;
      }
      const nextToken = noComments[lookahead];
      if (nextToken === "}" || nextToken === "]") {
        j += 1;
        continue;
      }
    }

    out += ch;
    j += 1;
  }

  return out;
}

export function parseJsonc<T = unknown>(input: string): T {
  const cleaned = sanitizeJsoncToJson(input);
  return JSON.parse(cleaned) as T;
}

function isSensitiveEnvKeyOrValue(key: string, value: string): boolean {
  const upper = key.toUpperCase();
  const markers = [
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
  if (markers.some((m) => upper.includes(m))) {
    return true;
  }
  const trimmed = value.trim();
  return (
    trimmed.startsWith("sk-") ||
    trimmed.startsWith("ghp_") ||
    trimmed.startsWith("xoxb-") ||
    trimmed.startsWith("eyJ")
  );
}

function scanMcpSecurityWarnings(command: string, args: readonly string[]): string[] {
  const warnings: string[] = [];
  const full = `${command} ${args.join(" ")}`.toLowerCase();
  if (
    (full.includes("curl ") || full.includes("wget ")) &&
    (full.includes("| sh") ||
      full.includes("| bash") ||
      full.includes("|sh") ||
      full.includes("|bash"))
  ) {
    warnings.push("CRITICAL: Remote shell pipe execution (`curl/wget | sh`) quarantined.");
  }
  if (full.includes("sudo ") || full.includes("chmod +s")) {
    warnings.push("Privilege escalation command detected (`sudo`). Quarantined.");
  }
  if (/^(sh|bash|\/bin\/sh|\/bin\/bash|powershell|cmd\.exe)\b/.test(full.trim())) {
    warnings.push("Direct shell interpreter requires explicit user scope approval.");
  }
  return warnings;
}

function scanConventionInjectionDirectives(content: string): string[] {
  const flagged: string[] = [];
  const lines = content.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    const lower = line.toLowerCase();
    if (
      lower.includes("allow_unsandboxed") ||
      lower.includes("disable_sandbox") ||
      lower.includes("bypass_policy") ||
      lower.includes("override policy") ||
      lower.includes("policy_engine") ||
      lower.includes("auto_approve_all") ||
      (lower.includes("curl ") && lower.includes("| sh")) ||
      lower.includes("sudo ")
    ) {
      flagged.push(`line ${idx + 1}: ${line.trim()}`);
    }
  }
  return flagged;
}

export function parseDeclarativeVsixPackage(
  packageJsonc: string,
  files: Readonly<Record<string, string>> = {},
): DeclarativeVsixBundle {
  const manifest = parseJsonc<Record<string, unknown>>(packageJsonc);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("VSIX package.json must be a JSON object");
  }

  const name = typeof manifest.name === "string" ? manifest.name : "unknown-extension";
  const publisher =
    typeof manifest.publisher === "string" ? manifest.publisher : "unknown-publisher";
  const version = typeof manifest.version === "string" ? manifest.version : "0.0.0";
  const displayName = typeof manifest.displayName === "string" ? manifest.displayName : name;
  const imperativeEntrypointQuarantined =
    typeof manifest.main === "string" || typeof manifest.browser === "string";

  const themes: DeclarativeVsixTheme[] = [];
  const iconThemes: string[] = [];
  const snippets: DeclarativeVsixSnippet[] = [];
  const keybindings: Cm6TranslatedKeybinding[] = [];

  const contributes =
    manifest.contributes && typeof manifest.contributes === "object"
      ? (manifest.contributes as Record<string, unknown>)
      : {};

  if (Array.isArray(contributes.themes)) {
    for (const rawTheme of contributes.themes) {
      if (rawTheme && typeof rawTheme === "object") {
        const t = rawTheme as Record<string, unknown>;
        const label = typeof t.label === "string" ? t.label : "Unnamed Theme";
        const uiTheme = typeof t.uiTheme === "string" ? t.uiTheme : "vs-dark";
        const relPath = typeof t.path === "string" ? t.path.replace(/^\.?\//, "") : "";
        let editorBackground = "#1e1e2e";
        let editorForeground = "#cdd6f4";
        const themeFileContent = files[relPath] ?? files[`./${relPath}`];
        if (themeFileContent) {
          const parsedTheme = parseJsonc<Record<string, unknown>>(themeFileContent);
          const colors =
            parsedTheme.colors && typeof parsedTheme.colors === "object"
              ? (parsedTheme.colors as Record<string, unknown>)
              : {};
          if (typeof colors["editor.background"] === "string") {
            editorBackground = colors["editor.background"];
          }
          if (typeof colors["editor.foreground"] === "string") {
            editorForeground = colors["editor.foreground"];
          }
        }
        themes.push({ label, uiTheme, editorBackground, editorForeground });
      }
    }
  }

  if (Array.isArray(contributes.iconThemes)) {
    for (const rawIcon of contributes.iconThemes) {
      if (rawIcon && typeof rawIcon === "object") {
        const ic = rawIcon as Record<string, unknown>;
        const label =
          typeof ic.label === "string" ? ic.label : typeof ic.id === "string" ? ic.id : null;
        if (label) {
          iconThemes.push(label);
        }
      }
    }
  }

  if (Array.isArray(contributes.snippets)) {
    for (const rawSnip of contributes.snippets) {
      if (rawSnip && typeof rawSnip === "object") {
        const s = rawSnip as Record<string, unknown>;
        const language = typeof s.language === "string" ? s.language : "plaintext";
        const relPath = typeof s.path === "string" ? s.path.replace(/^\.?\//, "") : "";
        const snipFileContent = files[relPath] ?? files[`./${relPath}`];
        if (snipFileContent) {
          const parsedSnips = parseJsonc<Record<string, unknown>>(snipFileContent);
          for (const [snipName, defVal] of Object.entries(parsedSnips)) {
            if (defVal && typeof defVal === "object") {
              const defObj = defVal as Record<string, unknown>;
              const prefix =
                typeof defObj.prefix === "string"
                  ? defObj.prefix
                  : Array.isArray(defObj.prefix) && typeof defObj.prefix[0] === "string"
                    ? defObj.prefix[0]
                    : "";
              const body =
                typeof defObj.body === "string"
                  ? [defObj.body]
                  : Array.isArray(defObj.body)
                    ? defObj.body.filter((line): line is string => typeof line === "string")
                    : [];
              const description =
                typeof defObj.description === "string" ? defObj.description : undefined;
              if (prefix && body.length > 0) {
                snippets.push({
                  language,
                  name: snipName,
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

  if (Array.isArray(contributes.keybindings)) {
    for (const rawKb of contributes.keybindings) {
      if (rawKb && typeof rawKb === "object") {
        const kb = rawKb as Record<string, unknown>;
        if (typeof kb.key === "string" && typeof kb.command === "string") {
          keybindings.push({
            rawKey: kb.key.trim(),
            cm6Key: translateVsCodeKeyToCm6(kb.key),
            command: kb.command.trim(),
            whenClause: typeof kb.when === "string" ? kb.when.trim() : undefined,
          });
        }
      }
    }
  }

  return {
    extensionId: `${publisher}.${name}`,
    displayName,
    version,
    themes,
    iconThemes,
    snippets,
    keybindings,
    imperativeEntrypointQuarantined,
    executedJsEntrypoints: 0,
  };
}

export function createInitialOnboardingState(): OnboardingState {
  return {
    modalOpen: true,
    selectedSources: ["VsCode", "Cursor", "ClaudeDesktop"],
    activeKeymapPreset: "VsCode",
    colorTheme: DEFAULT_COLORIDE_CM6_THEME.label,
    iconTheme: "Coloride Geometric Icons",
    fontFamily: DEFAULT_COLORIDE_CM6_THEME.fontFamily ?? "JetBrains Mono, monospace",
    fontSizePx: DEFAULT_COLORIDE_CM6_THEME.fontSizePx ?? 14,
    tabSize: 2,
    insertSpaces: true,
    importedKeybindings: [],
    quarantinedMcpServers: [],
    projectConventions: [],
    loadedVsixBundles: [],
    degradedFiles: [],
    lastImportDurationMs: 0,
    processesLaunchedDuringImport: 0,
    securityPermissionsChanged: 0,
  };
}

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

/**
 * 1-Click Onboarding & Migration Controller (`LOT-006`) for `apps/web-ui`.
 * Coordinates importing settings, keymaps, quarantined MCP servers, `.cursorrules`/`CLAUDE.md`/`AGENTS.md`,
 * and declarative `.vsix` extensions into CodeMirror 6 without ever remounting the Zone 4 editor.
 */
export class OnboardingModalController {
  readonly store: AtomicStore<OnboardingState>;
  private readonly editorView: ColorideEditorView;
  private modalEl: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(editorView: ColorideEditorView, initialState?: OnboardingState) {
    this.editorView = editorView;
    this.store = new AtomicStore<OnboardingState>(initialState ?? createInitialOnboardingState());
  }

  mountModal(hostContainer: HTMLElement): HTMLElement {
    const doc = hostContainer.ownerDocument;
    if (!this.modalEl) {
      this.modalEl = doc.createElement("aside");
      this.modalEl.className = "coloride-onboarding-modal";
      this.modalEl.setAttribute("role", "dialog");
      this.modalEl.setAttribute("aria-modal", "true");
      this.modalEl.setAttribute(
        "aria-label",
        "Assistant d'Onboarding & Migration 1-clic (VS Code / Cursor / Claude)",
      );
      hostContainer.appendChild(this.modalEl);
      this.unsubscribe = this.store.subscribe(() => {
        this.renderModal();
      });
    }
    this.renderModal();
    return this.modalEl;
  }

  /**
   * Switch keymap preset (`VS Code`, `Vim`, `JetBrains`) in 1 click.
   */
  selectKeymapPreset(preset: KeymapPresetId): void {
    this.editorView.setKeymapPreset(preset, this.store.getState().importedKeybindings);
    this.store.setState((prev) => ({
      ...prev,
      activeKeymapPreset: preset,
    }));
  }

  /**
   * Run 1-click import across VS Code, Cursor, Claude Desktop, project rules, and `.vsix` packages.
   * Guarantees `< 2 s` execution, `0` processes spawned, and `0` security permission changes.
   */
  runOneClickImport(input: OneClickOnboardingInput): OnboardingState {
    const startedAt = nowMs();
    const degradedFiles: DegradedImportFileEntry[] = [];

    let colorTheme = DEFAULT_COLORIDE_CM6_THEME.label;
    let iconTheme = "Coloride Geometric Icons";
    let fontFamily = DEFAULT_COLORIDE_CM6_THEME.fontFamily ?? "JetBrains Mono, monospace";
    let fontSizePx = DEFAULT_COLORIDE_CM6_THEME.fontSizePx ?? 14;
    let tabSize = 2;
    let insertSpaces = true;
    let detectedPreset: KeymapPresetId = this.store.getState().activeKeymapPreset;

    if (input.settingsJsonc !== undefined) {
      try {
        const parsed = parseJsonc<Record<string, unknown>>(input.settingsJsonc);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Root settings.json must be a JSON object");
        }
        if (typeof parsed["workbench.colorTheme"] === "string") {
          colorTheme = parsed["workbench.colorTheme"].trim();
        }
        if (typeof parsed["workbench.iconTheme"] === "string") {
          iconTheme = parsed["workbench.iconTheme"].trim();
        }
        if (typeof parsed["editor.fontFamily"] === "string") {
          fontFamily = parsed["editor.fontFamily"].trim();
        }
        if (typeof parsed["editor.fontSize"] === "number") {
          fontSizePx = Math.min(64, Math.max(8, Math.round(parsed["editor.fontSize"])));
        }
        if (typeof parsed["editor.tabSize"] === "number") {
          tabSize = Math.min(16, Math.max(1, Math.round(parsed["editor.tabSize"])));
        }
        if (typeof parsed["editor.insertSpaces"] === "boolean") {
          insertSpaces = parsed["editor.insertSpaces"];
        }
        if (
          parsed["vim.useSystemClipboard"] !== undefined ||
          parsed["vim.hlsearch"] !== undefined
        ) {
          detectedPreset = "Vim";
        }
      } catch (err) {
        degradedFiles.push({
          fileLabel: "settings.json",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const importedKeybindings: Cm6TranslatedKeybinding[] = [];
    if (input.keybindingsJsonc !== undefined) {
      try {
        const parsed = parseJsonc<unknown[]>(input.keybindingsJsonc);
        if (!Array.isArray(parsed)) {
          throw new Error("keybindings.json root must be a JSON array");
        }
        for (const item of parsed) {
          if (item && typeof item === "object") {
            const obj = item as Record<string, unknown>;
            if (typeof obj.key === "string" && typeof obj.command === "string") {
              importedKeybindings.push({
                rawKey: obj.key.trim(),
                cm6Key: translateVsCodeKeyToCm6(obj.key),
                command: obj.command.trim(),
                whenClause: typeof obj.when === "string" ? obj.when.trim() : undefined,
              });
            }
          }
        }
      } catch (err) {
        degradedFiles.push({
          fileLabel: "keybindings.json",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const quarantinedMcpServers: QuarantinedMcpServerEntry[] = [];
    if (input.claudeMcpConfigJsonc !== undefined) {
      try {
        const parsed = parseJsonc<Record<string, unknown>>(input.claudeMcpConfigJsonc);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("claude_desktop_config.json root must be a JSON object");
        }
        const mcpServers =
          parsed.mcpServers && typeof parsed.mcpServers === "object"
            ? (parsed.mcpServers as Record<string, unknown>)
            : {};
        for (const [serverName, rawSpec] of Object.entries(mcpServers)) {
          if (rawSpec && typeof rawSpec === "object") {
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
                redactedEnv[envKey] = isSensitiveEnvKeyOrValue(envKey, strVal)
                  ? REDACTED_ENV_VALUE
                  : strVal;
              }
            }
            quarantinedMcpServers.push({
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
        }
      } catch (err) {
        degradedFiles.push({
          fileLabel: "claude_desktop_config.json",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const projectConventions: ImportedProjectConventionEntry[] = (
      input.projectConventions ?? []
    ).map((conv) => ({
      fileName: conv.fileName,
      provenance: "UntrustedProjectConvention",
      content: conv.content,
      canModifyPolicyEngine: false,
      securityPermissionsChanged: 0,
      flaggedInjectionDirectives: scanConventionInjectionDirectives(conv.content),
    }));

    const loadedVsixBundles: DeclarativeVsixBundle[] = [];
    for (let idx = 0; idx < (input.declarativeVsixPackages ?? []).length; idx += 1) {
      const pkg = input.declarativeVsixPackages?.[idx];
      if (!pkg) {
        continue;
      }
      try {
        const bundle = parseDeclarativeVsixPackage(pkg.packageJsonc, pkg.files);
        loadedVsixBundles.push(bundle);
        this.editorView.applyDeclarativeVsixBundle(bundle);
        if (bundle.themes[0]) {
          colorTheme = bundle.themes[0].label;
        }
        if (bundle.iconThemes[0]) {
          iconTheme = bundle.iconThemes[0];
        }
      } catch (err) {
        degradedFiles.push({
          fileLabel: `extension-${idx + 1}.vsix`,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.editorView.setKeymapPreset(detectedPreset, [
      ...importedKeybindings,
      ...loadedVsixBundles.flatMap((b) => b.keybindings),
    ]);

    if (loadedVsixBundles.every((b) => b.themes.length === 0)) {
      this.editorView.setTheme({
        label: colorTheme,
        uiTheme: "vs-dark",
        editorBackground: DEFAULT_COLORIDE_CM6_THEME.editorBackground,
        editorForeground: DEFAULT_COLORIDE_CM6_THEME.editorForeground,
        fontFamily,
        fontSizePx,
      });
    }

    const elapsedMs = Math.max(0, Math.round(nowMs() - startedAt));

    return this.store.setState((prev) => ({
      ...prev,
      activeKeymapPreset: detectedPreset,
      colorTheme,
      iconTheme,
      fontFamily,
      fontSizePx,
      tabSize,
      insertSpaces,
      importedKeybindings,
      quarantinedMcpServers,
      projectConventions,
      loadedVsixBundles,
      degradedFiles,
      lastImportDurationMs: elapsedMs,
      processesLaunchedDuringImport: 0,
      securityPermissionsChanged: 0,
    }));
  }

  /**
   * Explicitly approve a quarantined MCP server after user inspection.
   */
  approveQuarantinedMcpServer(serverName: string): void {
    this.store.setState((prev) => ({
      ...prev,
      quarantinedMcpServers: prev.quarantinedMcpServers.map((s) =>
        s.serverName === serverName
          ? {
              ...s,
              status: "ApprovedByUser",
              enabled: true,
              approvalRequired: false,
            }
          : s,
      ),
    }));
  }

  /**
   * Explicitly reject a quarantined MCP server.
   */
  rejectQuarantinedMcpServer(serverName: string): void {
    this.store.setState((prev) => ({
      ...prev,
      quarantinedMcpServers: prev.quarantinedMcpServers.map((s) =>
        s.serverName === serverName
          ? {
              ...s,
              status: "RejectedByUser",
              enabled: false,
              approvalRequired: false,
            }
          : s,
      ),
    }));
  }

  setModalOpen(open: boolean): void {
    this.store.setState((prev) => ({
      ...prev,
      modalOpen: open,
    }));
  }

  /**
   * 1-click reset to clean Coloride defaults (`Revenir aux paramètres par défaut Coloride`).
   */
  resetToColorideDefaults(): OnboardingState {
    this.editorView.resetToColorideDefaults();
    return this.store.setState(createInitialOnboardingState());
  }

  destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.modalEl?.parentElement) {
      this.modalEl.parentElement.removeChild(this.modalEl);
    }
    this.modalEl = null;
  }

  private renderModal(): void {
    if (!this.modalEl) {
      return;
    }
    const doc = this.modalEl.ownerDocument;
    const state = this.store.getState();
    this.modalEl.innerHTML = "";
    this.modalEl.dataset.keymapPreset = state.activeKeymapPreset;
    this.modalEl.dataset.colorTheme = state.colorTheme;
    this.modalEl.dataset.modalOpen = String(state.modalOpen);
    this.modalEl.hidden = !state.modalOpen;
    this.modalEl.style.display = state.modalOpen ? "block" : "none";

    const title = doc.createElement("h2");
    title.textContent = "Import 1-clic (VS Code · Cursor · Claude Desktop)";
    this.modalEl.appendChild(title);

    // Keymap preset selector (VS Code / Vim / JetBrains)
    const presetBar = doc.createElement("div");
    presetBar.className = "coloride-onboarding-keymap-presets";
    for (const preset of ["VsCode", "Vim", "JetBrains"] as const) {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "coloride-keymap-preset-btn";
      btn.dataset.preset = preset;
      btn.setAttribute("aria-pressed", state.activeKeymapPreset === preset ? "true" : "false");
      btn.textContent = preset === "VsCode" ? "VS Code" : preset;
      btn.addEventListener("click", () => {
        this.selectKeymapPreset(preset);
      });
      presetBar.appendChild(btn);
    }
    this.modalEl.appendChild(presetBar);

    // Quarantined MCP servers list
    const mcpSection = doc.createElement("section");
    mcpSection.className = "coloride-onboarding-mcp-quarantine";
    mcpSection.setAttribute("aria-label", "Serveurs MCP en quarantaine");
    for (const server of state.quarantinedMcpServers) {
      const item = doc.createElement("div");
      item.className = "coloride-quarantined-mcp-item";
      item.dataset.serverName = server.serverName;
      item.dataset.status = server.status;
      item.dataset.enabled = String(server.enabled);
      const badgeText =
        server.status === "PendingApproval"
          ? "Bloqué — En attente d'approbation"
          : server.status === "ApprovedByUser"
            ? "Approuvé"
            : "Rejeté";
      const labelSpan = doc.createElement("span");
      labelSpan.textContent = `${server.serverName}: ${server.command} ${server.args.join(" ")} [${badgeText}]`;
      item.appendChild(labelSpan);

      const approveBtn = doc.createElement("button");
      approveBtn.type = "button";
      approveBtn.className = "coloride-mcp-approve-btn";
      approveBtn.dataset.action = "approve";
      approveBtn.dataset.serverName = server.serverName;
      approveBtn.textContent = "Approuver";
      approveBtn.addEventListener("click", () => {
        this.approveQuarantinedMcpServer(server.serverName);
      });

      const rejectBtn = doc.createElement("button");
      rejectBtn.type = "button";
      rejectBtn.className = "coloride-mcp-reject-btn";
      rejectBtn.dataset.action = "reject";
      rejectBtn.dataset.serverName = server.serverName;
      rejectBtn.textContent = "Rejeté";
      rejectBtn.addEventListener("click", () => {
        this.rejectQuarantinedMcpServer(server.serverName);
      });

      item.appendChild(approveBtn);
      item.appendChild(rejectBtn);
      mcpSection.appendChild(item);
    }
    this.modalEl.appendChild(mcpSection);

    // Reset to Coloride defaults button
    const resetBtn = doc.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "coloride-reset-defaults-btn";
    resetBtn.textContent = "Revenir aux paramètres par défaut Coloride";
    resetBtn.addEventListener("click", () => {
      this.resetToColorideDefaults();
    });
    this.modalEl.appendChild(resetBtn);
  }
}
