import { expect, it } from "vitest";
import { restoreCachedSession } from "./session-cache.js";
import { createCockpitStoreBundle } from "./stores/index.js";
const base = { chatId: "legacy", title: "My session", validationState: "UnchangedBlue" };
it("normalizes legacy agents and shells, and strips model/execution state from terminals", () => {
  expect(restoreCachedSession({ ...base, modelName: "Codex" })).toMatchObject({
    kind: "agent",
    modelName: "Codex",
  });
  expect(restoreCachedSession({ ...base, modelName: "Shell" })).toEqual({
    ...base,
    kind: "terminal",
  });
  expect(
    restoreCachedSession({
      ...base,
      kind: "terminal",
      modelName: "Codex",
      agentExecutionStatus: "Running",
    }),
  ).toEqual({ ...base, kind: "terminal" });
  expect(() => restoreCachedSession({ ...base, kind: "unexpected" })).toThrow();
  expect(() => restoreCachedSession({ ...base, kind: "agent" })).toThrow();
});
it("creates explicit sessions, excludes terminals from the agent list and refuses terminal agent tasks", () => {
  const stores = createCockpitStoreBundle();
  const terminal = stores.createChat({ kind: "terminal" });
  const chat = stores.zone3.getState().chats.find((c) => c.chatId === terminal);
  expect(chat).toMatchObject({ kind: "terminal" });
  expect(chat).not.toHaveProperty("modelName");
  expect(stores.zone2.getState().sessions.some((c) => c.chatId === terminal)).toBe(false);
  expect(() => stores.startAgentTaskOnChat(terminal as string)).toThrow("Only agent sessions");
  const agent = stores.createChat();
  expect(stores.zone3.getState().chats.find((c) => c.chatId === agent)).toMatchObject({
    kind: "agent",
    modelName: "Codex",
  });
});
