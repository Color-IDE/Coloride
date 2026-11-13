import {
  type LayoutNode,
  MIN_PANEL_SIZE_PX,
  minExtentPx,
  nodeAt,
  resizeBoundary,
} from "../layout-tree.js";
import { UI_STRINGS } from "../ui-strings.js";

/** A bar closer than this to another one of the same orientation is pulled onto it. */
const SNAP_DISTANCE_PX = 8;

/** What the resize bars need from the grid that owns them. */
export interface LayoutHandleHost {
  /** The element holding the whole layout (bars of every split live inside it). */
  readonly grid: HTMLElement;
  /** The outermost split on screen; null while nothing is laid out. */
  layoutRoot(): HTMLElement | null;
  /** The layout on screen, which a drag starts from. */
  shownLayout(): LayoutNode | null;
  /** Saves a new layout for the group on screen. */
  save(layout: LayoutNode | null): void;
}

/**
 * The draggable bar between child `boundary` and the next one of the split at `path`. It is
 * absolutely positioned over the boundary (see `applySizes`), so it takes no room.
 */
export function createSeparator(
  host: LayoutHandleHost,
  direction: "row" | "column",
  path: readonly number[],
  boundary: number,
): HTMLElement {
  const doc = host.grid.ownerDocument;
  const bar = doc.createElement("div");
  bar.className = "coloride-layout-handle";
  bar.setAttribute("role", "separator");
  // A row of panels is split by vertical bars, and the other way round.
  bar.setAttribute("aria-orientation", direction === "row" ? "vertical" : "horizontal");
  bar.setAttribute("aria-label", UI_STRINGS.chat.resizePanels);
  bar.tabIndex = 0;

  /** What the drag works with, measured when it starts. */
  const measure = () => {
    const layout = host.shownLayout();
    const split = layout ? nodeAt(layout, path) : null;
    const container = bar.parentElement;
    if (!layout || !split || !container) return null;
    const rect = container.getBoundingClientRect();
    const extent = direction === "row" ? rect.width : rect.height;
    if (!(extent > 0)) return null;
    const side = (index: number) => {
      const child = split.children[index];
      return child ? minExtentPx(child, direction, MIN_PANEL_SIZE_PX) / extent : 0;
    };
    return {
      layout,
      extent,
      min: { before: side(boundary), after: side(boundary + 1) },
      sizes: split.sizes,
    };
  };
  const save = (layout: LayoutNode | null) => host.save(layout);

  let drag: {
    start: number;
    /** Where the bar is on the page when the drag starts, and where the other parallel bars are. */
    center: number;
    targets: readonly number[];
    measured: NonNullable<ReturnType<typeof measure>>;
    layout: LayoutNode | null;
  } | null = null;
  bar.addEventListener("pointerdown", (event) => {
    const measured = measure();
    if (!measured) return;
    event.preventDefault();
    bar.setPointerCapture?.((event as PointerEvent).pointerId);
    // Where this bar and every other bar of the same orientation are on the page. The bars
    // inside this split move with the drag, so they are no use as targets.
    const centerOf = (el: Element) => {
      const rect = el.getBoundingClientRect();
      return direction === "row" ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
    };
    const orientation = bar.getAttribute("aria-orientation");
    const targets = Array.from(host.grid.querySelectorAll(".coloride-layout-handle"))
      .filter(
        (other) =>
          other !== bar &&
          other.getAttribute("aria-orientation") === orientation &&
          !bar.parentElement?.contains(other),
      )
      .map(centerOf);
    drag = {
      start: direction === "row" ? event.clientX : event.clientY,
      center: centerOf(bar),
      targets,
      measured,
      layout: null,
    };
    host.grid.dataset.resizing = direction;
  });
  bar.addEventListener("pointermove", (event) => {
    const layoutRoot = host.layoutRoot();
    if (!drag || !layoutRoot) return;
    const position = direction === "row" ? event.clientX : event.clientY;
    let movedPx = position - drag.start;
    // Line up with the nearest other bar when close to it (Alt turns this off), so panels that
    // sit side by side end up level instead of a few pixels apart.
    let snapped = false;
    if (!event.altKey) {
      const proposed = drag.center + movedPx;
      let nearest: number | null = null;
      for (const target of drag.targets) {
        const distance = Math.abs(target - proposed);
        if (
          distance <= SNAP_DISTANCE_PX &&
          (nearest === null || distance < Math.abs(nearest - proposed))
        )
          nearest = target;
      }
      if (nearest !== null) {
        movedPx = nearest - drag.center;
        snapped = true;
      }
    }
    bar.dataset.snapped = String(snapped);
    const next = resizeBoundary(
      drag.measured.layout,
      path,
      boundary,
      movedPx / drag.measured.extent,
      drag.measured.min,
    );
    drag.layout = next;
    // Live, straight on the DOM: the store is only written when the drag ends.
    if (next) applySizes(next, layoutRoot, true);
  });
  const finish = () => {
    if (!drag) return;
    const { layout, measured } = drag;
    drag = null;
    delete bar.dataset.snapped;
    delete host.grid.dataset.resizing;
    if (layout && layout !== measured.layout) save(layout);
  };
  bar.addEventListener("pointerup", finish);
  bar.addEventListener("pointercancel", finish);

  // Keyboard: arrows move the bar (Shift for larger steps); a double click evens out the
  // two neighbours.
  bar.addEventListener("keydown", (event) => {
    const forward = direction === "row" ? "ArrowRight" : "ArrowDown";
    const backward = direction === "row" ? "ArrowLeft" : "ArrowUp";
    if (event.key !== forward && event.key !== backward) return;
    const measured = measure();
    if (!measured) return;
    event.preventDefault();
    const step = event.shiftKey ? 0.1 : 0.02;
    save(
      resizeBoundary(
        measured.layout,
        path,
        boundary,
        event.key === forward ? step : -step,
        measured.min,
      ),
    );
  });
  bar.addEventListener("dblclick", () => {
    const measured = measure();
    const before = measured?.sizes[boundary];
    const after = measured?.sizes[boundary + 1];
    if (!measured || before === undefined || after === undefined) return;
    save(resizeBoundary(measured.layout, path, boundary, (after - before) / 2, measured.min));
  });
  return bar;
}

/** Identifies the structure of a layout (panels and split directions) but not the sizes. */
export function layoutShape(node: LayoutNode): string {
  return node.kind === "panel"
    ? node.id
    : `${node.direction === "row" ? "r" : "c"}(${node.children.map(layoutShape).join(",")})`;
}

/**
 * Sizes every child of a split with `flex-grow` proportional to its share, and puts each
 * separator over the boundary it moves (the separators are the elements after the children).
 */
export function applySizes(node: LayoutNode, el: HTMLElement, isRoot: boolean): void {
  if (isRoot) el.style.flex = "";
  if (node.kind === "panel") return;
  el.dataset.direction = node.direction;
  const edge = node.direction === "row" ? "left" : "top";
  let offset = 0;
  node.children.forEach((child, index) => {
    const size = node.sizes[index] ?? 0;
    const childEl = el.children[index] as HTMLElement | undefined;
    if (childEl) {
      childEl.style.flex = `${size} 1 0px`;
      applySizes(child, childEl, false);
    }
    offset += size;
    const bar = el.children[node.children.length + index] as HTMLElement | undefined;
    if (bar?.classList.contains("coloride-layout-handle")) bar.style[edge] = `${offset * 100}%`;
  });
}
