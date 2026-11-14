import { type LayoutNode, movePanel, panelIds, swapPanels } from "../../layout/layout-tree.js";

/** A header pressed and moved less than this is a click, not a drag. */
const DRAG_THRESHOLD_PX = 5;

/** Where a dragged panel would land on the panel under the pointer. */
type DropZone = "left" | "right" | "top" | "bottom" | "center";

/** The edge nearest the pointer, or the middle (inner half of each side) of the target. */
function dropZoneAt(rect: DOMRect, x: number, y: number): DropZone {
  if (!(rect.width > 0) || !(rect.height > 0)) return "center";
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  if (rx > 0.25 && rx < 0.75 && ry > 0.25 && ry < 0.75) return "center";
  const edges: Array<[DropZone, number]> = [
    ["left", rx],
    ["right", 1 - rx],
    ["top", ry],
    ["bottom", 1 - ry],
  ];
  edges.sort((a, b) => a[1] - b[1]);
  return (edges[0] as [DropZone, number])[0];
}

/** What a panel drag needs from the grid that owns the panels. */
export interface PanelDragHost {
  readonly grid: HTMLElement;
  /** The element of a panel on screen. */
  cell(chatId: string): HTMLElement | undefined;
  shownLayout(): LayoutNode | null;
  /** Whether one panel is shown alone (nothing to drag onto). */
  maximized(): boolean;
  /** Saves a new layout for the group on screen. */
  save(layout: LayoutNode): void;
}

export class PanelDrag {
  /** Shown over the panel a dragged one would land on. */
  private readonly dropIndicator: HTMLElement;
  private drag: {
    chatId: string;
    header: HTMLElement;
    pointerId: number;
    startX: number;
    startY: number;
    started: boolean;
    target: { chatId: string; zone: DropZone } | null;
  } | null = null;

  constructor(private readonly host: PanelDragHost) {
    this.dropIndicator = host.grid.ownerDocument.createElement("div");
    this.dropIndicator.className = "coloride-drop-indicator";
  }

  /**
   * Dragging a panel by its header moves it: dropped on an edge of another panel it goes on
   * that side of it; dropped in the middle the two exchange places. A short press is a click.
   */
  begin(chatId: string, header: HTMLElement, event: PointerEvent): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    // With one panel, or one shown alone, there is nowhere to go.
    if (this.host.maximized() || panelIds(this.host.shownLayout()).length < 2) return;
    this.drag = {
      chatId,
      header,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
      target: null,
    };
    header.setPointerCapture?.(event.pointerId);
  }

  move(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.started) {
      if (
        Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD_PX &&
        Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD_PX
      )
        return;
      drag.started = true;
      this.host.grid.dataset.dragging = drag.chatId;
      this.host.cell(drag.chatId)?.setAttribute("data-dragging", "true");
    }
    const doc = this.host.grid.ownerDocument;
    const under = doc.elementFromPoint?.(event.clientX, event.clientY) ?? null;
    const cellEl = under?.closest<HTMLElement>(".coloride-chat-cell") ?? null;
    const targetId = cellEl?.dataset.chatId;
    if (!cellEl || !targetId || targetId === drag.chatId || !this.host.cell(targetId)) {
      drag.target = null;
      this.dropIndicator.remove();
      return;
    }
    const zone = dropZoneAt(cellEl.getBoundingClientRect(), event.clientX, event.clientY);
    drag.target = { chatId: targetId, zone };
    this.dropIndicator.dataset.zone = zone;
    if (this.dropIndicator.parentElement !== cellEl) cellEl.append(this.dropIndicator);
  }

  end(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { chatId, target, started } = drag;
    this.cancel();
    const layout = this.host.shownLayout();
    if (!started || !target || !layout) return;
    const next =
      target.zone === "center"
        ? swapPanels(layout, chatId, target.chatId)
        : movePanel(
            layout,
            chatId,
            target.chatId,
            target.zone === "left" || target.zone === "right" ? "row" : "column",
            target.zone === "left" || target.zone === "top" ? "before" : "after",
          );
    if (next && next !== layout) this.host.save(next);
  }

  cancel(): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    drag.header.releasePointerCapture?.(drag.pointerId);
    delete this.host.grid.dataset.dragging;
    this.host.cell(drag.chatId)?.removeAttribute("data-dragging");
    this.dropIndicator.remove();
  }
}
