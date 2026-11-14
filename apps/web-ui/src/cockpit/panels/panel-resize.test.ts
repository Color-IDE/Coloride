// @vitest-environment happy-dom
import { ColorideEditorView, InMemoryBinaryHostBridge } from "@coloride/editor-cm6";
import { afterEach, describe, expect, it } from "vitest";
import { CockpitDomController, createCockpitStoreBundle } from "../../index.js";
import { UI_PREFERENCES_KEY } from "../../ui-preferences.js";
import { PANEL_LIMITS, clampPanelWidth } from "./panel-resize.js";

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
  // The right panel starts closed; the bars of both panels are tested open.
  stores.toggleInspector(true);
  cleanups.push(() => {
    controller.destroy();
    editorView.destroy();
    root.remove();
  });
  const shell = root.querySelector<HTMLElement>(".coloride-cockpit-shell") as HTMLElement;
  const sidebar = root.querySelector<HTMLElement>(".coloride-zone-2-sidebar") as HTMLElement;
  const inspector = root.querySelector<HTMLElement>(".coloride-zone-4-inspector") as HTMLElement;
  const handle = (panel: string) =>
    root.querySelector<HTMLElement>(`.coloride-shell-handle[data-panel="${panel}"]`) as HTMLElement;
  // happy-dom lays nothing out: the sidebar is 240px wide and the inspector 480px.
  sidebar.getBoundingClientRect = () => ({ width: 240 }) as DOMRect;
  inspector.getBoundingClientRect = () => ({ width: 480 }) as DOMRect;
  const pointer = (target: HTMLElement, type: string, x: number) =>
    target.dispatchEvent(
      Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, button: 0 }), {
        pointerId: 1,
      }),
    );
  const columns = () => shell.style.gridTemplateColumns;
  return { stores, shell, handle, pointer, columns };
}

describe("side panel resize bars", () => {
  it("limits the widths", () => {
    expect(clampPanelWidth("sidebar", 10, 1_400)).toBe(PANEL_LIMITS.sidebar.minPx);
    expect(clampPanelWidth("sidebar", 5_000, 3_000)).toBe(PANEL_LIMITS.sidebar.maxPx);
    // Never more than half of a small window for the sidebar, 70% for the inspector.
    expect(clampPanelWidth("sidebar", 500, 800)).toBe(400);
    expect(clampPanelWidth("inspector", 900, 1_000)).toBe(700);
    expect(clampPanelWidth("inspector", 10, 1_400)).toBe(PANEL_LIMITS.inspector.minPx);
  });

  it("dragging the sidebar bar widens or narrows it, and a double click restores the default", () => {
    const { handle, pointer, columns } = mount();
    const bar = handle("sidebar");
    const initial = columns();
    expect(initial).toContain("clamp(200px, 19vw, 280px)");
    pointer(bar, "pointerdown", 300);
    pointer(bar, "pointermove", 380);
    expect(columns()).toContain("320px");
    expect(bar.dataset.dragging).toBe("true");
    pointer(bar, "pointerup", 380);
    expect(bar.dataset.dragging).toBeUndefined();
    expect(JSON.parse(window.localStorage.getItem(UI_PREFERENCES_KEY) ?? "{}").sidebarWidthPx).toBe(
      320,
    );

    pointer(bar, "pointerdown", 380);
    pointer(bar, "pointermove", 0);
    pointer(bar, "pointerup", 0);
    expect(columns()).toContain(`${PANEL_LIMITS.sidebar.minPx}px`);

    bar.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(columns()).toBe(initial);
    expect(
      JSON.parse(window.localStorage.getItem(UI_PREFERENCES_KEY) ?? "{}").sidebarWidthPx,
    ).toBeNull();
  });

  it("dragging the inspector bar to the left makes the inspector wider", () => {
    const { handle, pointer, columns } = mount();
    const bar = handle("inspector");
    expect(columns()).toContain("clamp(300px, 45%, 640px)");
    pointer(bar, "pointerdown", 900);
    pointer(bar, "pointermove", 800);
    expect(columns()).toContain("580px");
    pointer(bar, "pointerup", 800);
    expect(
      JSON.parse(window.localStorage.getItem(UI_PREFERENCES_KEY) ?? "{}").inspectorWidthPx,
    ).toBe(580);
    // To the right: narrower (the stub measures 480px at the start of each drag, so 200px to
    // the right would give 280px, which is also the limit).
    pointer(bar, "pointerdown", 800);
    pointer(bar, "pointermove", 1_000);
    pointer(bar, "pointerup", 1_000);
    expect(columns()).toContain(`${PANEL_LIMITS.inspector.minPx}px`);
    bar.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(columns()).toContain("clamp(300px, 45%, 640px)");
  });

  it("the arrow keys resize, the bars hide with their panel, and the widths are remembered", () => {
    const { handle, stores, columns } = mount();
    handle("sidebar").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(columns()).toContain("256px");
    // On the inspector's edge, the left arrow pushes the bar left: wider.
    handle("inspector").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    expect(columns()).toContain("496px");

    expect(handle("sidebar").hidden).toBe(false);
    stores.toggleSidebar(false);
    expect(handle("sidebar").hidden).toBe(true);
    stores.toggleSidebar(true);
    expect(columns()).toContain("256px");
    stores.toggleInspector(false);
    expect(handle("inspector").hidden).toBe(true);

    // A new window starts from the widths the user chose.
    const again = mount();
    expect(again.columns()).toContain("256px");
    expect(again.columns()).toContain("496px");
  });
});
