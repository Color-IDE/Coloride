// @vitest-environment happy-dom
import { ColorideEditorView, InMemoryBinaryHostBridge } from "@coloride/editor-cm6";
import { afterEach, describe, expect, it } from "vitest";
import { CockpitDomController, createCockpitStoreBundle } from "../../index.js";
import type { Inspector } from "../inspector/inspector.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const stores = createCockpitStoreBundle();
  const ipcChannel = new InMemoryBinaryHostBridge();
  const saved: string[] = [];
  const requestSave = ipcChannel.requestAtomicSave.bind(ipcChannel);
  ipcChannel.requestAtomicSave = (documentId, generation) => {
    saved.push(documentId);
    return requestSave(documentId, generation);
  };
  const editorView = new ColorideEditorView({
    initialDocumentId: "src/main.ts",
    initialContent: "const ready = true;",
    ipcChannel,
  });
  const counts: number[] = [];
  const controller = new CockpitDomController({
    rootContainer: root,
    stores,
    editorView,
    readWorkspaceFile: async (path) => `// disk ${path}\n`,
    onUnsavedCountChange: (count) => counts.push(count),
  });
  cleanups.push(() => {
    controller.destroy();
    root.remove();
  });
  const inspector = (controller as unknown as { inspector: Inspector }).inspector;
  /** Shows `path` in the editor and types into it, so it has unsaved changes. */
  const edit = async (path: string) => {
    await inspector.openFile(path);
    editorView.dispatchUserEdit(0, 0, "// edited\n");
  };
  const overlay = () => root.querySelector<HTMLElement>(".coloride-unsaved-overlay");
  const choose = (choice: "save" | "discard" | "cancel") =>
    overlay()?.querySelector<HTMLButtonElement>(`[data-choice="${choice}"]`)?.click();
  return { root, stores, editorView, controller, counts, saved, edit, overlay, choose, inspector };
}

describe("closing the window with unsaved changes", () => {
  it("asks nothing when nothing is unsaved", async () => {
    const { controller, overlay } = setup();
    expect(await controller.confirmClose()).toBe(true);
    expect(overlay()).toBeNull();
  });

  it("reports how many files have unsaved changes, only when the number changes", async () => {
    const { stores, controller, counts, edit } = setup();
    stores.setProjectPath("/projects/a");
    await edit("a.ts");
    expect(counts).toEqual([1]);
    // More typing in the same file does not repeat the report.
    await edit("a.ts");
    expect(counts).toEqual([1]);
    await edit("b.ts");
    expect(counts).toEqual([1, 2]);
    await controller.saveActiveDocument();
    expect(counts).toEqual([1, 2, 1]);
  });

  it("asks over the whole window (the right panel starts closed), counting the files", async () => {
    const { root, stores, controller, overlay, choose, edit } = setup();
    stores.setProjectPath("/projects/a");
    expect(stores.zone1.getState().inspectorOpen).toBe(false);
    await edit("a.ts");
    await edit("b.ts");
    const pending = controller.confirmClose();
    expect(overlay()).not.toBeNull();
    // Not inside Zone 4, which is hidden and inert while closed.
    expect(root.querySelector(".coloride-zone-4-inspector .coloride-unsaved-overlay")).toBeNull();
    expect(
      root.querySelector(".coloride-cockpit-shell > .coloride-unsaved-overlay"),
    ).not.toBeNull();
    expect(overlay()?.textContent).toContain("2 files");
    choose("cancel");
    expect(await pending).toBe(false);
    expect(overlay()).toBeNull();
  });

  it("closes without saving when the user says so, leaving the files as they were", async () => {
    const { stores, controller, choose, edit, saved } = setup();
    stores.setProjectPath("/projects/a");
    await edit("a.ts");
    const pending = controller.confirmClose();
    choose("discard");
    expect(await pending).toBe(true);
    expect(saved).toEqual([]);
  });

  it("saves every file with changes before closing", async () => {
    const { stores, controller, choose, edit, saved, counts } = setup();
    stores.setProjectPath("/projects/a");
    await edit("a.ts");
    await edit("b.ts");
    const pending = controller.confirmClose();
    choose("save");
    expect(await pending).toBe(true);
    expect([...saved].sort()).toEqual(["a.ts", "b.ts"]);
    expect(stores.getUnsavedDocumentIds()).toEqual([]);
    expect(counts.at(-1)).toBe(0);
  });

  it("does not claim to have saved the edits of another project, and lets the user decide", async () => {
    const { stores, controller, choose, edit, overlay, saved } = setup();
    stores.setProjectPath("/projects/a");
    await edit("a.ts");
    // Edits of a project that is not open in the editor can only be saved from that project.
    stores.setProjectPath("/projects/b");
    await settle();
    const pending = controller.confirmClose();
    choose("save");
    await settle();
    expect(saved).toEqual([]);
    expect(overlay()?.textContent).toContain("other project");
    // Cancel keeps the window open.
    choose("cancel");
    expect(await pending).toBe(false);

    const again = controller.confirmClose();
    choose("save");
    await settle();
    choose("discard");
    expect(await again).toBe(true);
  });

  it("does not remember edits that were saved after coming back to a project", async () => {
    const { stores, controller, edit, counts } = setup();
    stores.setProjectPath("/projects/a");
    await edit("a.ts");
    stores.setProjectPath("/projects/b");
    stores.setProjectPath("/projects/a");
    await settle();
    await controller.saveActiveDocument();
    await settle();
    // Nothing is unsaved any more, so closing asks nothing and the report says so.
    expect(await controller.confirmClose()).toBe(true);
    expect(counts.at(-1)).toBe(0);
  });

  it("shows a single prompt when the close is requested twice", async () => {
    const { root, stores, controller, choose, edit } = setup();
    stores.setProjectPath("/projects/a");
    await edit("a.ts");
    const first = controller.confirmClose();
    const second = controller.confirmClose();
    expect(root.querySelectorAll(".coloride-unsaved-overlay")).toHaveLength(1);
    choose("cancel");
    expect(await first).toBe(false);
    expect(await second).toBe(false);
  });
});
