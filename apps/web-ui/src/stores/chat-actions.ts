import {
  type AreaSize,
  DEFAULT_LAYOUT_ASPECT,
  type SplitDirection,
  type SplitPosition,
  addPanel,
  placePanel,
} from "../layout/layout-tree.js";
import { resolveGroupLayout, resolveGroupMaximized } from "../state/workspace-navigation.js";
import type { StoreContext } from "./context.js";
import type { CockpitChatTab, CockpitStoreBundle, CreateChatOptions } from "./types.js";

type ChatActions = Pick<
  CockpitStoreBundle,
  | "createChat"
  | "canCreateChat"
  | "toggleMaximizeChat"
  | "setPanelArea"
  | "getPanelArea"
  | "renameChat"
  | "selectChat"
  | "closeChat"
>;

/** Zone 3 sessions: creating them into a tab's layout, selecting (syncing Zone 4), renaming, closing. */
export function createChatActions(ctx: StoreContext): ChatActions {
  const { zone2, zone3, zone4, navigation, documents } = ctx;
  let panelArea: AreaSize | null = null;

  /** Where and whether a new panel fits in a tab; null when it does not. */
  const planNewPanel = (options: CreateChatOptions | undefined, chatId: string) => {
    const state = navigation.getState();
    const group = state.groups.find(
      (item) => item.id === (options?.groupId ?? state.activeGroupId),
    );
    if (!group) return null;
    const current = resolveGroupLayout(group);
    const place = (placement: {
      target?: string;
      direction?: SplitDirection;
      position?: SplitPosition;
    }) =>
      // Without a measured area (not laid out yet) any placement is accepted.
      panelArea
        ? placePanel(current, chatId, panelArea, placement)
        : addPanel(current, chatId, { ...placement, aspect: DEFAULT_LAYOUT_ASPECT });
    const active = zone3.getState().activeChatId;
    const anchor = group.chatIds.includes(active) ? active : group.lastActiveChatId;
    const inOrder =
      options?.nextToActive && !options.from && anchor && group.chatIds.includes(anchor)
        ? place({ target: anchor, direction: "row", position: "after" })
        : null;
    const layout =
      inOrder ??
      place({
        ...(options?.from ? { target: options.from } : {}),
        ...(options?.direction ? { direction: options.direction } : {}),
        ...(options?.position ? { position: options.position } : {}),
      });
    if (!layout) return null;
    return { group, layout };
  };

  const nextChatId = () => {
    const taken = new Set(zone3.getState().chats.map((chat) => chat.chatId));
    let n = taken.size + 1;
    while (taken.has(`chat-${n}`)) n += 1;
    return `chat-${n}`;
  };

  /**
   * Synchronize Zone 4 right inspector with the selected chat in Zone 3 in `< 10 ms`.
   */
  const selectChat = (chatId: string): number => {
    const t0 = performance.now();
    const chatState = zone3.getState();
    const targetChat = chatState.chats.find((c) => c.chatId === chatId);
    if (!targetChat) {
      return 0;
    }

    const currentNavigation = navigation.getState();
    const group = currentNavigation.groups.find((group) => group.chatIds.includes(chatId));
    // While a session is shown alone, selecting another one (a header tab) shows that one.
    const maximizedFollows = !!group && resolveGroupMaximized(group) !== null;
    if (
      group &&
      (currentNavigation.activeGroupId !== group.id ||
        group.lastActiveChatId !== chatId ||
        (maximizedFollows && group.maximizedChatId !== chatId))
    ) {
      navigation.setState((prev) => ({
        ...prev,
        activeGroupId: group.id,
        groups: prev.groups.map((item) =>
          item.id === group.id
            ? {
                ...item,
                lastActiveChatId: chatId,
                ...(maximizedFollows ? { maximizedChatId: chatId } : {}),
              }
            : item,
        ),
      }));
    }
    if (chatState.activeChatId !== chatId)
      zone3.setState((prev) => ({ ...prev, activeChatId: chatId }));

    // A shell has no document or validation state: the inspector keeps what it shows.
    if (targetChat.kind === "terminal") return Math.max(0, performance.now() - t0);

    const nextDocId = targetChat.targetDocumentId ?? zone4.getState().activeDocumentId;
    const bufRecord = documents.get(nextDocId);
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
  };

  return {
    setPanelArea(area: AreaSize | null): void {
      panelArea = area && area.widthPx > 0 && area.heightPx > 0 ? area : null;
    },

    getPanelArea(): AreaSize | null {
      return panelArea;
    },

    toggleMaximizeChat(chatId: string): void {
      const group = navigation.getState().groups.find((item) => item.chatIds.includes(chatId));
      if (!group) return;
      const alone = resolveGroupMaximized(group) === chatId;
      navigation.setState((prev) => ({
        ...prev,
        groups: prev.groups.map((item) =>
          item.id === group.id ? { ...item, maximizedChatId: alone ? null : chatId } : item,
        ),
      }));
      // The session shown alone is the selected one (Zone 4 follows it).
      if (!alone) selectChat(chatId);
    },

    canCreateChat(options?: CreateChatOptions): boolean {
      return planNewPanel(options, "\u0000candidate") !== null;
    },

    createChat(options?: CreateChatOptions): string | null {
      const chatId = nextChatId();
      const plan = planNewPanel(options, chatId);
      if (!plan) return null;
      const z3 = zone3.getState();
      const neighbour = z3.chats.find((chat) => chat.chatId === (options?.from ?? z3.activeChatId));
      // A new session takes the model of the one next to it, but a shell has no model to share.
      const sibling = neighbour?.kind === "terminal" ? undefined : neighbour;
      const kind = options?.kind ?? "agent";
      const chat: CockpitChatTab =
        kind === "terminal"
          ? {
              chatId,
              kind,
              title:
                options?.title?.trim() ||
                `Terminal${z3.chats.filter((item) => item.kind === "terminal").length > 0 ? ` ${z3.chats.filter((item) => item.kind === "terminal").length + 1}` : ""}`,
              validationState: "UnchangedBlue",
            }
          : {
              chatId,
              kind: "agent",
              title: options?.title?.trim() || `#${z3.chats.length + 1} New session`,
              modelName: options?.modelName ?? sibling?.modelName ?? "Codex",
              validationState: "UnchangedBlue",
              agentExecutionStatus: "Idle",
            };
      zone3.setState((prev) => ({
        ...prev,
        chats: [...prev.chats, chat],
        messagesByChatId: { ...prev.messagesByChatId, [chatId]: [] },
        terminalLogsByChatId: { ...prev.terminalLogsByChatId, [chatId]: [] },
      }));
      // The sidebar lists agent sessions; a shell is only a panel.
      if (chat.kind === "agent") {
        zone2.setState((prev) => ({
          ...prev,
          sessions: [
            ...prev.sessions,
            {
              kind: "agent" as const,
              chatId,
              title: chat.title,
              modelName: chat.modelName,
              validationState: chat.validationState,
              targetDocumentId: zone4.getState().activeDocumentId,
            },
          ],
        }));
      }
      navigation.setState((prev) => ({
        ...prev,
        groups: prev.groups.map((group) =>
          group.id === plan.group.id
            ? {
                ...group,
                chatIds: [...group.chatIds, chatId],
                layout: plan.layout,
                // A new panel is only seen in the tiled layout.
                maximizedChatId: null,
              }
            : group,
        ),
      }));
      selectChat(chatId);
      return chatId;
    },

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

    selectChat,

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
                maximizedChatId: group.maximizedChatId === chatId ? null : group.maximizedChatId,
                lastActiveChatId:
                  group.lastActiveChatId === chatId
                    ? group.chatIds.find((id) => id !== chatId)
                    : group.lastActiveChatId,
              }
            : group,
        ),
      }));
      if (nextActiveChat) {
        selectChat(nextActiveChat.chatId);
      }
    },
  };
}
