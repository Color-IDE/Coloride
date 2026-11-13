/** Width limits of the side panel, in pixels (and at most half of the window). */
export const SIDEBAR_MIN_WIDTH_PX = 180;
export const SIDEBAR_MAX_WIDTH_PX = 560;

const STORAGE_KEY = "coloride.sidebarWidthPx";
const KEY_STEP_PX = 16;
const KEY_STEP_LARGE_PX = 64;

/** Keeps a width inside the limits; `windowWidth` caps it at half of the window. */
export function clampSidebarWidth(widthPx: number, windowWidth: number): number {
  const max = Math.max(SIDEBAR_MIN_WIDTH_PX, Math.min(SIDEBAR_MAX_WIDTH_PX, windowWidth / 2));
  return Math.round(Math.min(max, Math.max(SIDEBAR_MIN_WIDTH_PX, widthPx)));
}

/** The width the user chose last time (a per-viewer convenience; null when none or unreadable). */
export function loadSidebarWidth(storage: Pick<Storage, "getItem"> | undefined): number | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const value = raw === null || raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function saveSidebarWidth(
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined,
  widthPx: number | null,
) {
  try {
    if (widthPx === null) storage?.removeItem(STORAGE_KEY);
    else storage?.setItem(STORAGE_KEY, String(widthPx));
  } catch {
    // Not remembering the width is fine.
  }
}

export interface SidebarResizeHost {
  /** Width the panel has on screen now. */
  currentWidth(): number;
  /** Applies a width live; null goes back to the default one. */
  setWidth(widthPx: number | null): void;
  storage?: Storage | undefined;
}

/**
 * The bar between the side panel and the panels of Zone 3: drag it (or use the arrow keys) to
 * make the side panel wider or narrower, double-click it for the default width. The chosen width
 * is remembered between sessions.
 */
export class SidebarResizeHandle {
  readonly element: HTMLElement;
  private drag: { startX: number; startWidth: number; pointerId: number } | null = null;

  constructor(doc: Document, host: SidebarResizeHost) {
    const bar = doc.createElement("div");
    bar.className = "coloride-shell-handle";
    bar.setAttribute("role", "separator");
    bar.setAttribute("aria-orientation", "vertical");
    bar.setAttribute("aria-label", "Resize side panel");
    bar.tabIndex = 0;
    this.element = bar;

    const windowWidth = () => doc.defaultView?.innerWidth ?? 1_200;
    const apply = (widthPx: number, remember: boolean) => {
      const width = clampSidebarWidth(widthPx, windowWidth());
      host.setWidth(width);
      if (remember) saveSidebarWidth(host.storage, width);
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
      apply(drag.startWidth + (event.clientX - drag.startX), false);
    });
    const finish = (event: PointerEvent) => {
      const drag = this.drag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      this.drag = null;
      delete bar.dataset.dragging;
      bar.releasePointerCapture?.(event.pointerId);
      apply(drag.startWidth + (event.clientX - drag.startX), true);
    };
    bar.addEventListener("pointerup", finish);
    bar.addEventListener("pointercancel", finish);
    bar.addEventListener("dblclick", () => {
      host.setWidth(null);
      saveSidebarWidth(host.storage, null);
    });
    bar.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const step = event.shiftKey ? KEY_STEP_LARGE_PX : KEY_STEP_PX;
      apply(host.currentWidth() + (event.key === "ArrowRight" ? step : -step), true);
    });
  }
}
