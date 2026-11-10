import { COLORIDE_STATE_META, type ColorideValidationState } from "@coloride/protocol-types";

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

export interface Zone2SidebarState {
  readonly sessions: readonly CockpitSessionSummary[];
  readonly fileTree: readonly CockpitFileTreeNode[];
  readonly fileTreeScrollTop: number;
  readonly fileTreeViewportHeight: number;
  readonly focusedFileIndex: number;
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
  startAgentTaskOnChat(chatId: string): "Running" | "QueuedSequential";
  completeAgentTaskOnChat(chatId: string): void;
}

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
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
    fileTree: options?.initialFileTree ?? [],
    fileTreeScrollTop: 0,
    fileTreeViewportHeight: 600,
    focusedFileIndex: 0,
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

      const syncDurationMs = Math.max(0, nowMs() - t0);
      zone4.setState((prev) => ({
        ...prev,
        syncedChatId: chatId,
        activeDocumentId: targetChat.targetDocumentId ?? prev.activeDocumentId,
        activeValidationState: targetChat.validationState,
        previewUrl: targetChat.previewUrl ?? prev.previewUrl,
        lastSyncDurationMs: syncDurationMs,
      }));

      return syncDurationMs;
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
