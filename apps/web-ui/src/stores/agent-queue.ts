import type { StoreContext } from "./context.js";
import type { CockpitStoreBundle } from "./types.js";

type AgentQueueActions = Pick<
  CockpitStoreBundle,
  "startAgentTaskOnChat" | "completeAgentTaskOnChat"
>;

/**
 * MVP scope invariant (`LOT-005` §4.2): only 1 agent executes in backend at a time;
 * additional agent tasks are queued sequentially until `LOT-020`.
 */
export function createAgentQueueActions(ctx: StoreContext): AgentQueueActions {
  const { zone3 } = ctx;
  return {
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
