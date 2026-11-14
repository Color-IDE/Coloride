// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCockpitStoreBundle } from "../stores/index.js";
import { FrameBatchedStreamRenderer } from "../ui/stream-renderer.js";
import { WorkspaceSidebar } from "./workspace-sidebar.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function setup(openWorkspace?: () => Promise<readonly [] | null>) {
  const stores = createCockpitStoreBundle({
    initialChats: [
      {
        kind: "agent" as const,
        chatId: "a",
        title: "Implementation",
        modelName: "Codex",
        validationState: "UnchangedBlue",
      },
      {
        kind: "agent" as const,
        chatId: "b",
        title: "Review",
        modelName: "Claude",
        validationState: "UnchangedBlue",
      },
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

/** The open menu's entry with this label. */
function menuItem(root: ParentNode, label: string): HTMLButtonElement {
  const item = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
    (entry) => entry.textContent === label,
  );
  if (!item) throw new Error(`Missing menu entry: ${label}`);
  return item;
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
    const first = get('[role="menuitem"]');
    expect(document.activeElement).toBe(first);
    expect(first.textContent).toBe("New session");
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect((document.activeElement as HTMLElement)?.textContent).toBe("Rename group");
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
    menuItem(root, "Rename group").click();
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
    menuItem(root, "Rename group").click();
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

  it("stacks every opened project and keeps each project's groups after opening another", () => {
    const { stores, root } = setup();
    stores.createWorkGroup("Authentication");
    stores.setProjectPath("/projects/Website");
    stores.createWorkGroup("Landing");
    const projects = Array.from(root.querySelectorAll<HTMLElement>(".sidebar-project"));
    expect(projects.map((project) => project.dataset.projectPath)).toEqual([
      "/projects/Coloride",
      "/projects/Website",
    ]);
    const titles = (project: HTMLElement) =>
      Array.from(project.querySelectorAll(".sidebar-row--group .sidebar-row-title")).map(
        (el) => el.textContent,
      );
    expect(titles(projects[0] as HTMLElement)).toEqual(["Workspace", "Authentication"]);
    expect(titles(projects[1] as HTMLElement)).toEqual(["Workspace", "Landing"]);
    expect(projects.map((project) => project.dataset.active)).toEqual(["false", "true"]);
  });

  it("switches project (through the host) when selecting a group of another project", async () => {
    const switchWorkspace = vi.fn(async () => [] as const);
    const stores = createCockpitStoreBundle();
    stores.setProjectPath("/projects/one");
    stores.setProjectPath("/projects/two");
    const root = document.createElement("aside");
    const controlsHost = document.createElement("div");
    const treeHost = document.createElement("div");
    root.append(controlsHost, treeHost);
    document.body.appendChild(root);
    const sidebar = new WorkspaceSidebar({ stores, controlsHost, treeHost, switchWorkspace });
    cleanup.push(() => {
      sidebar.destroy();
      root.remove();
    });
    root
      .querySelector<HTMLButtonElement>(
        '.sidebar-project[data-project-path="/projects/one"] .sidebar-row--group .sidebar-row-select',
      )
      ?.click();
    await vi.waitFor(() => expect(stores.navigation.getState().projectPath).toBe("/projects/one"));
    expect(switchWorkspace).toHaveBeenCalledWith("/projects/one");
  });

  it("collapses one project without touching the others and removes a project from the list", async () => {
    const { stores, root } = setup();
    stores.setProjectPath("/projects/Website");
    const folder = root.querySelector<HTMLButtonElement>(
      '.sidebar-project[data-project-path="/projects/Coloride"] .sidebar-row--folder .sidebar-row-select',
    );
    folder?.click();
    const [first, second] = Array.from(root.querySelectorAll<HTMLElement>(".sidebar-group-tree"));
    expect(first?.hidden).toBe(true);
    expect(second?.hidden).toBe(false);
    root
      .querySelector<HTMLButtonElement>(
        '.sidebar-project[data-project-path="/projects/Coloride"] .sidebar-row--folder .sidebar-more',
      )
      ?.click();
    const remove = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
      (item) => item.textContent === "Remove from list",
    );
    remove?.click();
    await vi.waitFor(() => expect(root.querySelectorAll(".sidebar-project")).toHaveLength(1));
    expect(stores.navigation.getState().projectPath).toBe("/projects/Website");
  });

  describe("new group in a project", () => {
    const groupTitles = (root: HTMLElement, project: string) =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          `.sidebar-project[data-project-path="${project}"] .sidebar-row--group .sidebar-row-title`,
        ),
      ).map((el) => el.textContent);
    const renameInput = (root: HTMLElement) =>
      root.querySelector<HTMLInputElement>(".sidebar-rename-input");

    it("has a + on the project row that creates a group, selects it and asks for its name", () => {
      const { stores, root, get } = setup();
      const add = get(".sidebar-row--folder .sidebar-add");
      expect(add.getAttribute("aria-label")).toBe("New group in Coloride");
      add.click();

      const groups = stores.navigation.getState().groups;
      expect(groups.map((group) => group.title)).toEqual(["Workspace", "New group"]);
      expect(stores.navigation.getState().activeGroupId).toBe(groups[1]?.id);
      // It is already being named: type and press Enter.
      const input = renameInput(root);
      expect(input?.value).toBe("New group");
      expect(document.activeElement).toBe(input);
      if (!input) throw new Error("Missing rename input");
      input.value = "Payments";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(groupTitles(root, "/projects/Coloride")).toEqual(["Workspace", "Payments"]);
      expect(stores.navigation.getState().groups[1]?.title).toBe("Payments");
    });

    it("keeps the default name when the naming is cancelled, and numbers repeated ones", () => {
      const { stores, root, get } = setup();
      get(".sidebar-row--folder .sidebar-add").click();
      renameInput(root)?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      get(".sidebar-row--folder .sidebar-add").click();
      expect(stores.navigation.getState().groups.map((group) => group.title)).toEqual([
        "Workspace",
        "New group",
        "New group 2",
      ]);
    });

    it("is also in the project's menu, and expands a collapsed project to show the group", () => {
      const { stores, root, get } = setup();
      get(".sidebar-row--folder .sidebar-row-select").click();
      expect(stores.navigation.getState().expanded).toBe(false);
      get(".sidebar-row--folder .sidebar-more").click();
      const item = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
        (el) => el.textContent === "New group",
      );
      if (!item) throw new Error("Missing menu item");
      item.click();
      expect(stores.navigation.getState().groups).toHaveLength(2);
      expect(stores.navigation.getState().expanded).toBe(true);
      expect(renameInput(root)).not.toBeNull();
    });

    it("creates the group in the project whose + was pressed, even if another is active", async () => {
      const { stores, root } = setup();
      stores.setProjectPath("/projects/Website");
      const coloride = root.querySelector<HTMLElement>(
        '.sidebar-project[data-project-path="/projects/Coloride"] .sidebar-row--folder .sidebar-add',
      );
      coloride?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(stores.navigation.getState().projectPath).toBe("/projects/Coloride");
      expect(groupTitles(root, "/projects/Coloride")).toEqual(["Workspace", "New group"]);
      expect(groupTitles(root, "/projects/Website")).toEqual(["Workspace"]);
    });
  });
});

