import { PANEL_DIMENSIONS, type PanelSide } from "../../panel-geometry.js";
/** Which side panel a bar resizes: the left one (the sidebar) or the right one (the inspector). */
export type ResizablePanel = PanelSide;

interface PanelLimits {
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
    label: "Resize side panel",
    ...PANEL_DIMENSIONS.sidebar,
    edge: "right",
  },
  inspector: {
    label: "Resize right panel",
    ...PANEL_DIMENSIONS.inspector,
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

export interface PanelResizeHost {
  /** Width the panel has on screen now. */
  currentWidth(): number;
  /** Applies a width live; null goes back to the default one. */
  setWidth(widthPx: number | null, remember: boolean): void;
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
      host.setWidth(width, remember);
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
      host.setWidth(null, true);
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
