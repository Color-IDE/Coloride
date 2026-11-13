import {
  type WorkspaceNavigationActions,
  type WorkspaceNavigationState,
  createWorkspaceNavigation,
} from "./workspace-navigation.js";
export type { WorkGroup, WorkspaceNavigationState } from "./workspace-navigation.js";
export { resolveGroupLayout } from "./workspace-navigation.js";
import type {
  ColorideValidationState,
  ConfidenceLevel,
  ExcerptFreshness,
} from "@coloride/protocol-types";
import { AtomicStore } from "./atomic-store.js";
import {
  extractSymbolsHeuristically,
  inferImpactedTestsHeuristically,
} from "./cockpit-analysis.js";
import { isSecretBearingPath, redactSecretsInLine } from "./security/secrets.js";

export {
  extractSymbolsHeuristically as extractAstSymbolsFromSource,
  inferImpactedTestsHeuristically as computeImpactedTestsForBuffer,
} from "./cockpit-analysis.js";
export { AtomicStore, type StoreListener } from "./atomic-store.js";
export { COLORIDE_DESIGN_TOKENS, type DesignStateTokens } from "./design-state-tokens.js";

export type CockpitPersonaMode = "Create" | "Learn" | "Develop" | "Infrastructure" | "Data";

export type ActivityBarSection = "sessions" | "files" | "search" | "git" | "debug" | "mcp";

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

