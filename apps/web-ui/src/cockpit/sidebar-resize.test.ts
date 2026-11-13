// @vitest-environment happy-dom
import { ColorideEditorView, InMemoryBinaryHostBridge } from "@coloride/editor-cm6";
import { afterEach, describe, expect, it } from "vitest";
import { CockpitDomController, createCockpitStoreBundle } from "../index.js";
import { SIDEBAR_MAX_WIDTH_PX, SIDEBAR_MIN_WIDTH_PX, clampSidebarWidth } from "./sidebar-resize.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  window.localStorage.clear();
});

function mount() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const stores = createCockpitStoreBundle();
  const editorView = new ColorideEditorView({
    initialDocumentId: "src/main.ts",
    initialContent: "",
    ipcChannel: new InMemoryBinaryHostBridge(),
  });
  const controller = new CockpitDomController({ rootContainer: root, stores, editorView });
  cleanups.push(() => {
    controller.destroy();
    editorView.destroy();
    root.remove();
  });
  const shell = root.querySelector<HTMLElement>(".coloride-cockpit-shell") as HTMLElement;
  const sidebar = root.querySelector<HTMLElement>(".coloride-zone-2-sidebar") as HTMLElement;
  const handle = root.querySelector<HTMLElement>(".coloride-shell-handle") as HTMLElement;
  // happy-dom lays nothing out: the panel is 240px wide.
  sidebar.getBoundingClientRect = () => ({ width: 240 }) as DOMRect;
  const pointer = (type: string, x: number) =>
    handle.dispatchEvent(
      Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, button: 0 }), {
        pointerId: 1,
      }),
    );
  const columns = () => shell.style.gridTemplateColumns;
  return { stores, shell, handle, pointer, columns };
}

describe("side panel resize bar", () => {
  it("limits the width", () => {
    expect(clampSidebarWidth(10, 1_400)).toBe(SIDEBAR_MIN_WIDTH_PX);
    expect(clampSidebarWidth(5_000, 3_000)).toBe(SIDEBAR_MAX_WIDTH_PX);
    // Never more than half of a small window.
    expect(clampSidebarWidth(500, 800)).toBe(400);
  });

  it("dragging the bar widens or narrows the panel, and a double click restores the default", () => {
    const { handle, pointer, columns } = mount();
    const initial = columns();
    expect(initial).toContain("clamp(200px, 19vw, 280px)");
    pointer("pointerdown", 300);
    pointer("pointermove", 380);
    expect(columns()).toContain("320px");
    expect(handle.dataset.dragging).toBe("true");
    pointer("pointerup", 380);
    expect(handle.dataset.dragging).toBeUndefined();
    expect(window.localStorage.getItem("coloride.sidebarWidthPx")).toBe("320");

    pointer("pointerdown", 380);
    pointer("pointermove", 0);
    pointer("pointerup", 0);
    expect(columns()).toContain(`${SIDEBAR_MIN_WIDTH_PX}px`);

    handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(columns()).toBe(initial);
    expect(window.localStorage.getItem("coloride.sidebarWidthPx")).toBeNull();
  });

  it("the arrow keys resize it, the bar hides with the panel, and the width is remembered", () => {
    const { handle, stores, columns } = mount();
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(columns()).toContain("256px");
    expect(handle.hidden).toBe(false);
    stores.toggleSidebar(false);
    expect(handle.hidden).toBe(true);
    stores.toggleSidebar(true);
    expect(columns()).toContain("256px");

    // A new window starts from the width the user chose.
    const again = mount();
    expect(again.columns()).toContain("256px");
  });
});
