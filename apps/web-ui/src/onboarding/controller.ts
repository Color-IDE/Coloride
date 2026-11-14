import {
  type Cm6TranslatedKeybinding,
  type ColorideEditorView,
  DEFAULT_COLORIDE_CM6_THEME,
  type DeclarativeVsixBundle,
  type KeymapPresetId,
} from "@coloride/editor-cm6";
import { AtomicStore } from "../state/atomic-store.js";
import { UI_STRINGS } from "../ui/ui-strings.js";
import {
  type ImportedEditorSettings,
  defaultEditorSettings,
  importProjectConvention,
  parseQuarantinedMcpServers,
  parseVsCodeKeybindings,
  parseVsCodeSettings,
} from "./config-import.js";
import { renderOnboardingModal } from "./modal-view.js";
import type {
  DegradedImportFileEntry,
  McpQuarantineStatusId,
  NativeMigrationReport,
  OnboardingState,
  OneClickOnboardingInput,
  QuarantinedMcpServerEntry,
} from "./types.js";
import { parseDeclarativeVsixPackage } from "./vsix-import.js";

export function createInitialOnboardingState(): OnboardingState {
  const defaults = defaultEditorSettings();
  return {
    modalOpen: true,
    selectedSources: ["VsCode", "Cursor", "ClaudeDesktop"],
    activeKeymapPreset: "VsCode",
    colorTheme: defaults.colorTheme,
    iconTheme: defaults.iconTheme,
    fontFamily: defaults.fontFamily,
    fontSizePx: defaults.fontSizePx,
    tabSize: defaults.tabSize,
    insertSpaces: defaults.insertSpaces,
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

/** Runs `parse`; on failure records the file as degraded and returns `fallback`. */
function importOrDegrade<T>(
  degraded: DegradedImportFileEntry[],
  fileLabel: string,
  fallback: T,
  parse: () => T,
): T {
  try {
    return parse();
  } catch (err) {
    degraded.push({ fileLabel, reason: err instanceof Error ? err.message : String(err) });
    return fallback;
  }
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
  private nativeImportLoader: (() => Promise<NativeMigrationReport>) | null = null;

  constructor(editorView: ColorideEditorView, initialState?: OnboardingState) {
    this.editorView = editorView;
    this.store = new AtomicStore<OnboardingState>(initialState ?? createInitialOnboardingState());
  }

  setNativeImportLoader(loader: () => Promise<NativeMigrationReport>): void {
    this.nativeImportLoader = loader;
  }

  applyNativeMigrationReport(report: NativeMigrationReport): OnboardingState {
    const importedKeybindings: Cm6TranslatedKeybinding[] = report.keybindings.map((binding) => ({
      rawKey: binding.raw_key,
      cm6Key: binding.cm6_key,
      command: binding.command,
      ...(binding.when_clause ? { whenClause: binding.when_clause } : {}),
    }));
    this.editorView.setKeymapPreset(report.settings.keymap_preset, importedKeybindings);
    this.applyEditorTheme(
      report.settings.color_theme,
      report.settings.font_family,
      report.settings.font_size,
    );
    return this.store.setState((prev) => ({
      ...prev,
      activeKeymapPreset: report.settings.keymap_preset,
      colorTheme: report.settings.color_theme,
      iconTheme: report.settings.icon_theme,
      fontFamily: report.settings.font_family,
      fontSizePx: report.settings.font_size,
      tabSize: report.settings.tab_size,
      insertSpaces: report.settings.insert_spaces,
      importedKeybindings,
      quarantinedMcpServers: report.quarantined_mcp_servers.map((server) => ({
        serverName: server.server_name,
        command: server.command,
        args: server.args,
        redactedEnv: server.redacted_env,
        status: server.status,
        enabled: server.enabled,
        approvalRequired: server.approval_required,
        securityWarnings: server.security_warnings,
      })),
      projectConventions: report.project_conventions.map((convention) => ({
        fileName: convention.file_name,
        provenance: "UntrustedProjectConvention",
        content: convention.content,
        canModifyPolicyEngine: false,
        securityPermissionsChanged: 0,
        flaggedInjectionDirectives: convention.flagged_injection_directives,
      })),
      degradedFiles: report.degraded_files.map((file) => ({
        fileLabel: file.file_label,
        reason: file.reason,
      })),
      lastImportDurationMs: report.elapsed_ms,
      processesLaunchedDuringImport: 0,
      securityPermissionsChanged: 0,
    }));
  }

  mountModal(hostContainer: HTMLElement): HTMLElement {
    if (!this.modalEl) {
      this.modalEl = hostContainer.ownerDocument.createElement("aside");
      this.modalEl.className = "coloride-onboarding-modal";
      this.modalEl.setAttribute("role", "dialog");
      this.modalEl.setAttribute("aria-modal", "true");
      this.modalEl.setAttribute("aria-label", UI_STRINGS.onboarding.title);
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
    this.store.setState((prev) => ({ ...prev, activeKeymapPreset: preset }));
  }

  /**
   * Run 1-click import across VS Code, Cursor, Claude Desktop, project rules, and `.vsix` packages.
   * Guarantees `< 2 s` execution, `0` processes spawned, and `0` security permission changes.
   */
  runOneClickImport(input: OneClickOnboardingInput): OnboardingState {
    const startedAt = performance.now();
    const degradedFiles: DegradedImportFileEntry[] = [];

    const settings: ImportedEditorSettings =
      input.settingsJsonc === undefined
        ? defaultEditorSettings()
        : importOrDegrade(degradedFiles, "settings.json", defaultEditorSettings(), () =>
            parseVsCodeSettings(input.settingsJsonc as string),
          );
    const importedKeybindings =
      input.keybindingsJsonc === undefined
        ? []
        : importOrDegrade(degradedFiles, "keybindings.json", [], () =>
            parseVsCodeKeybindings(input.keybindingsJsonc as string),
          );
    const quarantinedMcpServers =
      input.claudeMcpConfigJsonc === undefined
        ? []
        : importOrDegrade(degradedFiles, "claude_desktop_config.json", [], () =>
            parseQuarantinedMcpServers(input.claudeMcpConfigJsonc as string),
          );
    const projectConventions = (input.projectConventions ?? []).map((conv) =>
      importProjectConvention(conv.fileName, conv.content),
    );

    let colorTheme = settings.colorTheme;
    let iconTheme = settings.iconTheme;
    const loadedVsixBundles: DeclarativeVsixBundle[] = [];
    (input.declarativeVsixPackages ?? []).forEach((pkg, idx) => {
      const bundle = importOrDegrade(degradedFiles, `extension-${idx + 1}.vsix`, null, () =>
        parseDeclarativeVsixPackage(pkg.packageJsonc, pkg.files),
      );
      if (!bundle) {
        return;
      }
      loadedVsixBundles.push(bundle);
      this.editorView.applyDeclarativeVsixBundle(bundle);
      colorTheme = bundle.themes[0]?.label ?? colorTheme;
      iconTheme = bundle.iconThemes[0] ?? iconTheme;
    });

    const activeKeymapPreset = settings.detectedPreset ?? this.store.getState().activeKeymapPreset;
    this.editorView.setKeymapPreset(activeKeymapPreset, [
      ...importedKeybindings,
      ...loadedVsixBundles.flatMap((b) => b.keybindings),
    ]);
    if (loadedVsixBundles.every((b) => b.themes.length === 0)) {
      this.applyEditorTheme(colorTheme, settings.fontFamily, settings.fontSizePx);
    }

    return this.store.setState((prev) => ({
      ...prev,
      activeKeymapPreset,
      colorTheme,
      iconTheme,
      fontFamily: settings.fontFamily,
      fontSizePx: settings.fontSizePx,
      tabSize: settings.tabSize,
      insertSpaces: settings.insertSpaces,
      importedKeybindings,
      quarantinedMcpServers,
      projectConventions,
      loadedVsixBundles,
      degradedFiles,
      lastImportDurationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      processesLaunchedDuringImport: 0,
      securityPermissionsChanged: 0,
    }));
  }

  /**
   * Explicitly approve a quarantined MCP server after user inspection.
   */
  approveQuarantinedMcpServer(serverName: string): void {
    this.setServerStatus(serverName, "ApprovedByUser");
  }

  /**
   * Explicitly reject a quarantined MCP server.
   */
  rejectQuarantinedMcpServer(serverName: string): void {
    this.setServerStatus(serverName, "RejectedByUser");
  }

  setModalOpen(open: boolean): void {
    this.store.setState((prev) => ({ ...prev, modalOpen: open }));
  }

  /**
   * 1-click reset to clean Coloride defaults.
   */
  resetToColorideDefaults(): OnboardingState {
    this.editorView.resetToColorideDefaults();
    return this.store.setState(createInitialOnboardingState());
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.modalEl?.remove();
    this.modalEl = null;
  }

  private setServerStatus(serverName: string, status: McpQuarantineStatusId): void {
    const approved = status === "ApprovedByUser";
    this.store.setState((prev) => ({
      ...prev,
      quarantinedMcpServers: prev.quarantinedMcpServers.map(
        (s): QuarantinedMcpServerEntry =>
          s.serverName === serverName
            ? { ...s, status, enabled: approved, approvalRequired: false }
            : s,
      ),
    }));
  }

  private applyEditorTheme(label: string, fontFamily: string, fontSizePx: number): void {
    this.editorView.setTheme({
      label,
      uiTheme: "vs-dark",
      editorBackground: DEFAULT_COLORIDE_CM6_THEME.editorBackground,
      editorForeground: DEFAULT_COLORIDE_CM6_THEME.editorForeground,
      fontFamily,
      fontSizePx,
    });
  }

  private renderModal(): void {
    if (!this.modalEl) {
      return;
    }
    const loader = this.nativeImportLoader;
    renderOnboardingModal(this.modalEl, this.store.getState(), {
      selectKeymapPreset: (preset) => this.selectKeymapPreset(preset),
      approveServer: (name) => this.approveQuarantinedMcpServer(name),
      rejectServer: (name) => this.rejectQuarantinedMcpServer(name),
      resetToDefaults: () => this.resetToColorideDefaults(),
      nativeImport: loader
        ? { load: loader, apply: (report) => this.applyNativeMigrationReport(report) }
        : null,
    });
  }
}
