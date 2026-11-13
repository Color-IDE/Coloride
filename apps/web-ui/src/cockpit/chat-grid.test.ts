// @vitest-environment happy-dom
import { ColorideEditorView, InMemoryBinaryHostBridge } from "@coloride/editor-cm6";
import { describe, expect, it } from "vitest";
import {
  CockpitDomController,
  type WorkGroup,
  createCockpitStoreBundle,
  resolveGroupLayout,
} from "../index.js";
import { panelIds } from "../layout-tree.js";

describe("@coloride/web-ui — Zone 3 groups and sessions", () => {
  it("keeps work groups separate when changing project folders", () => {
    const stores = createCockpitStoreBundle();
    stores.setProjectPath("/projects/one");
    stores.createWorkGroup("Authentication");
    stores.setProjectPath("/projects/two");
    expect(stores.navigation.getState().groups.map((group) => group.title)).toEqual(["Workspace"]);
    stores.createWorkGroup("Website");
    stores.setProjectPath("/projects/one");
    expect(stores.navigation.getState().groups.map((group) => group.title)).toEqual([
      "Workspace",
      "Authentication",
    ]);
  });
  it("shows project controls only in Chats and selects group tabs without remounting the editor", () => {
    const rootContainer = document.createElement("div");
    document.body.appendChild(rootContainer);
    const stores = createCockpitStoreBundle();
    const editorView = new ColorideEditorView({
      initialDocumentId: "src/main.ts",
      initialContent: "const ready = true;",
      ipcChannel: new InMemoryBinaryHostBridge(),
    });
    const controller = new CockpitDomController({ rootContainer, stores, editorView });
    const editorDom = editorView.getEditorView().dom;
    const controls = rootContainer.querySelector(".sidebar-project-controls");
    expect(controls?.querySelectorAll("button")).toHaveLength(1);
    expect(controls?.querySelector("button")?.disabled).toBe(true);
    expect(controls?.querySelector("button")?.textContent).toBe("Open project");
    for (const section of ["files", "search", "git", "debug", "mcp"] as const) {
      stores.setActivitySection(section);
      expect((controls as HTMLElement).hidden).toBe(true);
    }
    stores.setActivitySection("sessions");
    expect((controls as HTMLElement).hidden).toBe(false);
    stores.createWorkGroup("Authentication");
    expect(stores.navigation.getState().groups.at(-1)?.title).toBe("Authentication");
    // The header lists the sessions of the active group; a new, empty group has none.
    expect(
      rootContainer.querySelectorAll(".coloride-zone-3-header .coloride-header-tab"),
    ).toHaveLength(0);
    expect(rootContainer.querySelector(".coloride-header-tab-add")).not.toBeNull();
    expect(rootContainer.querySelectorAll(".coloride-chat-cell")).toHaveLength(0);
    rootContainer
      .querySelector<HTMLButtonElement>('button[data-group-id="initial-group"]')
      ?.click();
    expect(rootContainer.querySelectorAll(".coloride-chat-cell")).toHaveLength(1);
    stores.setProjectPath("/projects/Coloride");
    const projectRow = rootContainer.querySelector<HTMLButtonElement>(".sidebar-group-toggle");
    expect(rootContainer.querySelector(".sidebar-row--group .sidebar-row-title")?.textContent).toBe(
      "Workspace",
    );
    expect(projectRow?.querySelector(".sidebar-group-icon svg")).not.toBeNull();
    expect(projectRow?.lastElementChild?.className).toBe("sidebar-chevron");
    projectRow?.click();
    expect(
      rootContainer.querySelector(".sidebar-group-toggle")?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(rootContainer.querySelector<HTMLElement>(".sidebar-sessions")?.hidden).toBe(true);
    rootContainer.querySelector<HTMLButtonElement>(".sidebar-group-toggle")?.click();
    expect(rootContainer.querySelector<HTMLElement>(".sidebar-sessions")?.hidden).toBe(false);
    expect(editorView.getEditorView().dom).toBe(editorDom);
    expect(rootContainer.contains(editorDom)).toBe(true);
    controller.destroy();
    editorView.destroy();
    rootContainer.remove();
  });
  it("shows every session of a tab at once, marks the selected one and keeps panels across tab switches", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const stores = createCockpitStoreBundle({
      initialChats: [
        { chatId: "a", title: "Implement", modelName: "Codex", validationState: "UnchangedBlue" },
        { chatId: "b", title: "Review", modelName: "Claude", validationState: "UnchangedBlue" },
      ],
    });
    const editorView = new ColorideEditorView({
      initialDocumentId: "src/main.ts",
      initialContent: "const ready = true;",
      ipcChannel: new InMemoryBinaryHostBridge(),
    });
    const controller = new CockpitDomController({ rootContainer: root, stores, editorView });
    const cells = () => Array.from(root.querySelectorAll<HTMLElement>(".coloride-chat-cell"));
    expect(cells().map((cell) => cell.dataset.chatId)).toEqual(["a", "b"]);
    stores.selectChat("b");
    expect(cells().find((cell) => cell.dataset.active === "true")?.dataset.chatId).toBe("b");
    stores.createWorkGroup("Other");
    expect(cells()).toHaveLength(0);
    stores.selectWorkGroup("initial-group");
    expect(cells().map((cell) => cell.dataset.chatId)).toEqual(["a", "b"]);
    expect(editorView.getStoreSnapshot().mountCount).toBe(1);
    controller.destroy();
    editorView.destroy();
    root.remove();
  });
  it("lays out any number of panels from the tab layout without rebuilding on streaming updates", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const chats = Array.from({ length: 12 }, (_, i) => ({
      chatId: `c${i}`,
      title: `Chat ${i}`,
      modelName: "Codex",
      validationState: "UnchangedBlue" as const,
    }));
    const stores = createCockpitStoreBundle({ initialChats: chats });
    const editorView = new ColorideEditorView({
      initialDocumentId: "src/main.ts",
      initialContent: "const ready = true;",
      ipcChannel: new InMemoryBinaryHostBridge(),
    });
    const controller = new CockpitDomController({ rootContainer: root, stores, editorView });
    const cells = () => Array.from(root.querySelectorAll<HTMLElement>(".coloride-chat-cell"));
    expect(cells()).toHaveLength(12);
    const rootLayout = root.querySelector<HTMLElement>(".coloride-layout-root");
    const firstCell = cells()[0];
    expect(rootLayout?.classList.contains("coloride-layout-split")).toBe(true);

    // Streaming-style state changes update cells in place: same split containers, same cells.
    stores.zone3.setState((prev) => ({
      ...prev,
      terminalLogsByChatId: { ...prev.terminalLogsByChatId, c3: ["[stdout] building…"] },
    }));
    expect(root.querySelector(".coloride-layout-root")).toBe(rootLayout);
    expect(cells()[0]).toBe(firstCell);

    // Closing a panel changes the shape: the others keep their DOM nodes.
    stores.closeChat("c5");
    expect(cells()).toHaveLength(11);
    expect(cells()[0]).toBe(firstCell);
    expect(cells().some((cell) => cell.dataset.chatId === "c5")).toBe(false);

    // Every split distributes the whole space.
    for (const split of root.querySelectorAll<HTMLElement>(".coloride-layout-split")) {
      const total = Array.from(split.children).reduce(
        (sum, child) => sum + Number.parseFloat((child as HTMLElement).style.flex),
        0,
      );
      expect(total).toBeCloseTo(1);
    }
    expect(editorView.getStoreSnapshot().mountCount).toBe(1);
    controller.destroy();
    editorView.destroy();
    root.remove();
  });
  it("honours a stored layout for a tab and recovers from a corrupted or outdated one", () => {
    const chats = ["a", "b", "c"].map((chatId) => ({
      chatId,
      title: chatId,
      modelName: "Codex",
      validationState: "UnchangedBlue" as const,
    }));
    const stores = createCockpitStoreBundle({ initialChats: chats });
    const group = () => stores.navigation.getState().groups[0] as WorkGroup;

    stores.setWorkGroupLayout("initial-group", {
      kind: "split",
      direction: "column",
      sizes: [0.7, 0.3],
      children: [
        { kind: "panel", id: "c" },
        {
          kind: "split",
          direction: "row",
          sizes: [0.5, 0.5],
          children: [
            { kind: "panel", id: "a" },
            { kind: "panel", id: "b" },
          ],
        },
      ],
    });
    expect(panelIds(resolveGroupLayout(group()))).toEqual(["c", "a", "b"]);

    // Outdated: a panel that no longer exists is dropped and a new chat is placed automatically.
    stores.closeChat("a");
    expect(panelIds(resolveGroupLayout(group())).sort()).toEqual(["b", "c"]);

    // Corrupted (e.g. from a damaged saved session): falls back to an automatic layout.
    stores.setWorkGroupLayout("initial-group", { kind: "split", children: 5 } as never);
    expect(panelIds(resolveGroupLayout(group())).sort()).toEqual(["b", "c"]);
    stores.setWorkGroupLayout("nope", null);
    expect(stores.navigation.getState().groups).toHaveLength(1);
  });
  function mount() {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const chat = (chatId: string) => ({
      chatId,
      title: chatId,
      modelName: "Codex",
      validationState: "UnchangedBlue" as const,
    });
    const stores = createCockpitStoreBundle({ initialChats: [chat("a"), chat("b")] });
    const editorView = new ColorideEditorView({
      initialDocumentId: "src/main.ts",
      initialContent: "const ready = true;",
      ipcChannel: new InMemoryBinaryHostBridge(),
    });
    const controller = new CockpitDomController({ rootContainer: root, stores, editorView });
    const cells = () => Array.from(root.querySelectorAll<HTMLElement>(".coloride-chat-cell"));
    const cleanup = () => {
      controller.destroy();
      editorView.destroy();
      root.remove();
    };
    return { root, stores, cells, editorView, cleanup };
  }

  it("creates sessions from the header + and from each panel's split buttons", () => {
    const { root, stores, cells, editorView, cleanup } = mount();
    root.querySelector<HTMLButtonElement>(".coloride-header-tab-add")?.click();
    expect(cells().map((c) => c.dataset.chatId)).toContain("chat-3");
    expect(stores.zone3.getState().activeChatId).toBe("chat-3");

    const cellA = cells().find((c) => c.dataset.chatId === "a") as HTMLElement;
    cellA.querySelector<HTMLButtonElement>(".coloride-split-right")?.click();
    cellA.querySelector<HTMLButtonElement>(".coloride-split-down")?.click();
    expect(cells()).toHaveLength(5);
    // Acting on a panel's button must not also select that panel through its header.
    expect(stores.zone3.getState().activeChatId).toBe("chat-5");
    expect(editorView.getStoreSnapshot().mountCount).toBe(1);
    cleanup();
  });

  it("closes a session from its panel, but never the last one", () => {
    const { stores, cells, cleanup } = mount();
    const close = (id: string) =>
      cells()
        .find((c) => c.dataset.chatId === id)
        ?.querySelector<HTMLButtonElement>(".coloride-close-panel");
    close("b")?.click();
    expect(cells().map((c) => c.dataset.chatId)).toEqual(["a"]);
    expect(close("a")?.disabled).toBe(true);
    close("a")?.click();
    expect(stores.zone3.getState().chats).toHaveLength(1);
    cleanup();
  });

  it("disables the creation buttons, with an explanation, when no panel fits", () => {
    const { root, stores, cells, cleanup } = mount();
    stores.setPanelArea({ widthPx: 440, heightPx: 270 });
    // Any state change refreshes the buttons (in the app the ResizeObserver also does).
    stores.zone3.setState((prev) => ({ ...prev }));
    const add = root.querySelector<HTMLButtonElement>(".coloride-header-tab-add");
    expect(add?.disabled).toBe(true);
    expect(add?.title).toBe("No room for another panel");
    const cellA = cells()[0] as HTMLElement;
    expect(cellA.querySelector<HTMLButtonElement>(".coloride-split-down")?.disabled).toBe(true);
    add?.click();
    expect(cells()).toHaveLength(2);

    stores.setPanelArea({ widthPx: 1400, heightPx: 900 });
    stores.zone3.setState((prev) => ({ ...prev }));
    expect(add?.disabled).toBe(false);
    expect(add?.title).toBe("New session");
    expect(cellA.querySelector<HTMLButtonElement>(".coloride-split-down")?.disabled).toBe(false);
    cleanup();
  });

  it("offers a New session button in an empty tab and a + on every sidebar group", () => {
    const { root, stores, cells, cleanup } = mount();
    stores.createWorkGroup("Other");
    expect(cells()).toHaveLength(0);
    root.querySelector<HTMLButtonElement>(".coloride-group-empty-add")?.click();
    expect(cells()).toHaveLength(1);
    expect(stores.navigation.getState().groups[1]?.chatIds).toHaveLength(1);

    const initialRow = root.querySelector<HTMLElement>(
      '.sidebar-group[data-group-id="initial-group"]',
    );
    initialRow?.querySelector<HTMLButtonElement>(".sidebar-add")?.click();
    expect(stores.navigation.getState().groups[0]?.chatIds).toHaveLength(3);
    // Adding through the sidebar also activates that group and shows its new session.
    expect(stores.navigation.getState().activeGroupId).toBe("initial-group");
    expect(initialRow?.querySelectorAll(".sidebar-row--session")).toHaveLength(3);
    cleanup();
  });
  it("shows one header tab per session of the active group instead of the group name", () => {
    const { root, stores, cells, cleanup } = mount();
    const tabs = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(".coloride-zone-3-header .coloride-header-tab"),
      );
    expect(tabs().map((tab) => tab.dataset.chatId)).toEqual(["a", "b"]);
    expect(tabs()[1]?.textContent).toContain("b");
    expect(root.querySelector(".coloride-zone-3-header")?.textContent).not.toContain("Workspace");
    expect(root.querySelector(".coloride-work-group-tab")).toBeNull();

    tabs()[0]?.click();
    expect(stores.zone3.getState().activeChatId).toBe("a");
    expect(tabs()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs()[1]?.getAttribute("aria-selected")).toBe("false");

    // New sessions appear as tabs as they are created; closing one removes its tab and panel.
    root.querySelector<HTMLButtonElement>(".coloride-header-tab-add")?.click();
    expect(tabs().map((tab) => tab.dataset.chatId)).toEqual(["a", "b", "chat-3"]);
    expect(tabs()[2]?.getAttribute("aria-selected")).toBe("true");
    tabs()[1]?.querySelector<HTMLButtonElement>(".coloride-header-tab-close")?.click();
    expect(tabs().map((tab) => tab.dataset.chatId)).toEqual(["a", "chat-3"]);
    expect(cells().map((cell) => cell.dataset.chatId)).not.toContain("b");

    // Another group shows its own sessions.
    stores.createWorkGroup("Other");
    expect(tabs()).toHaveLength(0);
    stores.selectWorkGroup("initial-group");
    expect(tabs()).toHaveLength(2);
    cleanup();
  });
});
