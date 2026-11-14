import {
  extractSymbolsHeuristically,
  inferImpactedTestsHeuristically,
} from "../analysis/cockpit-analysis.js";
import { AtomicStore } from "../state/atomic-store.js";
import type { DocumentBuffers } from "./documents.js";
import { ACTIVITY_BAR_SECTIONS } from "./types.js";
import type {
  CockpitChatMessage,
  CockpitChatTab,
  CockpitStoreOptions,
  Zone1ActivityState,
  Zone2SidebarState,
  Zone3MultiChatState,
  Zone4InspectorState,
} from "./types.js";

/** The four zone stores and the document buffers, seeded from the options. */
export function createInitialStores(options?: CockpitStoreOptions) {
  const initialPersona = options?.initialPersona ?? "Develop";
  const initialChats: readonly CockpitChatTab[] = options?.initialChats ?? [
    {
      kind: "agent" as const,
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

  const documents: DocumentBuffers = new Map();
  for (const chat of initialChats) {
    if (chat.targetDocumentId) {
      documents.set(chat.targetDocumentId, {
        content:
          chat.targetDocumentContent ??
          `export const ${chat.chatId.replace(/[^a-zA-Z0-9_]/g, "_")} = true;\n`,
        unsaved: false,
        validationState: chat.validationState,
      });
    }
  }
  if (!documents.has(initialDocId)) {
    documents.set(initialDocId, {
      content: initialDocContent,
      unsaved: false,
      validationState: initialActiveChat?.validationState ?? "UnchangedBlue",
    });
  }

  const initialFileTree = options?.initialFileTree ?? [];
  const initialAstSymbols = extractSymbolsHeuristically(
    documents.get(initialDocId)?.content ?? initialDocContent,
  );
  const initialImpactedTests = inferImpactedTestsHeuristically(
    initialDocId,
    initialAstSymbols,
    initialFileTree,
  );

  const zone1 = new AtomicStore<Zone1ActivityState>({
    // A cache written by an older version may name a section that no longer exists.
    activeSection:
      options?.initialActiveSection && ACTIVITY_BAR_SECTIONS.includes(options.initialActiveSection)
        ? options.initialActiveSection
        : "sessions",
    activePersona: initialPersona,
    sidebarOpen: true,
    // Closed at launch: the code editor panel opens when the user opens a file or toggles it.
    inspectorOpen: false,
    fileTreeAccessible: true,
    uiZoomPercent: options?.initialUiZoomPercent ?? 100,
    permissionsLevel: "standard-enforced",
  });

  const zone2 = new AtomicStore<Zone2SidebarState>({
    sessions: initialChats
      .filter((c) => c.kind === "agent")
      .map((c) => ({
        kind: "agent" as const,
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

  return { zone1, zone2, zone3, zone4, documents, initialChats };
}
