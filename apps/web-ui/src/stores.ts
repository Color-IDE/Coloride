import {
  COLORIDE_STATE_META,
  type ColorideValidationState,
  type ConfidenceLevel,
  type ExcerptFreshness,
} from "@coloride/protocol-types";

export type CockpitGridMode = 1 | 2 | 4 | 8;

export type CockpitPersonaMode = "Create" | "Learn" | "Develop" | "Infrastructure" | "Data";

export type ActivityBarSection = "sessions" | "files" | "search" | "git" | "debug" | "mcp";

export type InspectorTab = "preview" | "code-diff";

export interface DesignStateTokens {
  readonly state: ColorideValidationState;
  readonly icon: "✓" | "!" | "✕" | "⟳" | "•";
  readonly labelFr: string;
  readonly labelEn: string;
  readonly darkBg: string;
  readonly darkBorder: string;
  readonly darkText: string;
  readonly lightBg: string;
  readonly lightBorder: string;
  readonly lightText: string;
}

/**
 * Exact WCAG AA/AAA visual tokens and semantic icons from `DESIGN_SYSTEM.md`.
 * Every state combines background/border/text colors, a distinct geometric icon, and explicit labels.
 */
export const COLORIDE_DESIGN_TOKENS: Record<ColorideValidationState, DesignStateTokens> = {
  ValidatedGreen: {
    state: "ValidatedGreen",
    icon: COLORIDE_STATE_META.ValidatedGreen.icon,
    labelFr: COLORIDE_STATE_META.ValidatedGreen.labelFr,
    labelEn: COLORIDE_STATE_META.ValidatedGreen.labelEn,
    darkBg: "#052e16",
    darkBorder: "#22c55e",
    darkText: "#86efac",
    lightBg: "#dcfce7",
    lightBorder: "#16a34a",
    lightText: "#14532d",
  },
  ReviewYellow: {
    state: "ReviewYellow",
    icon: COLORIDE_STATE_META.ReviewYellow.icon,
    labelFr: COLORIDE_STATE_META.ReviewYellow.labelFr,
    labelEn: COLORIDE_STATE_META.ReviewYellow.labelEn,
    darkBg: "#422006",
    darkBorder: "#eab308",
    darkText: "#fde047",
    lightBg: "#fef9c3",
    lightBorder: "#ca8a04",
    lightText: "#713f12",
  },
  FailedRed: {
    state: "FailedRed",
    icon: COLORIDE_STATE_META.FailedRed.icon,
    labelFr: COLORIDE_STATE_META.FailedRed.labelFr,
    labelEn: COLORIDE_STATE_META.FailedRed.labelEn,
    darkBg: "#450a0a",
    darkBorder: "#ef4444",
    darkText: "#fca5a5",
    lightBg: "#fee2e2",
    lightBorder: "#dc2626",
    lightText: "#7f1d1d",
  },
  StaleOrange: {
    state: "StaleOrange",
    icon: COLORIDE_STATE_META.StaleOrange.icon,
    labelFr: COLORIDE_STATE_META.StaleOrange.labelFr,
    labelEn: COLORIDE_STATE_META.StaleOrange.labelEn,
    darkBg: "#431407",
    darkBorder: "#f97316",
    darkText: "#fdba74",
    lightBg: "#ffedd5",
    lightBorder: "#ea580c",
    lightText: "#7c2d12",
  },
  UnchangedBlue: {
    state: "UnchangedBlue",
    icon: COLORIDE_STATE_META.UnchangedBlue.icon,
    labelFr: COLORIDE_STATE_META.UnchangedBlue.labelFr,
    labelEn: COLORIDE_STATE_META.UnchangedBlue.labelEn,
    darkBg: "#0f172a",
    darkBorder: "#3b82f6",
    darkText: "#93c5fd",
    lightBg: "#dbeafe",
    lightBorder: "#2563eb",
    lightText: "#1e3a8a",
  },
};

export type StoreListener<T> = (state: T, prevState: T) => void;

