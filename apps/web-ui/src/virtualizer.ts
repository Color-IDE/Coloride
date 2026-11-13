import type { ColorideValidationState } from "@coloride/protocol-types";
import type { CockpitChatMessage, CockpitFileTreeNode } from "./stores.js";

export interface VirtualWindowSlice<T> {
  readonly totalCount: number;
  readonly totalHeightPx: number;
  readonly startIndex: number;
  readonly endIndexExclusive: number;
  readonly offsetTopPx: number;
  readonly visibleItems: readonly T[];
}

export interface VirtualListOptions {
  readonly rowHeightPx?: number;
  readonly overscan?: number;
}

/**
 * Pure O(1) virtual window calculator capable of slicing > 50,000 file tree entries or chat messages
 * so only the visible viewport slice (+ overscan) is ever mounted in the DOM.
 */
export function computeVirtualWindowSlice<T>(
  items: readonly T[],
  scrollTopPx: number,
  viewportHeightPx: number,
  options?: VirtualListOptions,
): VirtualWindowSlice<T> {
  const rowHeightPx = Math.max(1, options?.rowHeightPx ?? 24);
  const overscan = Math.max(0, options?.overscan ?? 5);
  const totalCount = items.length;
  const totalHeightPx = totalCount * rowHeightPx;

  if (totalCount === 0 || viewportHeightPx <= 0) {
    return {
      totalCount,
      totalHeightPx,
      startIndex: 0,
      endIndexExclusive: 0,
      offsetTopPx: 0,
      visibleItems: [],
    };
  }

  const clampedScrollTop = Math.max(0, Math.min(scrollTopPx, Math.max(0, totalHeightPx - 1)));
  const rawFirstIndex = Math.floor(clampedScrollTop / rowHeightPx);
  const visibleRowCapacity = Math.ceil(viewportHeightPx / rowHeightPx);

  const startIndex = Math.max(0, rawFirstIndex - overscan);
  const endIndexExclusive = Math.min(totalCount, rawFirstIndex + visibleRowCapacity + overscan);
  const offsetTopPx = startIndex * rowHeightPx;

  return {
    totalCount,
    totalHeightPx,
    startIndex,
    endIndexExclusive,
    offsetTopPx,
    visibleItems: items.slice(startIndex, endIndexExclusive),
  };
}

/**
 * Generate a synthetic file tree of `count` entries (e.g., 30,000 or 55,000 nodes)
 * annotated with Coloride validation states for virtualization stress testing.
 */
export function generateSyntheticFileTree(count: number): CockpitFileTreeNode[] {
  const states: readonly ColorideValidationState[] = [
    "ValidatedGreen",
    "ReviewYellow",
    "FailedRed",
    "StaleOrange",
    "UnchangedBlue",
  ];
  const nodes: CockpitFileTreeNode[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const pkgIdx = Math.floor(i / 250);
    const modIdx = Math.floor((i % 250) / 25);
    const fileName = `module-${i}.ts`;
    const validationState = states[i % states.length] ?? "UnchangedBlue";
    nodes[i] = {
      path: `packages/pkg-${pkgIdx}/src/mod-${modIdx}/${fileName}`,
      name: fileName,
      depth: 3,
      isDirectory: false,
      validationState,
    };
  }
  return nodes;
}

/**
 * DOM Virtualizer for Zone 3 chat message history.
 */
export class VirtualChatMessageListRenderer {
  private readonly rowHeightPx: number;
  private readonly overscan: number;

  constructor(options?: VirtualListOptions) {
    this.rowHeightPx = options?.rowHeightPx ?? 56;
    this.overscan = options?.overscan ?? 3;
  }

  renderInto(
    container: HTMLElement,
    messages: readonly CockpitChatMessage[],
    scrollTopPx: number,
    viewportHeightPx: number,
  ): VirtualWindowSlice<CockpitChatMessage> {
    const slice = computeVirtualWindowSlice(messages, scrollTopPx, viewportHeightPx, {
      rowHeightPx: this.rowHeightPx,
      overscan: this.overscan,
    });

    container.setAttribute("role", "log");
    container.setAttribute("aria-live", "polite");
    container.dataset.totalMessages = String(slice.totalCount);
    container.innerHTML = "";

    const runway = container.ownerDocument.createElement("div");
    runway.className = "cm-coloride-virtual-messages-runway";
    runway.style.position = "relative";
    runway.style.height = `${slice.totalHeightPx}px`;

    for (let i = 0; i < slice.visibleItems.length; i += 1) {
      const msg = slice.visibleItems[i];
      if (!msg) {
        continue;
      }
      const absoluteIndex = slice.startIndex + i;

      const row = container.ownerDocument.createElement("article");
      row.className = "cm-coloride-virtual-message-row";
      row.dataset.index = String(absoluteIndex);
      row.dataset.messageId = msg.messageId;
      row.dataset.streaming = String(msg.streaming);
      row.style.position = "absolute";
      row.style.top = `${absoluteIndex * this.rowHeightPx}px`;
      row.style.minHeight = `${this.rowHeightPx}px`;
      // Rendered blocks are escaped by the Markdown cache; raw content is never parsed as HTML.
      if (msg.renderedHtmlBlocks.length > 0) row.innerHTML = msg.renderedHtmlBlocks.join("\n");
      else row.textContent = msg.content;

      runway.appendChild(row);
    }

    container.appendChild(runway);
    return slice;
  }
}
