import type {
  ColorideValidationState,
  ConfidenceLevel,
  ExcerptFreshness,
} from "@coloride/protocol-types";
import type { AtomicStore } from "../atomic-store.js";
import type { AreaSize, SplitDirection, SplitPosition } from "../layout-tree.js";
import type {
  WorkspaceNavigationActions,
  WorkspaceNavigationState,
} from "../workspace-navigation.js";

export type CockpitPersonaMode = "Create" | "Learn" | "Develop" | "Infrastructure" | "Data";

export type ActivityBarSection = "sessions" | "search" | "git" | "debug" | "mcp";

/** Sections a saved session may name; anything else (e.g. the removed "files") falls back. */
export const ACTIVITY_BAR_SECTIONS: readonly ActivityBarSection[] = [
  "sessions",
  "search",
  "git",
  "debug",
  "mcp",
];

export type InspectorTab = "preview" | "code-diff";

export interface Zone1ActivityState {
  readonly activeSection: ActivityBarSection;
  readonly activePersona: CockpitPersonaMode;
  readonly sidebarOpen: boolean;
  /** Right inspector (Zone 4) and its header. Hidden by collapsing, never unmounted. */
  readonly inspectorOpen: boolean;
  readonly fileTreeAccessible: true;
  readonly uiZoomPercent: number;
  readonly permissionsLevel: "standard-enforced";
}

export interface CockpitFileTreeNode {
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  readonly isDirectory: boolean;
  readonly validationState: ColorideValidationState;
}

export interface CockpitSessionSummary {
  readonly chatId: string;
  readonly title: string;
  readonly modelName: string;
  readonly validationState: ColorideValidationState;
  readonly targetDocumentId: string;
}

export interface CockpitAstSymbolItem {
  readonly name: string;
  readonly kind: "function" | "component" | "class" | "interface" | "type" | "const";
  readonly line: number;
  readonly exported: boolean;
  readonly confidence: ConfidenceLevel;
}

export interface CockpitImpactedTestItem {
  readonly testFilePath: string;
  readonly coveredSymbol: string;
  readonly confidence: ConfidenceLevel;
}

export interface CockpitSearchResultItem {
  readonly filePath: string;
  readonly line: number;
  readonly snippet: string;
  readonly freshness: ExcerptFreshness;
  readonly score: number;
  readonly secretsRedacted: number;
}

export interface Zone2SidebarState {
  readonly sessions: readonly CockpitSessionSummary[];
  readonly fileTree: readonly CockpitFileTreeNode[];
  readonly fileTreeScrollTop: number;
  readonly fileTreeViewportHeight: number;
  readonly focusedFileIndex: number;
  readonly searchQuery: string;
  readonly searchResults: readonly CockpitSearchResultItem[];
  readonly astSymbols: readonly CockpitAstSymbolItem[];
  readonly impactedTests: readonly CockpitImpactedTestItem[];
}

export interface CockpitChatMessage {
  readonly messageId: string;
  readonly chatId: string;
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly renderedHtmlBlocks: readonly string[];
  readonly streaming: boolean;
}

export interface CockpitChatTab {
  readonly chatId: string;
  readonly title: string;
  readonly modelName: string;
  readonly validationState: ColorideValidationState;
  readonly targetDocumentId?: string;
  readonly targetDocumentContent?: string;
  readonly previewUrl?: string;
  readonly agentExecutionStatus?: "Idle" | "Running" | "QueuedSequential";
}

export interface Zone3MultiChatState {
  readonly activeChatId: string;
  readonly chats: readonly CockpitChatTab[];
  readonly messagesByChatId: Readonly<Record<string, readonly CockpitChatMessage[]>>;
  readonly terminalLogsByChatId: Readonly<Record<string, readonly string[]>>;
  readonly activeRunningAgentChatId: string | null;
  readonly sequentialAgentQueue: readonly string[];
}

export interface Zone4InspectorState {
  readonly activeInspectorTab: InspectorTab;
  readonly syncedChatId: string;
  readonly activeDocumentId: string;
  readonly activeValidationState: ColorideValidationState;
  readonly previewUrl: string;
  readonly lastSyncDurationMs: number;
  readonly hasUnsavedChanges: boolean;
  readonly recoveredFromWal: boolean;
}