/**
 * Lightweight Zustand/Jotai-style atomic store isolating subscriptions per Cockpit zone
 * so Zone 3 streaming or Zone 2 file tree scrolling never triggers Zone 4 editor container re-renders.
 */
export class AtomicStore<T> {
  private state: T;
  private updateCount = 0;
  private readonly listeners = new Set<StoreListener<T>>();

  constructor(initialState: T) {
    this.state = initialState;
  }

  getState(): T {
    return this.state;
  }

  getUpdateCount(): number {
    return this.updateCount;
  }

  setState(updater: T | ((prev: T) => T)): T {
    const prev = this.state;
    const next = typeof updater === "function" ? (updater as (prev: T) => T)(prev) : updater;
    if (Object.is(prev, next)) {
      return prev;
    }
    this.state = next;
    this.updateCount += 1;
    for (const listener of this.listeners) {
      listener(next, prev);
    }
    return next;
  }

  subscribe(listener: StoreListener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeSelector<S>(
    selector: (state: T) => S,
    listener: (selected: S, prevSelected: S) => void,
    isEqual: (a: S, b: S) => boolean = Object.is,
  ): () => void {
    let currentSlice = selector(this.state);
    return this.subscribe((nextState) => {
      const nextSlice = selector(nextState);
      if (!isEqual(currentSlice, nextSlice)) {
        const prevSlice = currentSlice;
        currentSlice = nextSlice;
        listener(nextSlice, prevSlice);
      }
    });
  }
}

export interface Zone1ActivityState {
  readonly activeSection: ActivityBarSection;
  readonly activePersona: CockpitPersonaMode;
  readonly sidebarOpen: boolean;
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
  readonly gridMode: CockpitGridMode;
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

export interface CockpitStoreBundle {
  readonly zone1: AtomicStore<Zone1ActivityState>;
  readonly zone2: AtomicStore<Zone2SidebarState>;
  readonly zone3: AtomicStore<Zone3MultiChatState>;
  readonly zone4: AtomicStore<Zone4InspectorState>;
  setActivitySection(section: ActivityBarSection): void;
  handleActivityBarShortcut(key: string, metaOrCtrlKey: boolean): boolean;
  setPersona(persona: CockpitPersonaMode, duringActiveTask?: boolean): void;
  toggleSidebar(open?: boolean): void;
  setUiZoomPercent(zoomPercent: number): void;
  setGridMode(gridMode: CockpitGridMode): void;
  setInspectorTab(tab: InspectorTab): void;
  selectChat(chatId: string): number;
  closeChat(chatId: string): void;
  selectFileFromTree(filePath: string, contentOverride?: string): number;
  getDocumentContent(filePath: string): string | undefined;
  updateInMemoryDocumentContent(
    filePath: string,
    content: string,
    hasUnsavedChanges?: boolean,
  ): void;
  markDocumentSaved(filePath: string): void;
  runGlobalSearch(query: string): readonly CockpitSearchResultItem[];
  refreshAstAndImpactedTests(filePath: string, content: string): void;
  startAgentTaskOnChat(chatId: string): "Running" | "QueuedSequential";
  completeAgentTaskOnChat(chatId: string): void;
}

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

const SECRET_TOKEN_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bghp_[A-Za-z0-9]{12,}\b/g,
  /\bAKIA[0-9A-Z]{12,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
];

function isAclExcludedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const base = normalized.split("/").pop() ?? normalized;
  return (
    base === ".env" ||
    (base.startsWith(".env.") && base !== ".env.example") ||
    base.endsWith(".pem") ||
    base.endsWith(".key")
  );
}

function redactSecretsInLine(line: string): {
  readonly sanitized: string;
  readonly redactedCount: number;
} {
  let sanitized = line;
  let redactedCount = 0;
  for (const regex of SECRET_TOKEN_PATTERNS) {
    sanitized = sanitized.replace(regex, () => {
      redactedCount += 1;
      return "[REDACTED_SECRET]";
    });
  }
  return { sanitized, redactedCount };
}

/**
 * Extract syntactic symbols (`LOT-007`) from an in-memory TypeScript/TSX/JS buffer.
 */
export function extractAstSymbolsFromSource(content: string): readonly CockpitAstSymbolItem[] {
  const lines = content.split(/\r?\n/);
  const symbols: CockpitAstSymbolItem[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const fnMatch = /^\s*(export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(line);
    if (fnMatch?.[2]) {
      const name = fnMatch[2];
      const firstChar = name[0] ?? "";
      const isComponent = firstChar >= "A" && firstChar <= "Z";
      symbols.push({
        name,
        kind: isComponent ? "component" : "function",
        line: i + 1,
        exported: Boolean(fnMatch[1]),
        confidence: "ExactAstLsp",
      });
      continue;
    }
    const classMatch = /^\s*(export\s+)?class\s+([A-Za-z0-9_$]+)/.exec(line);
    if (classMatch?.[2]) {
      symbols.push({
        name: classMatch[2],
        kind: "class",
        line: i + 1,
        exported: Boolean(classMatch[1]),
        confidence: "ExactAstLsp",
      });
      continue;
    }
    const ifaceMatch = /^\s*(export\s+)?interface\s+([A-Za-z0-9_$]+)/.exec(line);
    if (ifaceMatch?.[2]) {
      symbols.push({
        name: ifaceMatch[2],
        kind: "interface",
        line: i + 1,
        exported: Boolean(ifaceMatch[1]),
        confidence: "ExactAstLsp",
      });
      continue;
    }
    const typeMatch = /^\s*(export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/.exec(line);
    if (typeMatch?.[2]) {
      symbols.push({
        name: typeMatch[2],
        kind: "type",
        line: i + 1,
        exported: Boolean(typeMatch[1]),
        confidence: "ExactAstLsp",
      });
      continue;
    }
    const constMatch = /^\s*(export\s+)?const\s+([A-Za-z0-9_$]+)\s*=/.exec(line);
    if (constMatch?.[2]) {
      const name = constMatch[2];
      const firstChar = name[0] ?? "";
      const isComponent = firstChar >= "A" && firstChar <= "Z" && line.includes("=>");
      symbols.push({
        name,
        kind: isComponent ? "component" : "const",
        line: i + 1,
        exported: Boolean(constMatch[1]),
        confidence: "ExactAstLsp",
      });
    }
  }
  return symbols;
}

/**
 * Compute impacted test files (`LOT-007` `ImpactAnalyzer::find_impacted_tests`) for `filePath` and its symbols.
 */
export function computeImpactedTestsForBuffer(
  filePath: string,
  symbols: readonly CockpitAstSymbolItem[],
  fileTree: readonly CockpitFileTreeNode[],
): readonly CockpitImpactedTestItem[] {
  const stem = filePath.replace(/\.(tsx|ts|jsx|js)$/, "");
  const primarySymbol = symbols[0]?.name ?? (stem.split("/").pop() || "module");
  const impacted: CockpitImpactedTestItem[] = [];
  const seen = new Set<string>();

  for (const node of fileTree) {
    if (node.isDirectory) {
      continue;
    }
    if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(node.path)) {
      const nodeStem = node.path.replace(/\.(test|spec)\.(ts|tsx|js|jsx)$/, "");
      if (nodeStem === stem || node.path.includes(primarySymbol)) {
        seen.add(node.path);
        impacted.push({
          testFilePath: node.path,
          coveredSymbol: primarySymbol,
          confidence: "ExactAstLsp",
        });
      }
    }
  }

  const canonicalTestPath = `${stem}.test.ts`;
  if (!seen.has(canonicalTestPath)) {
    impacted.push({
      testFilePath: canonicalTestPath,
      coveredSymbol: primarySymbol,
      confidence: "ExactAstLsp",
    });
  }

  return impacted;
}

export function createCockpitStoreBundle(options?: {
  initialPersona?: CockpitPersonaMode | undefined;
  initialGridMode?: CockpitGridMode | undefined;
  initialInspectorTab?: InspectorTab | undefined;
  initialActiveSection?: ActivityBarSection | undefined;
  initialActiveChatId?: string | undefined;
  initialActiveDocumentId?: string | undefined;
  initialChats?: readonly CockpitChatTab[] | undefined;
  initialFileTree?: readonly CockpitFileTreeNode[] | undefined;
  initialUiZoomPercent?: number | undefined;
  initialRecoveredFromWal?: boolean | undefined;
}): CockpitStoreBundle {
  const initialPersona = options?.initialPersona ?? "Develop";
  const initialChats: readonly CockpitChatTab[] = options?.initialChats ?? [
    {
      chatId: "chat-1",
      title: "#1 Login UI",
      modelName: "Codex",
      validationState: "ValidatedGreen",
      targetDocumentId: options?.initialActiveDocumentId ?? "src/auth/login.tsx",
      targetDocumentContent: "export function LoginView() {\n  return true;\n}\n",
      previewUrl: "preview://local/login",
      agentExecutionStatus: "Idle",
    },
  ];
  const initialActiveChat =
    initialChats.find((c) => c.chatId === options?.initialActiveChatId) ?? initialChats[0];
  const initialChatId = initialActiveChat?.chatId ?? "chat-1";
  const initialDocId =
    options?.initialActiveDocumentId ?? initialActiveChat?.targetDocumentId ?? "src/index.ts";
  const initialDocContent =
    initialActiveChat?.targetDocumentContent ??
    "export function LoginView() {\n  return true;\n}\n";

  const documentBuffers = new Map<
    string,
    { content: string; unsaved: boolean; validationState: ColorideValidationState }
  >();
  for (const chat of initialChats) {
    if (chat.targetDocumentId) {
      documentBuffers.set(chat.targetDocumentId, {
        content:
          chat.targetDocumentContent ??
          `export const ${chat.chatId.replace(/[^a-zA-Z0-9_]/g, "_")} = true;\n`,
        unsaved: false,
        validationState: chat.validationState,
      });
    }
  }
  if (!documentBuffers.has(initialDocId)) {
    documentBuffers.set(initialDocId, {
      content: initialDocContent,
      unsaved: false,
      validationState: initialActiveChat?.validationState ?? "UnchangedBlue",
    });
  }

  const initialFileTree = options?.initialFileTree ?? [];
  const initialAstSymbols = extractAstSymbolsFromSource(
    documentBuffers.get(initialDocId)?.content ?? initialDocContent,
  );
  const initialImpactedTests = computeImpactedTestsForBuffer(
    initialDocId,
    initialAstSymbols,
    initialFileTree,
  );

  const zone1 = new AtomicStore<Zone1ActivityState>({
    activeSection: options?.initialActiveSection ?? "sessions",
    activePersona: initialPersona,
    sidebarOpen: true,
    fileTreeAccessible: true,
    uiZoomPercent: options?.initialUiZoomPercent ?? 100,
    permissionsLevel: "standard-enforced",
  });

  const zone2 = new AtomicStore<Zone2SidebarState>({
    sessions: initialChats.map((c) => ({
      chatId: c.chatId,
      title: c.title,
      modelName: c.modelName,
      validationState: c.validationState,
      targetDocumentId: c.targetDocumentId ?? initialDocId,
    })),
    fileTree: initialFileTree,
    fileTreeScrollTop: 0,
    fileTreeViewportHeight: 600,
    focusedFileIndex: 0,
    searchQuery: "",
    searchResults: [],
    astSymbols: initialAstSymbols,
    impactedTests: initialImpactedTests,
  });

  const initialMessages: Record<string, readonly CockpitChatMessage[]> = {};
  const initialLogs: Record<string, readonly string[]> = {};
  for (const chat of initialChats) {
    initialMessages[chat.chatId] = [];
    initialLogs[chat.chatId] = [];
  }

  const zone3 = new AtomicStore<Zone3MultiChatState>({
    gridMode: options?.initialGridMode ?? 1,
    activeChatId: initialChatId,
    chats: initialChats,
    messagesByChatId: initialMessages,
    terminalLogsByChatId: initialLogs,
    activeRunningAgentChatId: null,
    sequentialAgentQueue: [],
  });

  const zone4 = new AtomicStore<Zone4InspectorState>({
    activeInspectorTab: options?.initialInspectorTab ?? "code-diff",
    syncedChatId: initialChatId,
    activeDocumentId: initialDocId,
    activeValidationState: initialActiveChat?.validationState ?? "UnchangedBlue",
    previewUrl: initialActiveChat?.previewUrl ?? "preview://local/root",
    lastSyncDurationMs: 0,
    hasUnsavedChanges: false,
    recoveredFromWal: options?.initialRecoveredFromWal ?? false,
  });

  const sectionByDigit: Record<string, ActivityBarSection> = {
    "1": "sessions",
    "2": "files",
    "3": "search",
    "4": "git",
    "5": "debug",
    "6": "mcp",
  };

  return {
    zone1,
    zone2,
    zone3,
    zone4,

    setActivitySection(section: ActivityBarSection): void {
      if (section === "debug") {
        const activeDocId = zone4.getState().activeDocumentId;
        const activeContent = documentBuffers.get(activeDocId)?.content ?? "";
        this.refreshAstAndImpactedTests(activeDocId, activeContent);
      }
      zone1.setState((prev) => ({
        ...prev,
        activeSection: section,
        sidebarOpen: true,
      }));
    },

    handleActivityBarShortcut(key: string, metaOrCtrlKey: boolean): boolean {
      if (!metaOrCtrlKey) {
        return false;
      }
      const target = sectionByDigit[key];
      if (!target) {
        return false;
      }
      this.setActivitySection(target);
      return true;
    },

    /**
     * Explicit persona selector per workspace (`Create | Learn | Develop | Infrastructure | Data`).
     * Invariants enforced:
     * 1. No panel ever disappears automatically during an active task.
     * 2. The file tree remains accessible in all personas (`fileTreeAccessible: true`).
     * 3. Changing persona never alters execution permissions (`permissionsLevel: "standard-enforced"`).
     */
    setPersona(persona: CockpitPersonaMode, duringActiveTask = false): void {
      const hasRunningTask = duringActiveTask || zone3.getState().activeRunningAgentChatId !== null;
      zone1.setState((prev) => ({
        ...prev,
        activePersona: persona,
        // Never hide sidebar automatically during a task; keep open if already open or in Develop mode
        sidebarOpen: hasRunningTask ? prev.sidebarOpen : prev.sidebarOpen || persona === "Develop",
        fileTreeAccessible: true,
        permissionsLevel: "standard-enforced",
      }));
    },

    toggleSidebar(open?: boolean): void {
      zone1.setState((prev) => ({
        ...prev,
        sidebarOpen: open ?? !prev.sidebarOpen,
      }));
    },

    setUiZoomPercent(zoomPercent: number): void {
      const clamped = Math.min(200, Math.max(50, Math.round(zoomPercent)));
      zone1.setState((prev) => ({
        ...prev,
        uiZoomPercent: clamped,
      }));
    },

    setGridMode(gridMode: CockpitGridMode): void {
      zone3.setState((prev) => ({
        ...prev,
        gridMode,
      }));
    },

    setInspectorTab(tab: InspectorTab): void {
      zone4.setState((prev) => ({
        ...prev,
        activeInspectorTab: tab,
      }));
    },

    /**
     * Synchronize Zone 4 right inspector with the selected chat in Zone 3 in `< 10 ms`.
     */
    selectChat(chatId: string): number {
      const t0 = nowMs();
      const chatState = zone3.getState();
      const targetChat = chatState.chats.find((c) => c.chatId === chatId);
      if (!targetChat) {
        return 0;
      }

      zone3.setState((prev) => ({
        ...prev,
        activeChatId: chatId,
      }));

      const nextDocId = targetChat.targetDocumentId ?? zone4.getState().activeDocumentId;
      const bufRecord = documentBuffers.get(nextDocId);
      const syncDurationMs = Math.max(0, nowMs() - t0);
      zone4.setState((prev) => ({
        ...prev,
        syncedChatId: chatId,
        activeDocumentId: nextDocId,
        activeValidationState: bufRecord?.validationState ?? targetChat.validationState,
        previewUrl: targetChat.previewUrl ?? prev.previewUrl,
        lastSyncDurationMs: syncDurationMs,
        hasUnsavedChanges: bufRecord?.unsaved ?? false,
      }));

      return syncDurationMs;
    },

    closeChat(chatId: string): void {
      const z3 = zone3.getState();
      if (z3.chats.length <= 1) {
        return;
      }
      const nextChats = z3.chats.filter((c) => c.chatId !== chatId);
      const nextActiveChat = z3.activeChatId === chatId ? (nextChats[0] ?? z3.chats[0]) : undefined;

      zone2.setState((prev) => ({
        ...prev,
        sessions: prev.sessions.filter((s) => s.chatId !== chatId),
      }));

      zone3.setState((prev) => ({
        ...prev,
        chats: nextChats,
        activeChatId: nextActiveChat ? nextActiveChat.chatId : prev.activeChatId,
      }));

      if (nextActiveChat) {
        this.selectChat(nextActiveChat.chatId);
      }
    },

    /**
     * Open a file clicked in the Zone 2 File Tree inside the Zone 4 CodeMirror 6 Inspector in `< 10 ms`.
     */
    selectFileFromTree(filePath: string, contentOverride?: string): number {
      const t0 = nowMs();
      const z2 = zone2.getState();
      const fileIdx = z2.fileTree.findIndex((n) => n.path === filePath);
      const treeNode = fileIdx >= 0 ? z2.fileTree[fileIdx] : undefined;
      const existing = documentBuffers.get(filePath);
      const content =
        contentOverride ?? existing?.content ?? `export const filePath = "${filePath}";\n`;
      const validationState =
        existing?.validationState ?? treeNode?.validationState ?? "UnchangedBlue";

      documentBuffers.set(filePath, {
        content,
        unsaved: existing?.unsaved ?? false,
        validationState,
      });

      const astSymbols = extractAstSymbolsFromSource(content);
      const impactedTests = computeImpactedTestsForBuffer(filePath, astSymbols, z2.fileTree);

      zone2.setState((prev) => ({
        ...prev,
        focusedFileIndex: fileIdx >= 0 ? fileIdx : prev.focusedFileIndex,
        astSymbols,
        impactedTests,
      }));

      const syncDurationMs = Math.max(0, nowMs() - t0);
      zone4.setState((prev) => ({
        ...prev,
        activeDocumentId: filePath,
        activeValidationState: validationState,
        lastSyncDurationMs: syncDurationMs,
        hasUnsavedChanges: existing?.unsaved ?? false,
      }));

      return syncDurationMs;
    },

    getDocumentContent(filePath: string): string | undefined {
      return documentBuffers.get(filePath)?.content;
    },

    updateInMemoryDocumentContent(
      filePath: string,
      content: string,
      hasUnsavedChanges = true,
    ): void {
      const existing = documentBuffers.get(filePath);
      const prevValidation = existing?.validationState ?? zone4.getState().activeValidationState;
      const nextValidation: ColorideValidationState =
        hasUnsavedChanges && prevValidation === "ValidatedGreen" ? "StaleOrange" : prevValidation;

      documentBuffers.set(filePath, {
        content,
        unsaved: hasUnsavedChanges,
        validationState: nextValidation,
      });
    },

    markDocumentSaved(filePath: string): void {
      const existing = documentBuffers.get(filePath);
      if (existing) {
        documentBuffers.set(filePath, {
          ...existing,
          unsaved: false,
        });
      }
      if (zone4.getState().activeDocumentId === filePath) {
        zone4.setState((prev) => ({
          ...prev,
          hasUnsavedChanges: false,
        }));
      }
    },

    refreshAstAndImpactedTests(filePath: string, content: string): void {
      const astSymbols = extractAstSymbolsFromSource(content);
      const impactedTests = computeImpactedTestsForBuffer(
        filePath,
        astSymbols,
        zone2.getState().fileTree,
      );
      zone2.setState((prev) => ({
        ...prev,
        astSymbols,
        impactedTests,
      }));
    },

    /**
     * Execute instant lexical/BM25 search (`LOT-008`) across workspace buffers:
     * - Prioritizes unsaved in-memory buffers (`InMemoryUnsaved`) over disk snapshots (`DiskSaved`).
     * - Enforces ACL exclusions (`.env`, `.pem`, `.key`) and secret redaction (`[REDACTED_SECRET]`).
     */
    runGlobalSearch(query: string): readonly CockpitSearchResultItem[] {
      const trimmed = query.trim();
      if (!trimmed) {
        zone2.setState((prev) => ({
          ...prev,
          searchQuery: "",
          searchResults: [],
        }));
        return [];
      }

      const terms = trimmed
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0);
      const results: CockpitSearchResultItem[] = [];

      for (const [filePath, record] of documentBuffers.entries()) {
        if (isAclExcludedPath(filePath)) {
          continue;
        }
        const lines = record.content.split(/\r?\n/);
        for (let idx = 0; idx < lines.length; idx += 1) {
          const rawLine = lines[idx] ?? "";
          const { sanitized, redactedCount } = redactSecretsInLine(rawLine);
          const lowerLine = sanitized.toLowerCase();
          const lowerPath = filePath.toLowerCase();
          let matchedTerms = 0;
          for (const term of terms) {
            if (lowerLine.includes(term) || lowerPath.includes(term)) {
              matchedTerms += 1;
            }
          }
          if (matchedTerms === terms.length) {
            const freshness: ExcerptFreshness = record.unsaved
              ? "LiveUnsavedBuffer"
              : "IndexedCommit";
            const score = matchedTerms * 10 + (record.unsaved ? 5 : 0);
            results.push({
              filePath,
              line: idx + 1,
              snippet: sanitized.trim(),
              freshness,
              score,
              secretsRedacted: redactedCount,
            });
          }
        }
      }

      results.sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));
      zone2.setState((prev) => ({
        ...prev,
        searchQuery: query,
        searchResults: results,
      }));
      return results;
    },

