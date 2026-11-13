/** Which side panel a bar resizes: the left one (the sidebar) or the right one (the inspector). */
export type ResizablePanel = "sidebar" | "inspector";

interface PanelLimits {
  readonly storageKey: string;
  readonly label: string;
  readonly minPx: number;
  readonly maxPx: number;
  /** The panel never takes more than this share of the window. */
  readonly maxShare: number;
  /** The bar sits on the panel's right edge (it grows when dragged right) or its left edge. */
  readonly edge: "right" | "left";
}

export const PANEL_LIMITS: Record<ResizablePanel, PanelLimits> = {
  sidebar: {
    storageKey: "coloride.sidebarWidthPx",
    label: "Resize side panel",
    minPx: 180,
    maxPx: 560,
    maxShare: 0.5,
    edge: "right",
  },
  inspector: {
    storageKey: "coloride.inspectorWidthPx",
    label: "Resize right panel",
    minPx: 280,
    maxPx: 1_000,
    maxShare: 0.7,
    edge: "left",
  },
};

const KEY_STEP_PX = 16;
const KEY_STEP_LARGE_PX = 64;

/** Keeps a width inside the panel's limits and its share of the window. */
export function clampPanelWidth(
  panel: ResizablePanel,
  widthPx: number,
  windowWidth: number,
): number {
  const { minPx, maxPx, maxShare } = PANEL_LIMITS[panel];
  const max = Math.max(minPx, Math.min(maxPx, windowWidth * maxShare));
  return Math.round(Math.min(max, Math.max(minPx, widthPx)));
}

/** The width the user chose last time (a per-viewer convenience; null when none or unreadable). */
export function loadPanelWidth(
  panel: ResizablePanel,
  storage: Pick<Storage, "getItem"> | undefined,
): number | null {
  try {
    const raw = storage?.getItem(PANEL_LIMITS[panel].storageKey);
    const value = raw === null || raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function savePanelWidth(
  panel: ResizablePanel,
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined,
  widthPx: number | null,
): void {
  try {
    const key = PANEL_LIMITS[panel].storageKey;
    if (widthPx === null) storage?.removeItem(key);
    else storage?.setItem(key, String(widthPx));
  } catch {
    // Not remembering the width is fine.
  }
}

export interface PanelResizeHost {
  /** Width the panel has on screen now. */
  currentWidth(): number;
  /** Applies a width live; null goes back to the default one. */
  setWidth(widthPx: number | null): void;
  storage?: Storage | undefined;
}

/**
 * The bar on the edge of a side panel: drag it (or use the arrow keys) to make the panel wider
 * or narrower, double-click it for the default width. The chosen width is remembered between
 * sessions.
 */
export class PanelResizeHandle {
  readonly element: HTMLElement;
  private drag: { startX: number; startWidth: number; pointerId: number } | null = null;

  constructor(doc: Document, panel: ResizablePanel, host: PanelResizeHost) {
    const limits = PANEL_LIMITS[panel];
    // Dragging towards the panel's body makes it narrower: the sign depends on the edge.
    const direction = limits.edge === "right" ? 1 : -1;
    const bar = doc.createElement("div");
    bar.className = "coloride-shell-handle";
    bar.dataset.panel = panel;
    bar.setAttribute("role", "separator");
    bar.setAttribute("aria-orientation", "vertical");
    bar.setAttribute("aria-label", limits.label);
    bar.tabIndex = 0;
    this.element = bar;

    const windowWidth = () => doc.defaultView?.innerWidth ?? 1_200;
    const apply = (widthPx: number, remember: boolean) => {
      const width = clampPanelWidth(panel, widthPx, windowWidth());
      host.setWidth(width);
      if (remember) savePanelWidth(panel, host.storage, width);
    };

    bar.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      this.drag = {
        startX: event.clientX,
        startWidth: host.currentWidth(),
        pointerId: event.pointerId,
      };
      bar.setPointerCapture?.(event.pointerId);
      bar.dataset.dragging = "true";
    });
    bar.addEventListener("pointermove", (event) => {
      const drag = this.drag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      apply(drag.startWidth + direction * (event.clientX - drag.startX), false);
    });
    const finish = (event: PointerEvent) => {
      const drag = this.drag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      this.drag = null;
      delete bar.dataset.dragging;
      bar.releasePointerCapture?.(event.pointerId);
      apply(drag.startWidth + direction * (event.clientX - drag.startX), true);
    };
    bar.addEventListener("pointerup", finish);
    bar.addEventListener("pointercancel", finish);
    bar.addEventListener("dblclick", () => {
      host.setWidth(null);
      savePanelWidth(panel, host.storage, null);
    });
    bar.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const step = event.shiftKey ? KEY_STEP_LARGE_PX : KEY_STEP_PX;
      const towardsRight = event.key === "ArrowRight" ? 1 : -1;
      apply(host.currentWidth() + direction * towardsRight * step, true);
    });
  }
}
