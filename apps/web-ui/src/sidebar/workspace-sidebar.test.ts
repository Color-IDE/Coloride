// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCockpitStoreBundle } from "../stores.js";
import { FrameBatchedStreamRenderer } from "../stream-renderer.js";
import { WorkspaceSidebar } from "./workspace-sidebar.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function setup(openWorkspace?: () => Promise<readonly [] | null>) {
  const stores = createCockpitStoreBundle({
    initialChats: [
      {
        chatId: "a",
        title: "Implementation",
        modelName: "Codex",
        validationState: "UnchangedBlue",
      },
      { chatId: "b", title: "Review", modelName: "Claude", validationState: "UnchangedBlue" },
    ],
  });
  stores.setProjectPath("/projects/Coloride");
  const root = document.createElement("aside");
  const controlsHost = document.createElement("div");
  const treeHost = document.createElement("div");
  root.append(controlsHost, treeHost);
  document.body.appendChild(root);
  const sidebar = new WorkspaceSidebar({
    stores,
    controlsHost,
    treeHost,
    ...(openWorkspace ? { openWorkspace } : {}),
  });
  cleanup.push(() => {
    sidebar.destroy();
    root.remove();
  });
  const get = (selector: string) => {
    const el = root.querySelector<HTMLButtonElement>(selector);
    if (!el) throw new Error(`Missing ${selector}`);
    return el;
  };
  return { root, stores, sidebar, get, treeHost };
}