export interface CreateChatOptions {
  /** Tab that receives the session. Defaults to the active one. */
  readonly groupId?: string;
  /** Existing panel to split. Without it the new panel goes where there is the most room. */
  readonly from?: string;
  readonly direction?: SplitDirection;
  readonly position?: SplitPosition;
  readonly title?: string;
  readonly modelName?: string;
}

export interface CockpitStoreBundle extends WorkspaceNavigationActions {
  renameChat(id: string, title: string): void;
  /**
   * Creates a session and places it in the layout of a tab. Returns its id, or null when the
   * tab does not exist or the panel would drop below the minimum size in the measured area.
   */
  createChat(options?: CreateChatOptions): string | null;
  /**
   * Shows a session alone in its tab, or, when it already is, goes back to the tiled panels.
   * While one is maximized the header tabs switch which one is shown.
   */
  toggleMaximizeChat(chatId: string): void;
  /** Same check as `createChat`, without creating anything. */
  canCreateChat(options?: CreateChatOptions): boolean;
  /** Size in pixels of the area holding the panels; unknown (null) means no size limit. */
  setPanelArea(area: AreaSize | null): void;
  getPanelArea(): AreaSize | null;
  readonly zone1: AtomicStore<Zone1ActivityState>;
  readonly zone2: AtomicStore<Zone2SidebarState>;
  readonly zone3: AtomicStore<Zone3MultiChatState>;
  readonly zone4: AtomicStore<Zone4InspectorState>;
  setActivitySection(section: ActivityBarSection): void;
  handleActivityBarShortcut(key: string, metaOrCtrlKey: boolean): boolean;
  setPersona(persona: CockpitPersonaMode, duringActiveTask?: boolean): void;
  toggleSidebar(open?: boolean): void;
  toggleInspector(open?: boolean): void;
  setUiZoomPercent(zoomPercent: number): void;
  setInspectorTab(tab: InspectorTab): void;
  selectChat(chatId: string): number;
  closeChat(chatId: string): void;
  setFileTree(fileTree: readonly CockpitFileTreeNode[]): void;
  selectFileFromTree(filePath: string, contentOverride?: string): number;
  getDocumentContent(filePath: string): string | undefined;
  updateInMemoryDocumentContent(
    filePath: string,
    content: string,
    hasUnsavedChanges?: boolean,
  ): void;
  markDocumentSaved(filePath: string): void;
  /** True while the in-memory buffer of `filePath` differs from what was last saved. */
  isDocumentUnsaved(filePath: string): boolean;
  /** Every document of the open project whose buffer holds edits that are not on disk. */
  getUnsavedDocumentIds(): string[];
  /** Forgets the in-memory buffer so the next open reads the file from disk again. */
  discardDocumentBuffer(filePath: string): void;
  runGlobalSearch(query: string): readonly CockpitSearchResultItem[];
  setGlobalSearchResults(query: string, results: readonly CockpitSearchResultItem[]): void;
  setAstAnalysis(
    symbols: readonly CockpitAstSymbolItem[],
    impactedTests: readonly CockpitImpactedTestItem[],
  ): void;
  refreshAstAndImpactedTests(filePath: string, content: string): void;
  startAgentTaskOnChat(chatId: string): "Running" | "QueuedSequential";
  completeAgentTaskOnChat(chatId: string): void;
}

export interface CockpitStoreOptions {
  initialNavigation?: WorkspaceNavigationState | undefined;
  initialPersona?: CockpitPersonaMode | undefined;
  initialInspectorTab?: InspectorTab | undefined;
  initialActiveSection?: ActivityBarSection | undefined;
  initialActiveChatId?: string | undefined;
  initialActiveDocumentId?: string | undefined;
  initialChats?: readonly CockpitChatTab[] | undefined;
  initialFileTree?: readonly CockpitFileTreeNode[] | undefined;
  initialUiZoomPercent?: number | undefined;
  initialRecoveredFromWal?: boolean | undefined;
}
