import { describe, expect, it } from "vitest";
import { panelIds } from "../layout/layout-tree.js";
import { createCockpitStoreBundle, resolveGroupLayout, resolveGroupMaximized } from "./index.js";

const chat = (chatId: string, modelName = "Codex") => ({
  kind: "agent" as const,
  chatId,
  title: chatId,
  modelName,
  validationState: "UnchangedBlue" as const,
});

function setup() {
  const stores = createCockpitStoreBundle({
    initialChats: [chat("a", "Claude"), chat("b")],
  });
  const layout = () =>
    panelIds(resolveGroupLayout(stores.navigation.getState().groups[0] as never)).sort();
  return { stores, layout };
}

describe("store.createChat", () => {
  it("creates a session in the active tab, places it in the layout and selects it", () => {
    const { stores, layout } = setup();
    const id = stores.createChat();
    expect(id).toBe("chat-3");
    expect(layout()).toEqual(["a", "b", "chat-3"]);
    const created = stores.zone3.getState().chats.find((c) => c.chatId === id);
    expect(created).toMatchObject({ title: "#3 New session", validationState: "UnchangedBlue" });
    expect(stores.zone3.getState().activeChatId).toBe(id);
    expect(stores.zone3.getState().messagesByChatId[id as string]).toEqual([]);
    expect(stores.zone2.getState().sessions.some((s) => s.chatId === id)).toBe(true);
    expect(stores.navigation.getState().groups[0]?.lastActiveChatId).toBe(id);
  });

  it("splits a chosen panel in a chosen direction and copies its model", () => {
    const { stores } = setup();
    const id = stores.createChat({ from: "a", direction: "column", position: "before" });
    expect(stores.zone3.getState().chats.find((c) => c.chatId === id)?.modelName).toBe("Claude");
    const group = stores.navigation.getState().groups[0];
    const root = resolveGroupLayout(group as never);
    // a, b side by side; the new panel went above a: a's column is [new, a].
    expect(panelIds(root)).toEqual([id, "a", "b"]);
  });

  it("creates in another tab without touching the active one", () => {
    const { stores } = setup();
    stores.createWorkGroup("Other");
    const other = stores.navigation.getState().groups[1]?.id as string;
    const id = stores.createChat({ groupId: other });
    expect(stores.navigation.getState().groups[1]?.chatIds).toEqual([id]);
    expect(stores.navigation.getState().groups[0]?.chatIds).toEqual(["a", "b"]);
    expect(stores.createChat({ groupId: "missing" })).toBeNull();
  });

  it("refuses a panel that would not fit the measured area, and allows it with room or no size", () => {
    const { stores, layout } = setup();
    stores.setPanelArea({ widthPx: 440, heightPx: 270 });
    // Two 220x270 panels fit, but splitting either would give 220x135 (< 140 high).
    expect(stores.canCreateChat()).toBe(false);
    expect(stores.createChat()).toBeNull();
    expect(layout()).toEqual(["a", "b"]);

    stores.setPanelArea({ widthPx: 1400, heightPx: 900 });
    expect(stores.canCreateChat()).toBe(true);
    expect(stores.createChat()).not.toBeNull();

    stores.setPanelArea(null);
    expect(stores.canCreateChat({ from: "a", direction: "row" })).toBe(true);
    stores.setPanelArea({ widthPx: 0, heightPx: 0 });
    expect(stores.canCreateChat()).toBe(true);
  });

  it("keeps creating ids unique after sessions are closed", () => {
    const { stores } = setup();
    const first = stores.createChat();
    stores.closeChat("a");
    const second = stores.createChat();
    expect(second).not.toBe(first);
    expect(new Set(stores.zone3.getState().chats.map((c) => c.chatId)).size).toBe(
      stores.zone3.getState().chats.length,
    );
  });
});

describe("store.toggleMaximizeChat", () => {
  const maximized = (stores: ReturnType<typeof setup>["stores"], index = 0) =>
    resolveGroupMaximized(stores.navigation.getState().groups[index] as never);

  it("shows one session alone, selects it, and restores the tab on the second call", () => {
    const { stores } = setup();
    stores.toggleMaximizeChat("b");
    expect(maximized(stores)).toBe("b");
    expect(stores.zone3.getState().activeChatId).toBe("b");
    stores.toggleMaximizeChat("b");
    expect(maximized(stores)).toBeNull();
  });

  it("follows the selected session while maximized, so the header tabs switch between them", () => {
    const { stores } = setup();
    stores.toggleMaximizeChat("a");
    stores.selectChat("b");
    expect(maximized(stores)).toBe("b");
    // Not maximized: selecting never maximizes.
    stores.toggleMaximizeChat("b");
    stores.selectChat("a");
    expect(maximized(stores)).toBeNull();
  });

  it("goes back to the tiled layout when a session is created, so the new panel is seen", () => {
    const { stores } = setup();
    stores.toggleMaximizeChat("a");
    const id = stores.createChat({ from: "a", direction: "row" });
    expect(maximized(stores)).toBeNull();
    expect(stores.zone3.getState().activeChatId).toBe(id);
  });

  it("restores the tab when the maximized session is closed, and keeps it when another one is", () => {
    const { stores } = setup();
    stores.createChat();
    stores.toggleMaximizeChat("b");
    stores.closeChat("chat-3");
    expect(maximized(stores)).toBe("b");
    stores.closeChat("b");
    expect(maximized(stores)).toBeNull();
  });

  it("keeps the state per tab and ignores a stale or unknown session", () => {
    const { stores } = setup();
    stores.toggleMaximizeChat("a");
    stores.createWorkGroup("Other");
    expect(maximized(stores, 1)).toBeNull();
    // An unknown chat is ignored, and a stored id that is not in the tab does not count.
    stores.toggleMaximizeChat("nope");
    expect(maximized(stores, 0)).toBe("a");
    const group = stores.navigation.getState().groups[0] as never as { chatIds: string[] };
    expect(
      resolveGroupMaximized({ ...group, id: "x", title: "x", maximizedChatId: "gone" } as never),
    ).toBeNull();
  });
});
