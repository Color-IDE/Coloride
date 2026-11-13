// @vitest-environment happy-dom
import { ColorideEditorView, InMemoryBinaryHostBridge } from "@coloride/editor-cm6";
import { afterEach, describe, expect, it } from "vitest";
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
        .querySelector('.coloride-zone-4-header .coloride-header-tab[data-path="src/app.ts"]')
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
      Array.from(
        rootContainer.querySelectorAll<HTMLElement>(".coloride-zone-4-header .coloride-header-tab"),
      );
    const paths = () => tabs().map((tab) => tab.dataset.path);
    const active = () => stores.zone4.getState().activeDocumentId;
    const first = active();
    stores.selectFileFromTree("src/a.cpp");
    stores.selectFileFromTree("src/b.cpp");
    expect(paths()).toEqual([first, "src/a.cpp", "src/b.cpp"]);
    expect(tabs()[1]?.querySelector(".coloride-header-tab-icon svg")).not.toBeNull();
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
      Array.from(
        rootContainer.querySelectorAll<HTMLElement>(".coloride-zone-4-header .coloride-header-tab"),
      ).map((tab) => tab.dataset.path);
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

  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  function setup() {
    const rootContainer = document.createElement("div");
    document.body.appendChild(rootContainer);
    const stores = createCockpitStoreBundle();
    const editorView = new ColorideEditorView({
      initialDocumentId: "src/main.ts",
      initialContent: "const ready = true;",
      ipcChannel: new InMemoryBinaryHostBridge(),
    });
    const controller = new CockpitDomController({ rootContainer, stores, editorView });
    const tab = (path: string) =>
      rootContainer.querySelector<HTMLElement>(
        `.coloride-zone-4-header .coloride-header-tab[data-path="${path}"]`,
      );
    const dotShown = (path: string) =>
      tab(path)?.querySelector<HTMLElement>(".coloride-header-tab-dot")?.hidden === false;
    const close = (path: string) =>
      rootContainer
        .querySelector<HTMLButtonElement>(`[aria-label="Close ${path.split("/").pop()}"]`)
        ?.click();
    const dialog = () => rootContainer.querySelector<HTMLElement>(".coloride-unsaved-dialog");
    const choose = (choice: string) =>
      rootContainer.querySelector<HTMLButtonElement>(`[data-choice="${choice}"]`)?.click();
    cleanups.push(() => {
      controller.destroy();
      rootContainer.remove();
    });
    return { stores, editorView, tab, dotShown, close, dialog, choose, root: rootContainer };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("keeps unsaved edits of a project while another project is shown", () => {
    const { stores } = setup();
    stores.setProjectPath("/projects/a");
    stores.selectFileFromTree("a1.ts", "on disk A");
    stores.updateInMemoryDocumentContent("a1.ts", "edited in A", true);

    stores.setProjectPath("/projects/b");
    // Project B has a file with the same relative path: it takes over the shared buffer.
    stores.selectFileFromTree("a1.ts", "on disk B");
    expect(stores.getDocumentContent("a1.ts")).toBe("on disk B");

    stores.setProjectPath("/projects/a");
    expect(stores.getDocumentContent("a1.ts")).toBe("edited in A");
    expect(stores.isDocumentUnsaved("a1.ts")).toBe(true);
  });

  it("shows the unsaved dot on every tab that has changes, not only the active one", () => {
    const { stores, editorView, dotShown } = setup();
    stores.selectFileFromTree("src/a.ts", "const a = 1;");
    editorView.dispatchUserEdit(0, 0, "// ");
    expect(dotShown("src/a.ts")).toBe(true);

    stores.selectFileFromTree("src/b.ts", "const b = 1;");
    expect(dotShown("src/b.ts")).toBe(false);
    expect(dotShown("src/a.ts")).toBe(true);
  });

  it("asks before closing a tab with unsaved changes and honours each choice", async () => {
    const { stores, editorView, tab, close, dialog, choose } = setup();
    stores.selectFileFromTree("src/a.ts", "const a = 1;");
    editorView.dispatchUserEdit(0, 0, "// ");

    close("src/a.ts");
    expect(dialog()).not.toBeNull();
    choose("cancel");
    await settle();
    expect(dialog()).toBeNull();
    expect(tab("src/a.ts")).not.toBeNull();
    expect(stores.isDocumentUnsaved("src/a.ts")).toBe(true);

    close("src/a.ts");
    choose("discard");
    await settle();
    expect(tab("src/a.ts")).toBeNull();
    expect(stores.getDocumentContent("src/a.ts")).toBeUndefined();

    stores.selectFileFromTree("src/c.ts", "const c = 1;");
    editorView.dispatchUserEdit(0, 0, "// ");
    close("src/c.ts");
    choose("save");
    await settle();
    await settle();
    expect(tab("src/c.ts")).toBeNull();
    expect(stores.isDocumentUnsaved("src/c.ts")).toBe(false);
  });

  it("closes a tab without asking when it has no unsaved changes", () => {
    const { stores, tab, close, dialog } = setup();
    stores.selectFileFromTree("src/a.ts", "const a = 1;");
    close("src/a.ts");
    expect(dialog()).toBeNull();
    expect(tab("src/a.ts")).toBeNull();
  });

  it("gives each work group its own file tabs, and an empty group shows the empty state", () => {
    const { stores, tab, root } = setup();
    const paths = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(".coloride-zone-4-header .coloride-header-tab"),
      ).map((el) => el.dataset.path);
    const emptyShown = () =>
      root.querySelector<HTMLElement>(".coloride-zone-4-empty")?.hidden === false;
    stores.selectFileFromTree("src/a.ts", "a");
    stores.selectFileFromTree("src/b.ts", "b");
    expect(paths()).toEqual(expect.arrayContaining(["src/a.ts", "src/b.ts"]));
    const first = paths();

    // A new (empty) group has no files: the right side changes even though no session is selected.
    stores.createWorkGroup("Other");
    expect(paths()).toEqual([]);
    expect(emptyShown()).toBe(true);
    stores.selectFileFromTree("src/other.ts", "o");
    expect(paths()).toEqual(["src/other.ts"]);
    expect(emptyShown()).toBe(false);

    stores.selectWorkGroup("initial-group");
    expect(paths()).toEqual(first);
    expect(tab("src/other.ts")).toBeNull();
    stores.selectWorkGroup(stores.navigation.getState().groups[1]?.id as string);
    expect(paths()).toEqual(["src/other.ts"]);
  });

  it("shares unsaved edits between the groups of a project, because it is the same file", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const stores = createCockpitStoreBundle();
    const editorView = new ColorideEditorView({
      initialDocumentId: "src/main.ts",
      initialContent: "const ready = true;",
      ipcChannel: new InMemoryBinaryHostBridge(),
    });
    let reads = 0;
    const controller = new CockpitDomController({
      rootContainer: root,
      stores,
      editorView,
      readWorkspaceFile: async () => {
        reads += 1;
        return "on disk";
      },
    });
    cleanups.push(() => {
      controller.destroy();
      root.remove();
    });
    stores.setFileTree([
      {
        path: "src/a.ts",
        name: "a.ts",
        depth: 0,
        isDirectory: false,
        validationState: "UnchangedBlue",
      },
    ]);
    const openFromTree = async () => {
      root
        .querySelector<HTMLElement>(".coloride-zone-4-tree-column .cm-coloride-virtual-tree-row")
        ?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    await openFromTree();
    expect(reads).toBe(1);
    stores.updateInMemoryDocumentContent("src/a.ts", "edited", true);

    stores.createWorkGroup("Other");
    await openFromTree();
    // Same project, same file: the unsaved buffer is reused, not reloaded from disk.
    expect(reads).toBe(1);
    expect(stores.getDocumentContent("src/a.ts")).toBe("edited");
    expect(stores.isDocumentUnsaved("src/a.ts")).toBe(true);
  });
});