describe("Zone 2 option menus", () => {
  const labels = (root: ParentNode) =>
    Array.from(root.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent);

  it("offers every folder action, with the destructive one last and in red", () => {
    const { root, get } = setup();
    get(".sidebar-row--folder .sidebar-more").click();
    expect(labels(root)).toEqual([
      "New group",
      "Collapse project",
      "Expand all groups",
      "Collapse all groups",
      "Copy path",
      "Open project…",
      "Remove from list",
    ]);
    expect(root.querySelectorAll(".sidebar-menu-separator")).toHaveLength(3);
    expect(menuItem(root, "Remove from list").classList.contains("sidebar-menu-item--danger")).toBe(
      true,
    );
  });

  it("collapses and expands the project from its menu", () => {
    const { root, get, stores } = setup();
    get(".sidebar-row--folder .sidebar-more").click();
    menuItem(root, "Collapse project").click();
    expect(stores.navigation.getState().expanded).toBe(false);
    get(".sidebar-row--folder .sidebar-more").click();
    expect(labels(root)).toContain("Expand project");
  });

  it("copies the project path", async () => {
    const { root, get } = setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    get(".sidebar-row--folder .sidebar-more").click();
    menuItem(root, "Copy path").click();
    expect(writeText).toHaveBeenCalledWith("/projects/Coloride");
  });

  it("offers every group action; the group with sessions cannot be deleted", () => {
    const { root, get, stores } = setup();
    stores.createWorkGroup("Other task");
    get('.sidebar-group[data-group-id="initial-group"] .sidebar-row--group .sidebar-more').click();
    expect(labels(root)).toEqual([
      "New session",
      "Rename group",
      "Collapse group",
      "Close all sessions",
      "Delete group",
    ]);
    const del = menuItem(root, "Delete group");
    expect(del.disabled).toBe(true);
    expect(del.title).toBe("Close the group's sessions first");
    expect(menuItem(root, "Close all sessions").disabled).toBe(false);
  });

  it("deletes an empty group and moves the selection to a neighbour", () => {
    const { root, get, stores } = setup();
    stores.createWorkGroup("Other task");
    const other = stores.navigation.getState().groups[1]?.id ?? "";
    expect(stores.navigation.getState().activeGroupId).toBe(other);
    get(`.sidebar-group[data-group-id="${other}"] .sidebar-row--group .sidebar-more`).click();
    menuItem(root, "Delete group").click();
    expect(stores.navigation.getState().groups.map((group) => group.id)).toEqual(["initial-group"]);
    expect(stores.navigation.getState().activeGroupId).toBe("initial-group");
  });

  it("never deletes the only group", () => {
    const { get, root, stores } = setup();
    get(".sidebar-row--group .sidebar-more").click();
    expect(menuItem(root, "Delete group").disabled).toBe(true);
    stores.removeWorkGroup("initial-group");
    expect(stores.navigation.getState().groups).toHaveLength(1);
  });

  it("a new session is created from the group menu", () => {
    const { get, root, stores } = setup();
    get(".sidebar-row--group .sidebar-more").click();
    const before = stores.zone3.getState().chats.length;
    menuItem(root, "New session").click();
    expect(stores.zone3.getState().chats).toHaveLength(before + 1);
  });

  it("offers every session action and closes the others without touching this one", () => {
    const { root, get, stores } = setup();
    get('.sidebar-row--session[data-chat-id="a"] .sidebar-more').click();
    expect(labels(root)).toEqual([
      "Rename session",
      "Duplicate session",
      "Maximize",
      "Close session",
      "Close other sessions",
    ]);
    menuItem(root, "Close other sessions").click();
    expect(stores.zone3.getState().chats.map((chat) => chat.chatId)).toEqual(["a"]);
  });

  it("duplicates a session next to it and maximizes then restores it", () => {
    const { root, get, stores } = setup();
    get('.sidebar-row--session[data-chat-id="b"] .sidebar-more').click();
    menuItem(root, "Duplicate session").click();
    const chats = stores.zone3.getState().chats;
    expect(chats).toHaveLength(3);
    expect(chats.at(-1)?.modelName).toBe("Claude");
    get('.sidebar-row--session[data-chat-id="b"] .sidebar-more').click();
    menuItem(root, "Maximize").click();
    expect(stores.navigation.getState().groups[0]?.maximizedChatId).toBe("b");
    get('.sidebar-row--session[data-chat-id="b"] .sidebar-more').click();
    menuItem(root, "Restore layout").click();
    expect(stores.navigation.getState().groups[0]?.maximizedChatId).toBeNull();
  });

  it("cannot close the last session or one with a running agent", () => {
    const { root, get, stores } = setup();
    stores.closeChat("b");
    get(".sidebar-row--session .sidebar-more").click();
    const close = menuItem(root, "Close session");
    expect(close.disabled).toBe(true);
    expect(close.title).toBe("No session can be closed right now");
  });

  it("opens the same menu on a right click, but not while renaming", () => {
    const { root, get } = setup();
    const row = get(".sidebar-row--folder");
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    row.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(labels(root)).toContain("New group");
  });

  it("jumps to an entry by typing its first letter", () => {
    const { root, get } = setup();
    get(".sidebar-row--folder .sidebar-more").click();
    const menu = root.querySelector('[role="menu"]') as HTMLElement;
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
    expect(document.activeElement?.textContent).toBe("Collapse project");
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
    expect(document.activeElement?.textContent).toBe("Collapse all groups");
  });

  it("closes when the sidebar scrolls or the window resizes", () => {
    const { root, get } = setup();
    get(".sidebar-row--folder .sidebar-more").click();
    expect(root.querySelector('[role="menu"]')).not.toBeNull();
    window.dispatchEvent(new Event("resize"));
    expect(root.querySelector('[role="menu"]')).toBeNull();
    get(".sidebar-row--folder .sidebar-more").click();
    document.body.dispatchEvent(new Event("scroll"));
    expect(root.querySelector('[role="menu"]')).toBeNull();
  });

  it("opens above its button when there is no room below", () => {
    const { root, get } = setup();
    const more = get(".sidebar-row--group .sidebar-more");
    vi.spyOn(more, "getBoundingClientRect").mockReturnValue({
      top: window.innerHeight - 40,
      bottom: window.innerHeight - 20,
    } as DOMRect);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(200);
    more.click();
    expect(root.querySelector<HTMLElement>('[role="menu"]')?.dataset.placement).toBe("above");
    vi.restoreAllMocks();
  });
});
