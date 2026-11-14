// @vitest-environment happy-dom
import { ColorideEditorView, InMemoryBinaryHostBridge } from "@coloride/editor-cm6";
import { afterEach, describe, expect, it } from "vitest";
import { CockpitDomController, createCockpitStoreBundle } from "../../index.js";
import { UI_PREFERENCES_KEY } from "../../ui-preferences.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  window.localStorage.clear();
});

function mount() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const editorView = new ColorideEditorView({
    initialDocumentId: "src/main.ts",
    initialContent: "",
    ipcChannel: new InMemoryBinaryHostBridge(),
  });
  const controller = new CockpitDomController({
    rootContainer: root,
    stores: createCockpitStoreBundle(),
    editorView,
  });
  cleanups.push(() => {
    controller.destroy();
    editorView.destroy();
    root.remove();
  });
  const body = () => root.querySelector<HTMLElement>(".coloride-zone-4-body") as HTMLElement;
  const action = () =>
    root.querySelector<HTMLButtonElement>(".coloride-file-tree-action") as HTMLButtonElement;
  const edge = () =>
    root.querySelector<HTMLButtonElement>(".coloride-zone-4-tree-edge") as HTMLButtonElement;
  return { body, action, edge };
}

describe("file tree hide / show", () => {
  it("starts visible, hides from its own button and comes back from the edge strip", () => {
    const { body, action, edge } = mount();
    expect(body().dataset.treeHidden).toBe("false");
    expect(edge().hidden).toBe(true);
    expect(action().getAttribute("aria-label")).toBe("Hide file tree");

    action().click();
    expect(body().dataset.treeHidden).toBe("true");
    expect(edge().hidden).toBe(false);
    // Hidden, the same button in the sliding tree keeps it visible instead.
    expect(action().getAttribute("aria-label")).toBe("Keep file tree visible");

    edge().click();
    expect(body().dataset.treeHidden).toBe("false");
    expect(edge().hidden).toBe(true);
  });

  it("Ctrl/Cmd+Shift+E toggles it, and the choice is remembered", () => {
    const { body } = mount();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "E", code: "KeyE", ctrlKey: true, shiftKey: true }),
    );
    expect(body().dataset.treeHidden).toBe("true");
    expect(JSON.parse(window.localStorage.getItem(UI_PREFERENCES_KEY) ?? "{}").treeHidden).toBe(
      true,
    );

    // A new window opens with the tree hidden, as the user left it.
    const again = mount();
    expect(again.body().dataset.treeHidden).toBe("true");
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "e", code: "KeyE", metaKey: true, shiftKey: true }),
    );
    expect(JSON.parse(window.localStorage.getItem(UI_PREFERENCES_KEY) ?? "{}").treeHidden).toBe(
      false,
    );
  });
});
