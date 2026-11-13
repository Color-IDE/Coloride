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
    expect(rootContainer.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      "Authentication",
    );
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
});