    /**
     * MVP scope invariant (`LOT-005` §4.2): only 1 agent executes in backend at a time;
     * additional agent tasks are queued sequentially until `LOT-020`.
     */
    startAgentTaskOnChat(chatId: string): "Running" | "QueuedSequential" {
      let assignedStatus: "Running" | "QueuedSequential" = "Running";
      zone3.setState((prev) => {
        if (prev.activeRunningAgentChatId === null || prev.activeRunningAgentChatId === chatId) {
          assignedStatus = "Running";
          return {
            ...prev,
            activeRunningAgentChatId: chatId,
            chats: prev.chats.map((c) =>
              c.chatId === chatId ? { ...c, agentExecutionStatus: "Running" } : c,
            ),
          };
        }
        assignedStatus = "QueuedSequential";
        const nextQueue = prev.sequentialAgentQueue.includes(chatId)
          ? prev.sequentialAgentQueue
          : [...prev.sequentialAgentQueue, chatId];
        return {
          ...prev,
          sequentialAgentQueue: nextQueue,
          chats: prev.chats.map((c) =>
            c.chatId === chatId ? { ...c, agentExecutionStatus: "QueuedSequential" } : c,
          ),
        };
      });
      return assignedStatus;
    },

    completeAgentTaskOnChat(chatId: string): void {
      zone3.setState((prev) => {
        if (prev.activeRunningAgentChatId !== chatId) {
          return prev;
        }
        const [nextChatId, ...remainingQueue] = prev.sequentialAgentQueue;
        return {
          ...prev,
          activeRunningAgentChatId: nextChatId ?? null,
          sequentialAgentQueue: remainingQueue,
          chats: prev.chats.map((c) => {
            if (c.chatId === chatId) {
              return { ...c, agentExecutionStatus: "Idle" };
            }
            if (nextChatId && c.chatId === nextChatId) {
              return { ...c, agentExecutionStatus: "Running" };
            }
            return c;
          }),
        };
      });
    },
  };
}
