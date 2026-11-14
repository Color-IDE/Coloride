// @vitest-environment happy-dom
import { ColorideEditorView, InMemoryBinaryHostBridge } from "@coloride/editor-cm6";
import { describe, expect, it } from "vitest";
import {
  CockpitDomController,
  type WorkGroup,
  createCockpitStoreBundle,
  resolveGroupLayout,
} from "../../index.js";
import { type LayoutNode, panelIds } from "../../layout/layout-tree.js";

/** The header + opens a menu: Codex, then Interface, creates an agent session. */
function addSessionFromMenu(root: HTMLElement): void {
  root.querySelector<HTMLButtonElement>(".coloride-header-tab-add")?.click();
  const pick = (label: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>(".coloride-new-panel-item"))
      .find((item) => item.textContent?.startsWith(label))
      ?.click();
  pick("Codex");
  pick("Interface");
}

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
    for (const section of ["search", "git", "debug", "mcp"] as const) {
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
        {
          kind: "agent" as const,
          chatId: "a",
          title: "Implement",
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
      kind: "agent" as const,
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
      // The separators over the boundaries take no room and have no size of their own.
      const total = Array.from(split.children)
        .filter((child) => !child.classList.contains("coloride-layout-handle"))
        .reduce((sum, child) => sum + Number.parseFloat((child as HTMLElement).style.flex), 0);
      expect(total).toBeCloseTo(1);
    }
    expect(editorView.getStoreSnapshot().mountCount).toBe(1);
    controller.destroy();
    editorView.destroy();
    root.remove();
  });
  it("honours a stored layout for a tab and recovers from a corrupted or outdated one", () => {
    const chats = ["a", "b", "c"].map((chatId) => ({
      kind: "agent" as const,
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
      kind: "agent" as const,
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
    addSessionFromMenu(root);
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

  it("a panel dragged by its header lands on an edge of another panel, or swaps with it", () => {
    const { root, stores, cells, cleanup } = mount();
    const layout = () =>
      resolveGroupLayout(
        stores.navigation.getState().groups.find((g) => g.id === "initial-group") as never,
      );
    const cell = (id: string) => cells().find((c) => c.dataset.chatId === id) as HTMLElement;
    const header = (id: string) =>
      cell(id).querySelector<HTMLElement>(".coloride-chat-cell-header") as HTMLElement;
    const grid = root.querySelector<HTMLElement>(".coloride-zone-3-grid") as HTMLElement;
    const pointer = (type: string, target: HTMLElement, x: number, y: number) =>
      target.dispatchEvent(
        Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }), {
          pointerId: 1,
        }),
      );
    // The pointer is over `b`, which is 100x100 at the origin (happy-dom has no layout).
    document.elementFromPoint = () => cell("b");
    cell("b").getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 }) as DOMRect;

    // A short press is a click (selects), not a move.
    pointer("pointerdown", header("a"), 50, 50);
    pointer("pointermove", header("a"), 52, 51);
    expect(grid.dataset.dragging).toBeUndefined();
    pointer("pointerup", header("a"), 52, 51);
    expect(panelIds(layout())).toEqual(["a", "b"]);

    // Dropped near the bottom edge of `b`: `a` goes under `b`.
    pointer("pointerdown", header("a"), 50, 50);
    pointer("pointermove", header("a"), 50, 95);
    expect(grid.dataset.dragging).toBe("a");
    expect(cell("a").dataset.dragging).toBe("true");
    const indicator = cell("b").querySelector<HTMLElement>(".coloride-drop-indicator");
    expect(indicator?.dataset.zone).toBe("bottom");
    pointer("pointerup", header("a"), 50, 95);
    expect(grid.dataset.dragging).toBeUndefined();
    expect(root.querySelector(".coloride-drop-indicator")).toBeNull();
    const moved = layout();
    expect(moved?.kind).toBe("split");
    expect(moved?.kind === "split" && moved.direction).toBe("column");
    expect(panelIds(moved)).toEqual(["b", "a"]);

    // Dropped in the middle of `b`: the two exchange places.
    pointer("pointerdown", header("a"), 50, 50);
    pointer("pointermove", header("a"), 50, 60);
    expect(cell("b").querySelector<HTMLElement>(".coloride-drop-indicator")?.dataset.zone).toBe(
      "center",
    );
    pointer("pointerup", header("a"), 50, 60);
    const swapped = layout();
    expect(panelIds(swapped)).toEqual(["a", "b"]);
    expect(swapped?.kind === "split" && swapped.direction).toBe("column");
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
    addSessionFromMenu(root);
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
  it("places the + right after the strip, outside the part that scrolls", () => {
    const { root, stores, cleanup } = mount();
    const header = root.querySelector<HTMLElement>(".coloride-zone-3-header") as HTMLElement;
    const track = header.querySelector<HTMLElement>('[role="tablist"]') as HTMLElement;
    const add = header.querySelector<HTMLElement>(".coloride-header-tab-add") as HTMLElement;
    expect(track.nextElementSibling).toBe(add);
    for (let i = 0; i < 6; i += 1) stores.createChat();
    expect(track.querySelectorAll(".coloride-header-tab")).toHaveLength(8);
    expect(track.contains(add)).toBe(false);
    expect(track.nextElementSibling).toBe(add);
    cleanup();
  });

  it("shows what the selected group has, not another project's group with the same name", () => {
    const { root, stores, cells, cleanup } = mount();
    const headerTabs = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(".coloride-zone-3-header .coloride-header-tab"),
      );
    const emptyShown = () => root.querySelector<HTMLElement>(".coloride-group-empty") !== null;

    // Every project starts with a group "Workspace" that has the same id: only its content differs.
    stores.setProjectPath("/projects/videos");
    expect(cells().map((c) => c.dataset.chatId)).toEqual(["a", "b"]);
    expect(headerTabs()).toHaveLength(2);

    stores.setProjectPath("/projects/screenshots");
    expect(stores.navigation.getState().groups[0]?.chatIds).toEqual([]);
    expect(cells()).toHaveLength(0);
    expect(headerTabs()).toHaveLength(0);
    expect(emptyShown()).toBe(true);

    stores.setProjectPath("/projects/videos");
    expect(cells().map((c) => c.dataset.chatId)).toEqual(["a", "b"]);
    expect(headerTabs()).toHaveLength(2);
    cleanup();
  });

  describe("separators between panels", () => {
    function setup(ids: readonly string[] = ["a", "b"]) {
      const root = document.createElement("div");
      document.body.appendChild(root);
      const stores = createCockpitStoreBundle({
        initialChats: ids.map((chatId) => ({
          kind: "agent" as const,
          chatId,
          title: chatId,
          modelName: "Codex",
          validationState: "UnchangedBlue" as const,
        })),
      });
      const editorView = new ColorideEditorView({
        initialDocumentId: "src/main.ts",
        initialContent: "const ready = true;",
        ipcChannel: new InMemoryBinaryHostBridge(),
      });
      const controller = new CockpitDomController({ rootContainer: root, stores, editorView });
      const handles = () =>
        Array.from(root.querySelectorAll<HTMLElement>(".coloride-layout-handle"));
      // The layout has no size in a test DOM: give every split one (1000 x 600).
      for (const split of root.querySelectorAll<HTMLElement>(".coloride-layout-split")) {
        split.getBoundingClientRect = () => ({ width: 1000, height: 600 }) as DOMRect;
      }
      const sizes = () => {
        const group = stores.navigation.getState().groups[0] as WorkGroup;
        const layout = resolveGroupLayout(group);
        return layout?.kind === "split" ? layout.sizes : [];
      };
      const pointer = (target: HTMLElement, type: string, x: number, y = 0) => {
        const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
        Object.defineProperty(event, "pointerId", { value: 1 });
        target.dispatchEvent(event);
      };
      return { root, stores, controller, handles, sizes, pointer };
    }

    it("has one separator per boundary, labelled for assistive technology", () => {
      const { root, handles, controller } = setup();
      // Two panels side by side: one boundary, a vertical bar.
      expect(handles()).toHaveLength(1);
      expect(handles()[0]?.getAttribute("role")).toBe("separator");
      expect(handles()[0]?.getAttribute("aria-orientation")).toBe("vertical");
      expect(handles()[0]?.tabIndex).toBe(0);
      controller.destroy();
      root.remove();
      // Three panels need two boundaries, whatever way they are split.
      const three = setup(["a", "b", "c"]);
      expect(three.handles()).toHaveLength(2);
      three.controller.destroy();
      three.root.remove();
    });

    it("moves the boundary while dragging and saves the new sizes when released", () => {
      const { root, stores, controller, handles, sizes, pointer } = setup();
      const before = sizes();
      const handle = handles()[0] as HTMLElement;
      pointer(handle, "pointerdown", 333);
      pointer(handle, "pointermove", 433); // 100 px of 1000 = 10%
      const grown = root.querySelectorAll<HTMLElement>(".coloride-chat-cell");
      expect(Number.parseFloat((grown[0] as HTMLElement).style.flex)).toBeCloseTo(
        (before[0] as number) + 0.1,
      );
      // Nothing is stored (and nothing re-rendered) until the pointer is released.
      expect(sizes()).toEqual(before);
      pointer(handle, "pointerup", 433);
      expect(sizes()[0]).toBeCloseTo((before[0] as number) + 0.1);
      expect(sizes()[1]).toBeCloseTo((before[1] as number) - 0.1);
      expect(sizes().reduce((sum, size) => sum + size, 0)).toBeCloseTo(1);
      // A tab keeps its own sizes: the layout lives in the group, so it is also what is saved.
      expect(stores.navigation.getState().groups[0]?.layout).not.toBeNull();
      controller.destroy();
      root.remove();
    });

    it("never lets a panel shrink under the minimum size", () => {
      const { root, controller, handles, sizes, pointer } = setup();
      const handle = handles()[0] as HTMLElement;
      pointer(handle, "pointerdown", 333);
      pointer(handle, "pointermove", 5000); // far past the right edge
      pointer(handle, "pointerup", 5000);
      // b needs 220 px of 1000; c is untouched.
      expect(sizes()[1]).toBeGreaterThanOrEqual(0.22 - 1e-9);
      pointer(handle, "pointerdown", 600);
      pointer(handle, "pointermove", -4000);
      pointer(handle, "pointerup", -4000);
      expect(sizes()[0]).toBeGreaterThanOrEqual(0.22 - 1e-9);
      controller.destroy();
      root.remove();
    });

    it("moves with the arrow keys and resets the two neighbours with a double click", () => {
      const { root, controller, handles, sizes } = setup();
      const handle = handles()[0] as HTMLElement;
      const before = sizes();
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      expect(sizes()[0]).toBeCloseTo((before[0] as number) + 0.02);
      handle.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true }),
      );
      expect(sizes()[0]).toBeCloseTo((before[0] as number) + 0.02 - 0.1);
      handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      const even = ((before[0] as number) + (before[1] as number)) / 2;
      expect(sizes()[0]).toBeCloseTo(even);
      expect(sizes()[1]).toBeCloseTo(even);
      controller.destroy();
      root.remove();
    });
  });

  describe("maximizing a panel", () => {
    function setup(ids: readonly string[] = ["a", "b", "c"]) {
      const root = document.createElement("div");
      document.body.appendChild(root);
      const stores = createCockpitStoreBundle({
        initialChats: ids.map((chatId) => ({
          kind: "agent" as const,
          chatId,
          title: chatId.toUpperCase(),
          modelName: "Codex",
          validationState: "UnchangedBlue" as const,
        })),
      });
      const editorView = new ColorideEditorView({
        initialDocumentId: "src/main.ts",
        initialContent: "const ready = true;",
        ipcChannel: new InMemoryBinaryHostBridge(),
      });
      const controller = new CockpitDomController({ rootContainer: root, stores, editorView });
      const shown = () =>
        Array.from(root.querySelectorAll<HTMLElement>(".coloride-zone-3-grid .coloride-chat-cell"))
          .map((cell) => cell.dataset.chatId)
          .sort();
      const button = (chatId: string) =>
        root.querySelector<HTMLButtonElement>(
          `.coloride-chat-cell[data-chat-id="${chatId}"] .coloride-maximize-panel`,
        );
      const tab = (chatId: string) =>
        root.querySelector<HTMLElement>(
          `.coloride-zone-3-header .coloride-header-tab[data-chat-id="${chatId}"]`,
        );
      return { root, stores, controller, shown, button, tab };
    }

    it("shows only that panel when maximized, and every panel again when restored", () => {
      const { root, controller, shown, button } = setup();
      expect(shown()).toEqual(["a", "b", "c"]);
      expect(button("b")?.getAttribute("aria-label")).toBe("Maximize panel");
      button("b")?.click();
      expect(shown()).toEqual(["b"]);
      // The separators have nothing to separate while one panel fills the tab.
      expect(root.querySelector(".coloride-layout-handle")).toBeNull();
      expect(button("b")?.getAttribute("aria-label")).toBe("Restore panels");
      button("b")?.click();
      expect(shown()).toEqual(["a", "b", "c"]);
      expect(root.querySelectorAll(".coloride-layout-handle").length).toBeGreaterThan(0);
      controller.destroy();
      root.remove();
    });

    it("also toggles with a double click on the panel header, but not on its buttons", () => {
      const { root, controller, shown } = setup();
      const header = root.querySelector<HTMLElement>(
        '.coloride-chat-cell[data-chat-id="c"] .coloride-chat-cell-header',
      ) as HTMLElement;
      header.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      expect(shown()).toEqual(["c"]);
      header.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      expect(shown()).toHaveLength(3);
      // A double click on a button (it would double-trigger the action) is not a header gesture.
      const close = root.querySelector<HTMLElement>(
        '.coloride-chat-cell[data-chat-id="c"] .coloride-split-right',
      ) as HTMLElement;
      close.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      expect(shown()).toHaveLength(3);
      controller.destroy();
      root.remove();
    });

    it("uses the header tabs to switch the session shown alone", () => {
      const { root, controller, shown, button, tab } = setup();
      button("a")?.click();
      expect(shown()).toEqual(["a"]);
      tab("c")?.click();
      expect(shown()).toEqual(["c"]);
      expect(tab("c")?.getAttribute("aria-selected")).toBe("true");
      // All the sessions are still tabs; maximizing never hides them.
      expect(root.querySelectorAll(".coloride-zone-3-header .coloride-header-tab")).toHaveLength(3);
      controller.destroy();
      root.remove();
    });

    it("keeps each panel's content and scroll while it is hidden by another one", () => {
      const { root, stores, controller, button, shown } = setup();
      stores.zone3.setState((prev) => ({
        ...prev,
        messagesByChatId: {
          ...prev.messagesByChatId,
          b: [
            {
              messageId: "m1",
              chatId: "b",
              role: "assistant",
              content: "keep me",
              renderedHtmlBlocks: ["keep me"],
              streaming: false,
            },
          ],
        },
      }));
      const cell = root.querySelector<HTMLElement>('.coloride-chat-cell[data-chat-id="b"]');
      button("a")?.click();
      expect(shown()).toEqual(["a"]);
      button("a")?.click();
      // The same element comes back (not a rebuilt one), with its content.
      expect(root.querySelector('.coloride-chat-cell[data-chat-id="b"]')).toBe(cell);
      expect(cell?.textContent).toContain("keep me");
      controller.destroy();
      root.remove();
    });

    it("hides the button when the tab has a single panel, and goes back when a panel is split", () => {
      const single = setup(["a"]);
      expect(single.button("a")?.hidden).toBe(true);
      single.controller.destroy();
      single.root.remove();

      const { root, stores, controller, shown, button } = setup(["a", "b"]);
      button("a")?.click();
      stores.createChat({ from: "a", direction: "row" });
      expect(shown()).toHaveLength(3);
      controller.destroy();
      root.remove();
    });
  });

  describe("aligning separators while dragging", () => {
    /** Two columns side by side, each split in two, with the horizontal bars 6px apart. */
    function setup() {
      const root = document.createElement("div");
      document.body.appendChild(root);
      const stores = createCockpitStoreBundle({
        initialChats: ["a", "b", "c", "d"].map((chatId) => ({
          kind: "agent" as const,
          chatId,
          title: chatId,
          modelName: "Codex",
          validationState: "UnchangedBlue" as const,
        })),
      });
      const editorView = new ColorideEditorView({
        initialDocumentId: "src/main.ts",
        initialContent: "const ready = true;",
        ipcChannel: new InMemoryBinaryHostBridge(),
      });
      const controller = new CockpitDomController({ rootContainer: root, stores, editorView });
      const column = (ids: [string, string], top: number): LayoutNode => ({
        kind: "split",
        direction: "column",
        sizes: [top, 1 - top],
        children: ids.map((id) => ({ kind: "panel", id })),
      });
      const group = stores.navigation.getState().groups[0] as WorkGroup;
      stores.setWorkGroupLayout(group.id, {
        kind: "split",
        direction: "row",
        sizes: [0.5, 0.5],
        children: [column(["a", "b"], 0.5), column(["c", "d"], 0.51)],
      });
      for (const split of root.querySelectorAll<HTMLElement>(".coloride-layout-split")) {
        split.getBoundingClientRect = () => ({ width: 1000, height: 600 }) as DOMRect;
      }
      // The horizontal bars sit at y = 300 and y = 306 (their centres).
      const bars = Array.from(
        root.querySelectorAll<HTMLElement>(
          '.coloride-layout-handle[aria-orientation="horizontal"]',
        ),
      );
      [300, 306].forEach((center, index) => {
        (bars[index] as HTMLElement).getBoundingClientRect = () =>
          ({ top: center - 4.5, height: 9, left: 0, width: 500 }) as DOMRect;
      });
      const secondColumn = () => {
        const layout = resolveGroupLayout(stores.navigation.getState().groups[0] as WorkGroup);
        const child = layout?.kind === "split" ? layout.children[1] : null;
        return child?.kind === "split" ? child.sizes : [];
      };
      const drag = (to: number, init: MouseEventInit = {}) => {
        const bar = bars[1] as HTMLElement;
        const fire = (type: string, y: number) => {
          const event = new MouseEvent(type, { clientY: y, bubbles: true, ...init });
          Object.defineProperty(event, "pointerId", { value: 1 });
          bar.dispatchEvent(event);
        };
        fire("pointerdown", 306);
        fire("pointermove", to);
        const snapped = bar.dataset.snapped;
        fire("pointerup", to);
        return snapped;
      };
      return { root, controller, secondColumn, drag };
    }

    it("snaps a bar to another one that is a few pixels away, so the panels line up", () => {
      const { root, controller, secondColumn, drag } = setup();
      expect(drag(301)).toBe("true"); // 1px from the other bar (y = 300)
      expect(secondColumn()[0]).toBeCloseTo(0.5); // exactly the other column's split
      controller.destroy();
      root.remove();
    });

    it("does not snap when far from every other bar, or when Alt is held", () => {
      const far = setup();
      expect(far.drag(280)).toBe("false"); // 20px from y = 300
      expect(far.secondColumn()[0]).toBeCloseTo(0.51 - 26 / 600);
      far.controller.destroy();
      far.root.remove();

      const alt = setup();
      alt.drag(301, { altKey: true });
      expect(alt.secondColumn()[0]).toBeCloseTo(0.51 - 5 / 600);
      alt.controller.destroy();
      alt.root.remove();
    });
  });
});
