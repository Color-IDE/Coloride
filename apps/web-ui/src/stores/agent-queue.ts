import type { StoreContext } from "./context.js";
import type { CockpitStoreBundle } from "./types.js";

type AgentQueueActions = Pick<
  CockpitStoreBundle,
  "startAgentTaskOnChat" | "completeAgentTaskOnChat"
>;

/**
 * UI scheduling intent only: records one running slot and a sequential queue.
 * This module never starts a process. Actual execution requires the future operational
 * PolicyEngine and sandbox-runner; their health checks currently report unavailable.
 */
export function createAgentQueueActions(ctx: StoreContext): AgentQueueActions {
  const { zone3 } = ctx;
  return {
    startAgentTaskOnChat(chatId: string): "Running" | "QueuedSequential" {
      if (!zone3.getState().chats.some((chat) => chat.chatId === chatId && chat.kind === "agent")) {
        throw new Error("Only agent sessions can enter the agent queue");
      }
      let assignedStatus: "Running" | "QueuedSequential" = "Running";
      zone3.setState((prev) => {
        if (prev.activeRunningAgentChatId === null || prev.activeRunningAgentChatId === chatId) {
          assignedStatus = "Running";
          return {
            ...prev,
            activeRunningAgentChatId: chatId,
            chats: prev.chats.map((c) =>
              c.kind === "agent" && c.chatId === chatId
                ? { ...c, agentExecutionStatus: "Running" }
                : c,
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
            c.kind === "agent" && c.chatId === chatId
              ? { ...c, agentExecutionStatus: "QueuedSequential" }
              : c,
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
            if (c.kind !== "agent") return c;
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
