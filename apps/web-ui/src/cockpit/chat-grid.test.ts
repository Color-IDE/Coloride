// @vitest-environment happy-dom
import { ColorideEditorView, InMemoryBinaryHostBridge } from "@coloride/editor-cm6";
import { describe, expect, it } from "vitest";
import { CockpitDomController, createCockpitStoreBundle } from "../index.js";

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
  it("shows the selected session in the single-panel view and restores it when returning to a group", () => {
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
    stores.selectChat("b");
    expect(root.querySelector<HTMLElement>(".coloride-chat-cell")?.dataset.chatId).toBe("b");
    stores.createWorkGroup("Other");
    stores.selectWorkGroup("initial-group");
    expect(root.querySelector<HTMLElement>(".coloride-chat-cell")?.dataset.chatId).toBe("b");
    expect(editorView.getStoreSnapshot().mountCount).toBe(1);
    controller.destroy();
    editorView.destroy();
    root.remove();
  });
});