export interface CockpitStoreBundle extends WorkspaceNavigationActions {
  renameChat(id: string, title: string): void;
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

export function createCockpitStoreBundle(options?: {
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
}): CockpitStoreBundle {
  const initialPersona = options?.initialPersona ?? "Develop";
  const initialChats: readonly CockpitChatTab[] = options?.initialChats ?? [
    {
      chatId: "chat-1",
      title: "#1 Login UI",
      modelName: "Codex",
      validationState: "UnchangedBlue",
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
  const initialAstSymbols = extractSymbolsHeuristically(
    documentBuffers.get(initialDocId)?.content ?? initialDocContent,
  );
  const initialImpactedTests = inferImpactedTestsHeuristically(
    initialDocId,
    initialAstSymbols,
    initialFileTree,
  );

  const zone1 = new AtomicStore<Zone1ActivityState>({
    activeSection: options?.initialActiveSection ?? "sessions",
    activePersona: initialPersona,
    sidebarOpen: true,
    inspectorOpen: true,
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

  const navigationActions = createWorkspaceNavigation(
    options?.initialNavigation,
    initialChats.map((chat) => chat.chatId),
    () => zone3.getState().chats.map((chat) => chat.chatId),
    (chatId) => bundle.selectChat(chatId),
  );
  const { navigation } = navigationActions;

  const sectionByDigit: Record<string, ActivityBarSection> = {
    "1": "sessions",
    "2": "files",
    "3": "search",
    "4": "git",
    "5": "debug",
    "6": "mcp",
  };

  const bundle: CockpitStoreBundle = {
    ...navigationActions,
    renameChat(id: string, title: string): void {
      const trimmed = title.trim();
      if (
        !trimmed ||
        !zone3.getState().chats.some((chat) => chat.chatId === id && chat.title !== trimmed)
      )
        return;
      zone3.setState((prev) => ({
        ...prev,
        chats: prev.chats.map((chat) => (chat.chatId === id ? { ...chat, title: trimmed } : chat)),
      }));
      zone2.setState((prev) => ({
        ...prev,
        sessions: prev.sessions.map((session) =>
          session.chatId === id ? { ...session, title: trimmed } : session,
        ),
      }));
    },
    zone1,
    zone2,
    zone3,
    zone4,

    setFileTree(fileTree: readonly CockpitFileTreeNode[]): void {
      zone2.setState((prev) => ({
        ...prev,
        fileTree,
        focusedFileIndex: 0,
        fileTreeScrollTop: 0,
      }));
    },

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

    toggleInspector(open?: boolean): void {
      zone1.setState((prev) => ({
        ...prev,
        inspectorOpen: open ?? !prev.inspectorOpen,
      }));
    },

    setUiZoomPercent(zoomPercent: number): void {
      const clamped = Math.min(200, Math.max(50, Math.round(zoomPercent)));
      zone1.setState((prev) => ({
        ...prev,
        uiZoomPercent: clamped,
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
      const t0 = performance.now();
      const chatState = zone3.getState();
      const targetChat = chatState.chats.find((c) => c.chatId === chatId);
      if (!targetChat) {
        return 0;
      }

      const currentNavigation = navigation.getState();
      const group = currentNavigation.groups.find((group) => group.chatIds.includes(chatId));
      if (
        group &&
        (currentNavigation.activeGroupId !== group.id || group.lastActiveChatId !== chatId)
      ) {
        navigation.setState((prev) => ({
          ...prev,
          activeGroupId: group.id,
          groups: prev.groups.map((item) =>
            item.id === group.id ? { ...item, lastActiveChatId: chatId } : item,
          ),
        }));
      }
      if (chatState.activeChatId !== chatId)
        zone3.setState((prev) => ({ ...prev, activeChatId: chatId }));

      const nextDocId = targetChat.targetDocumentId ?? zone4.getState().activeDocumentId;
      const bufRecord = documentBuffers.get(nextDocId);
      const syncDurationMs = Math.max(0, performance.now() - t0);
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
      const group = navigation.getState().groups.find((group) => group.chatIds.includes(chatId));
      const nextActiveChat =
        z3.activeChatId === chatId
          ? (nextChats.find((chat) => group?.chatIds.includes(chat.chatId)) ?? nextChats[0])
          : undefined;

      zone2.setState((prev) => ({
        ...prev,
        sessions: prev.sessions.filter((s) => s.chatId !== chatId),
      }));

      zone3.setState((prev) => ({
        ...prev,
        chats: nextChats,
        activeChatId: nextActiveChat ? nextActiveChat.chatId : prev.activeChatId,
      }));

      navigation.setState((prev) => ({
        ...prev,
        groups: prev.groups.map((group) =>
          group.chatIds.includes(chatId)
            ? {
                ...group,
                chatIds: group.chatIds.filter((id) => id !== chatId),
                lastActiveChatId:
                  group.lastActiveChatId === chatId
                    ? group.chatIds.find((id) => id !== chatId)
                    : group.lastActiveChatId,
              }
            : group,
        ),
      }));
      if (nextActiveChat) {
        this.selectChat(nextActiveChat.chatId);
      }
    },

    /**
     * Open a file clicked in the Zone 2 File Tree inside the Zone 4 CodeMirror 6 Inspector in `< 10 ms`.
     */
    selectFileFromTree(filePath: string, contentOverride?: string): number {
      const t0 = performance.now();
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

      const astSymbols = extractSymbolsHeuristically(content);
      const impactedTests = inferImpactedTestsHeuristically(filePath, astSymbols, z2.fileTree);

      zone2.setState((prev) => ({
        ...prev,
        focusedFileIndex: fileIdx >= 0 ? fileIdx : prev.focusedFileIndex,
        astSymbols,
        impactedTests,
      }));

      const syncDurationMs = Math.max(0, performance.now() - t0);
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

    isDocumentUnsaved(filePath: string): boolean {
      return documentBuffers.get(filePath)?.unsaved ?? false;
    },

    discardDocumentBuffer(filePath: string): void {
      documentBuffers.delete(filePath);
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
      const astSymbols = extractSymbolsHeuristically(content);
      const impactedTests = inferImpactedTestsHeuristically(
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
        if (isSecretBearingPath(filePath)) {
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

    setGlobalSearchResults(query: string, results: readonly CockpitSearchResultItem[]): void {
      zone2.setState((prev) => ({
        ...prev,
        searchQuery: query,
        searchResults: results,
      }));
    },

    setAstAnalysis(
      astSymbols: readonly CockpitAstSymbolItem[],
      impactedTests: readonly CockpitImpactedTestItem[],
    ): void {
      zone2.setState((prev) => ({
        ...prev,
        astSymbols,
        impactedTests,
      }));
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
  return bundle;
}
