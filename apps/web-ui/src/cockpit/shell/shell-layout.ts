import { PANEL_DIMENSIONS } from "../../panel-geometry.js";
import type { Zone1ActivityState } from "../../stores/index.js";
import type { UiPreferences } from "../../ui-preferences.js";
import { PanelResizeHandle } from "../panels/panel-resize.js";

/** Grid columns shared by the title bar and the shell, so headers stay above their zone. */
const DEFAULT_SIDEBAR_WIDTH = PANEL_DIMENSIONS.sidebar.defaultWidth;
const DEFAULT_INSPECTOR_WIDTH = PANEL_DIMENSIONS.inspector.defaultWidth;

function cockpitGridColumns(
  z1: Zone1ActivityState,
  sidebarWidthPx: number | null,
  inspectorWidthPx: number | null,
): string {
  const sidebarWidth = sidebarWidthPx === null ? DEFAULT_SIDEBAR_WIDTH : `${sidebarWidthPx}px`;
  const inspectorWidth =
    inspectorWidthPx === null ? DEFAULT_INSPECTOR_WIDTH : `${inspectorWidthPx}px`;
  const sidebar = z1.sidebarOpen ? sidebarWidth : "0px";
  const inspector = z1.inspectorOpen ? inspectorWidth : "0px";
  return `48px ${sidebar} minmax(0, 1fr) ${inspector}`;
}

/** Owns shell column geometry and resize controls; it never mounts an editor. */
export class ShellLayout {
  private readonly sidebarHandle: PanelResizeHandle;
  private readonly inspectorHandle: PanelResizeHandle;
  constructor(
    doc: Document,
    private readonly shell: HTMLElement,
    sidebar: HTMLElement,
    inspector: HTMLElement,
    private readonly preferences: UiPreferences,
  ) {
    const handle = (panel: "sidebar" | "inspector", element: HTMLElement) =>
      new PanelResizeHandle(doc, panel, {
        currentWidth: () => element.getBoundingClientRect().width,
        setWidth: (width, remember) => preferences.setPanelWidth(panel, width, remember),
      });
    this.sidebarHandle = handle("sidebar", sidebar);
    this.inspectorHandle = handle("inspector", inspector);
    shell.append(this.sidebarHandle.element, this.inspectorHandle.element);
  }
  update(state: Zone1ActivityState): string {
    const { sidebarWidthPx, inspectorWidthPx } = this.preferences.getState();
    this.shell.style.setProperty(
      "--coloride-sidebar-width",
      sidebarWidthPx === null ? DEFAULT_SIDEBAR_WIDTH : `${sidebarWidthPx}px`,
    );
    this.shell.style.setProperty(
      "--coloride-inspector-width",
      inspectorWidthPx === null ? DEFAULT_INSPECTOR_WIDTH : `${inspectorWidthPx}px`,
    );
    this.sidebarHandle.element.hidden = !state.sidebarOpen;
    this.inspectorHandle.element.hidden = !state.inspectorOpen;
    return cockpitGridColumns(state, sidebarWidthPx, inspectorWidthPx);
  }
}
