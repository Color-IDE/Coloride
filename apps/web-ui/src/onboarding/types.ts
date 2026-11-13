import type {
  Cm6TranslatedKeybinding,
  DeclarativeVsixBundle,
  KeymapPresetId,
} from "@coloride/editor-cm6";

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

/** Report produced by the Rust `run_native_migration_command` (snake_case wire format). */
export interface NativeMigrationReport {
  readonly settings: {
    readonly color_theme: string;
    readonly icon_theme: string;
    readonly font_family: string;
    readonly font_size: number;
    readonly tab_size: number;
    readonly insert_spaces: boolean;
    readonly keymap_preset: KeymapPresetId;
  };
  readonly keybindings: ReadonlyArray<{
    readonly raw_key: string;
    readonly cm6_key: string;
    readonly command: string;
    readonly when_clause: string | null;
  }>;
  readonly quarantined_mcp_servers: ReadonlyArray<{
    readonly server_name: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly redacted_env: Readonly<Record<string, string>>;
    readonly status: McpQuarantineStatusId;
    readonly enabled: boolean;
    readonly approval_required: boolean;
    readonly security_warnings: readonly string[];
  }>;
  readonly project_conventions: ReadonlyArray<{
    readonly file_name: string;
    readonly content: string;
    readonly can_modify_policy_engine: boolean;
    readonly security_permissions_changed: number;
    readonly flagged_injection_directives: readonly string[];
  }>;
  readonly degraded_files: ReadonlyArray<{ readonly file_label: string; readonly reason: string }>;
  readonly elapsed_ms: number;
  readonly processes_launched: number;
  readonly security_permissions_changed: number;
}
