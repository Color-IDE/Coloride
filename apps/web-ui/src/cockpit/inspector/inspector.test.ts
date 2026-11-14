// @vitest-environment happy-dom
import { ColorideEditorView, InMemoryBinaryHostBridge } from "@coloride/editor-cm6";
import { afterEach, describe, expect, it } from "vitest";
import { CockpitDomController, createCockpitStoreBundle } from "../../index.js";
import type { Inspector } from "./inspector.js";

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

  it("empties the right side when an empty group is selected from the sidebar, in any project", () => {
    const { stores, root } = setup();
    const z4Tabs = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(".coloride-zone-4-header .coloride-header-tab"),
      ).map((el) => el.dataset.path);
    const empty = () => root.querySelector<HTMLElement>(".coloride-zone-4-empty")?.hidden === false;
    const editorShown = () =>
      root.querySelector<HTMLElement>(".coloride-zone-4-editor-host")?.style.display !== "none";
    const clickGroup = (id: string) =>
      root.querySelector<HTMLButtonElement>(`.sidebar-row-select[data-group-id="${id}"]`)?.click();

    stores.setProjectPath("/projects/a");
    stores.selectFileFromTree("a1.ts", "one");
    stores.createWorkGroup("Empty");
    const emptyId = stores.navigation.getState().groups[1]?.id as string;
    expect(z4Tabs()).toEqual([]);

    clickGroup("initial-group");
    expect(z4Tabs()).toContain("a1.ts");
    expect(editorShown()).toBe(true);

    stores.setFileTree([
      {
        path: "a1.ts",
        name: "a1.ts",
        depth: 0,
        isDirectory: false,
        validationState: "UnchangedBlue",
      },
    ]);
    const z4Element = root.querySelector<HTMLElement>(".coloride-zone-4-inspector") as HTMLElement;
    const selectedRows = () =>
      root.querySelectorAll(
        '.coloride-zone-4-tree-column .cm-coloride-virtual-tree-row[aria-selected="true"]',
      ).length;
    clickGroup("initial-group");
    stores.selectFileFromTree("a1.ts");
    expect(selectedRows()).toBe(1);
    expect(z4Element.dataset.activeDocumentId).toBe("a1.ts");

    clickGroup(emptyId);
    expect(stores.navigation.getState().activeGroupId).toBe(emptyId);
    expect(z4Tabs()).toEqual([]);
    expect(empty()).toBe(true);
    expect(editorShown()).toBe(false);
    // Nothing of the previous group's file lingers: no selected tree row, no active document.
    expect(selectedRows()).toBe(0);
    expect(z4Element.dataset.activeDocumentId).toBe("");
    expect(z4Element.dataset.unsavedChanges).toBe("false");

    // Another project whose only group is empty, then back.
    stores.setProjectPath("/projects/b");
    expect(z4Tabs()).toEqual([]);
    expect(empty()).toBe(true);
    stores.setProjectPath("/projects/a");
    expect(stores.navigation.getState().activeGroupId).toBe(emptyId);
    expect(z4Tabs()).toEqual([]);
    expect(empty()).toBe(true);
  });

  function setupWithDisk(read: (path: string) => Promise<string>) {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const stores = createCockpitStoreBundle();
    const ipcChannel = new InMemoryBinaryHostBridge();
    const editorView = new ColorideEditorView({
      initialDocumentId: "src/main.ts",
      initialContent: "const ready = true;",
      ipcChannel,
    });
    const controller = new CockpitDomController({
      rootContainer: root,
      stores,
      editorView,
      readWorkspaceFile: read,
    });
    cleanups.push(() => {
      controller.destroy();
      root.remove();
    });
    // The Zone 4 inspector's own open, which the tree, the tabs and the search all go through.
    const inspector = (controller as unknown as { inspector: Inspector }).inspector;
    const openFile = (path: string) => inspector.openFile(path);
    return { stores, editorView, ipcChannel, openFile, root };
  }

  it("loads the other project's file into the editor when both have the same relative path", async () => {
    const disk: Record<string, string> = {
      "/projects/a": "name = A",
      "/projects/b": "name = B",
    };
    let project = "/projects/a";
    const { stores, editorView, openFile } = setupWithDisk(async () => disk[project] as string);
    stores.setProjectPath(project);
    expect(await openFile("package.json")).toBe(true);
    expect(editorView.getDocumentText()).toBe("name = A");
    const generationInA = editorView.getStoreSnapshot().sessionGeneration;

    project = "/projects/b";
    stores.setProjectPath(project);
    expect(await openFile("package.json")).toBe(true);
    // Same id, other file: the editor (and the host session it saves through) moved to B.
    expect(editorView.getDocumentText()).toBe("name = B");
    expect(editorView.getStoreSnapshot().sessionGeneration).toBeGreaterThan(generationInA);
    expect(stores.isDocumentUnsaved("package.json")).toBe(false);
  });

  it("drops a disk read that a later open overtook, and saves only the file it waited for", async () => {
    const pending = new Map<string, (text: string) => void>();
    const { stores, editorView, openFile } = setupWithDisk(
      (path) => new Promise((resolve) => pending.set(path, resolve)),
    );
    stores.setProjectPath("/projects/a");
    const big = openFile("big.ts");
    const small = openFile("small.ts");
    pending.get("small.ts")?.("small");
    expect(await small).toBe(true);
    pending.get("big.ts")?.("big");
    expect(await big).toBe(false);
    expect(stores.zone4.getState().activeDocumentId).toBe("small.ts");
    expect(editorView.getDocumentText()).toBe("small");

    // A read still running when the group changes never lands in the new group.
    const late = openFile("late.ts");
    stores.createWorkGroup("Other");
    pending.get("late.ts")?.("late");
    expect(await late).toBe(false);
    expect(stores.zone4.getState().activeDocumentId).toBe("small.ts");
  });

  it("saving from the close dialog waits for the tab to be shown, then saves that file", async () => {
    const pending = new Map<string, (text: string) => void>();
    const saved: string[] = [];
    const { stores, editorView, ipcChannel, root, openFile } = setupWithDisk(
      (path) => new Promise((resolve) => pending.set(path, resolve)),
    );
    const requestSave = ipcChannel.requestAtomicSave.bind(ipcChannel);
    ipcChannel.requestAtomicSave = (documentId, generation) => {
      saved.push(documentId);
      return requestSave(documentId, generation);
    };
    stores.setProjectPath("/projects/a");
    const first = openFile("one.ts");
    pending.get("one.ts")?.("one");
    await first;
    stores.updateInMemoryDocumentContent("one.ts", "one edited", true);
    const second = openFile("two.ts");
    pending.get("two.ts")?.("two");
    await second;
    editorView.dispatchUserEdit(0, 0, "2 ");
    expect(stores.isDocumentUnsaved("two.ts")).toBe(true);

    // Close the unsaved one.ts tab (not shown) and choose Save: one.ts comes forward, then saves.
    root.querySelector<HTMLButtonElement>('[aria-label="Close one.ts"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    root.querySelector<HTMLButtonElement>('[data-choice="save"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // one.ts was saved (not the file that happened to be shown) and its tab closed; two.ts is
    // shown again and keeps its own unsaved edit.
    expect(saved).toEqual(["one.ts"]);
    expect(root.querySelector('[aria-label="Close one.ts"]')).toBeNull();
    expect(stores.zone4.getState().activeDocumentId).toBe("two.ts");
    expect(stores.isDocumentUnsaved("two.ts")).toBe(true);
  });
});
