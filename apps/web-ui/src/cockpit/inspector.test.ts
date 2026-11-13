// @vitest-environment happy-dom
import { ColorideEditorView, InMemoryBinaryHostBridge } from "@coloride/editor-cm6";
import { describe, expect, it } from "vitest";
import { CockpitDomController, createCockpitStoreBundle } from "../index.js";

describe("@coloride/web-ui — Zone 4 inspector (editor, tabs, file tree)", () => {
  it("shows the project file tree next to the editor and opens files from it", () => {
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
    const zone4 = controller.getZoneElements().zone4;
    const tree = () => zone4.querySelector<HTMLElement>(".coloride-file-tree");
    expect(tree()?.textContent).toBe("No project open");
    stores.setFileTree([
      { path: "src", name: "src", depth: 0, isDirectory: true, validationState: "UnchangedBlue" },
      {
        path: "src/app.ts",
        name: "app.ts",
        depth: 1,
        isDirectory: false,
        validationState: "UnchangedBlue",
      },
    ]);
    const rows = tree()?.querySelectorAll<HTMLElement>(".cm-coloride-virtual-tree-row");
    expect(rows).toHaveLength(2);
    const filter = zone4.querySelector<HTMLInputElement>(".coloride-file-tree-filter");
    if (!filter) throw new Error("Missing tree filter");
    filter.value = "zzz";
    filter.dispatchEvent(new Event("input"));
    expect(tree()?.textContent).toBe("No matching files");
    filter.value = "APP";
    filter.dispatchEvent(new Event("input"));
    expect(tree()?.querySelectorAll(".cm-coloride-virtual-tree-row")).toHaveLength(2);
    filter.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(filter.value).toBe("");
    zone4
      .querySelectorAll<HTMLElement>(".coloride-file-tree .cm-coloride-virtual-tree-row")[1]
      ?.click();
    expect(stores.zone4.getState().activeDocumentId).toBe("src/app.ts");
    expect(
      rootContainer
        .querySelector('.coloride-inspector-tab[data-path="src/app.ts"]')
        ?.getAttribute("aria-selected"),
    ).toBe("true");
    expect(editorView.getEditorView().dom).toBe(editorDom);
    expect(editorDom.isConnected).toBe(true);
    controller.destroy();
    rootContainer.remove();
  });
  it("keeps opened files as header tabs and closes them with the x", () => {
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
    const tabs = () =>
      Array.from(rootContainer.querySelectorAll<HTMLElement>(".coloride-inspector-tab"));
    const paths = () => tabs().map((tab) => tab.dataset.path);
    const active = () => stores.zone4.getState().activeDocumentId;
    const first = active();
    stores.selectFileFromTree("src/a.cpp");
    stores.selectFileFromTree("src/b.cpp");
    expect(paths()).toEqual([first, "src/a.cpp", "src/b.cpp"]);
    expect(tabs()[1]?.querySelector(".coloride-inspector-tab-icon svg")).not.toBeNull();
    expect(tabs()[1]?.textContent).toContain("a.cpp");

    tabs()[1]?.click();
    expect(active()).toBe("src/a.cpp");
    expect(paths()).toHaveLength(3);

    rootContainer.querySelector<HTMLButtonElement>('[aria-label="Close a.cpp"]')?.click();
    expect(paths()).toEqual([first, "src/b.cpp"]);
    expect(active()).toBe("src/b.cpp");

    for (const name of ["b.cpp", first.split("/").pop() as string]) {
      rootContainer.querySelector<HTMLButtonElement>(`[aria-label="Close ${name}"]`)?.click();
    }
    expect(tabs()).toHaveLength(0);
    expect(
      rootContainer.querySelector<HTMLElement>(".coloride-zone-4-editor-host")?.style.display,
    ).toBe("none");
    expect(rootContainer.querySelector<HTMLElement>(".coloride-zone-4-empty")?.hidden).toBe(false);
    expect(editorView.getEditorView().dom).toBe(editorDom);

    stores.selectFileFromTree("src/c.cpp");
    expect(paths()).toEqual(["src/c.cpp"]);
    expect(rootContainer.querySelector<HTMLElement>(".coloride-zone-4-empty")?.hidden).toBe(true);
    controller.destroy();
    rootContainer.remove();
  });
  it("swaps the header tabs when the active project changes and restores them on return", () => {
    const rootContainer = document.createElement("div");
    document.body.appendChild(rootContainer);
    const stores = createCockpitStoreBundle();
    const editorView = new ColorideEditorView({
      initialDocumentId: "src/main.ts",
      initialContent: "const ready = true;",
      ipcChannel: new InMemoryBinaryHostBridge(),
    });
    const controller = new CockpitDomController({ rootContainer, stores, editorView });
    const paths = () =>
      Array.from(rootContainer.querySelectorAll<HTMLElement>(".coloride-inspector-tab")).map(
        (tab) => tab.dataset.path,
      );
    const empty = () =>
      rootContainer.querySelector<HTMLElement>(".coloride-zone-4-empty")?.hidden === false;

    stores.setProjectPath("/projects/a");
    stores.selectFileFromTree("a1.ts");
    stores.selectFileFromTree("a2.ts");
    expect(paths()).toEqual(["a1.ts", "a2.ts"]);

    stores.setProjectPath("/projects/b");
    expect(paths()).toEqual([]);
    expect(empty()).toBe(true);
    stores.selectFileFromTree("b1.ts");
    expect(paths()).toEqual(["b1.ts"]);
    expect(empty()).toBe(false);

    stores.setProjectPath("/projects/a");
    expect(paths()).toEqual(["a1.ts", "a2.ts"]);
    expect(stores.zone4.getState().activeDocumentId).toBe("a2.ts");
    expect(empty()).toBe(false);
    controller.destroy();
    rootContainer.remove();
  });
});