describe("Workspace sidebar", () => {
  it("preserves row nodes and focus through selection, collapse, rename and adding another group", () => {
    const { stores, get } = setup();
    const session = get('button[data-chat-id="b"]');
    const toggle = get(".sidebar-group-toggle");
    session.focus();
    session.click();
    expect(document.activeElement).toBe(session);
    stores.renameChat("a", "New implementation title");
    stores.createWorkGroup("Other task");
    stores.selectWorkGroup("initial-group");
    expect(stores.zone3.getState().activeChatId).toBe("b");
    expect(get('button[data-chat-id="b"]')).toBe(session);
    expect(document.activeElement).toBe(session);
    toggle.focus();
    toggle.click();
    expect(get(".sidebar-group-toggle")).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("makes no sidebar DOM mutations during token/log streaming or unrelated file-tree updates", () => {
    const { stores, treeHost } = setup();
    const observer = new MutationObserver(() => {});
    observer.observe(treeHost, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const stream = new FrameBatchedStreamRenderer(stores.zone3, () => {});
    for (let i = 0; i < 30; i++) {
      stream.enqueueToken("a", "reply", "word ");
      stream.enqueueTerminalLog("a", "test log");
      stream.flushNow();
    }
    stores.setFileTree([]);
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
  });

  it("opens independent group menus without changing selection or expansion, and supports Escape", () => {
    const { stores, get } = setup();
    stores.createWorkGroup("Other task");
    const more = get(
      '.sidebar-group[data-group-id="initial-group"] .sidebar-row--group .sidebar-more',
    );
    more.click();
    expect(stores.navigation.getState().activeGroupId).not.toBe("initial-group");
    expect(stores.navigation.getState().groups[0]?.expanded).not.toBe(false);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const rename = get('[role="menuitem"]');
    expect(document.activeElement).toBe(rename);
    rename.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect((document.activeElement as HTMLElement)?.textContent).toBe("Collapse group");
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(more);
    expect(more.getAttribute("aria-expanded")).toBe("false");
  });

  it("renames a group through its menu, without rebuilding its row or header hierarchy", () => {
    const { stores, get, root } = setup();
    const row = get('button[data-group-id="initial-group"]');
    get(".sidebar-row--group .sidebar-more").click();
    get('[role="menuitem"]').click();
    const input = root.querySelector<HTMLInputElement>('input[aria-label="Name"]');
    if (!input) throw new Error("Missing rename input");
    input.value = "Authentication";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(stores.navigation.getState().groups[0]?.title).toBe("Authentication");
    expect(get('button[data-group-id="initial-group"]')).toBe(row);
    expect(row.hidden).toBe(false);
    expect(document.activeElement).toBe(row);
  });

  it("session menus rename and close the intended session without selecting it", () => {
    const { stores, get, root } = setup();
    const session = get('.sidebar-row--session[data-chat-id="b"] .sidebar-more');
    session.click();
    expect(stores.zone3.getState().activeChatId).toBe("a");
    get('[role="menuitem"]').click();
    const input = root.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("Missing session rename input");
    input.value = "Security review";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(stores.zone3.getState().chats.find((chat) => chat.chatId === "b")?.title).toBe(
      "Security review",
    );
    session.click();
    const close = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
      (item) => item.textContent === "Close session",
    );
    close?.click();
    expect(stores.zone3.getState().chats.map((chat) => chat.chatId)).toEqual(["a"]);
    expect(stores.navigation.getState().groups[0]?.chatIds).toEqual(["a"]);
    expect(root.querySelector('[data-chat-id="b"]')).toBeNull();
  });

  it("toggles the folder from the row background and keeps the options action independent", () => {
    const { stores, get } = setup();
    const row = get(".sidebar-row--folder");
    row.click();
    expect(stores.navigation.getState().expanded).toBe(false);
    get(".sidebar-row--folder .sidebar-more").click();
    expect(stores.navigation.getState().expanded).toBe(false);
    expect(get('[role="menu"]')).toBeDefined();
  });

  it("folder options expand/collapse all without changing the active session", () => {
    const { stores, get, root } = setup();
    stores.createWorkGroup("Other task");
    get(".sidebar-row--folder .sidebar-more").click();
    Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((item) => item.textContent === "Collapse all groups")
      ?.click();
    expect(stores.navigation.getState().groups.every((group) => group.expanded === false)).toBe(
      true,
    );
    expect(stores.zone3.getState().activeChatId).toBe("a");
    get(".sidebar-row--folder .sidebar-row-select").click();
    expect(stores.navigation.getState().expanded).toBe(false);
  });

  it("keeps the open-project button stable and prevents duplicate opens, preserves cancellation, reports errors", async () => {
    let resolve: (value: null) => void = () => {};
    const open = vi.fn(
      () =>
        new Promise<null>((done) => {
          resolve = done;
        }),
    );
    const { stores, get, root } = setup(open);
    const add = get('[aria-label="Open project"]');
    const initialTree = stores.zone2.getState().fileTree;
    add.click();
    add.click();
    expect(open).toHaveBeenCalledTimes(1);
    stores.renameWorkGroup("initial-group", "Renamed while opening");
    expect(get('[aria-label="Open project"]')).toBe(add);
    expect(add.disabled).toBe(true);
    resolve(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(add.disabled).toBe(false);
    expect(stores.zone2.getState().fileTree).toBe(initialTree);
    open.mockRejectedValueOnce(new Error("Folder unavailable"));
    add.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe("Folder unavailable");
    expect(add.disabled).toBe(false);
  });

  it("restores focus to the remaining session when a focused session is closed", () => {
    const { stores, get } = setup();
    const second = get('button[data-chat-id="b"]');
    second.click();
    second.focus();
    stores.closeChat("b");
    expect(document.activeElement).toBe(get('button[data-chat-id="a"]'));
  });

  it("keeps folder and group expansion independent, and cancels rename with Escape", () => {
    const { stores, get, root } = setup();
    get(".sidebar-group-toggle").click();
    get(".sidebar-row--folder .sidebar-row-select").click();
    get(".sidebar-row--folder .sidebar-row-select").click();
    expect(stores.navigation.getState().groups[0]?.expanded).toBe(false);
    get(".sidebar-row--group .sidebar-more").click();
    get('[role="menuitem"]').click();
    const input = root.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("Missing input");
    input.value = "Discard this";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(stores.navigation.getState().groups[0]?.title).toBe("Workspace");
  });

  it("unsubscribes and removes document listeners on destruction", () => {
    const { stores, sidebar, treeHost, get } = setup();
    get(".sidebar-row--group .sidebar-more").click();
    sidebar.destroy();
    expect(treeHost.querySelector('[role="menu"]')).toBeNull();
    const before = treeHost.innerHTML;
    stores.createWorkGroup("After destroy");
    expect(treeHost.innerHTML).toBe(before);
  });
});
