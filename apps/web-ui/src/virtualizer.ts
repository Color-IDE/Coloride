import type { ColorideValidationState } from "@coloride/protocol-types";
import {
  COLORIDE_DESIGN_TOKENS,
  type CockpitChatMessage,
  type CockpitFileTreeNode,
} from "./stores.js";

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
 * DOM Virtualizer for Zone 2 file tree (> 50,000 entries) with accessible Coloride state badges.
 */
export class VirtualFileTreeRenderer {
  private readonly rowHeightPx: number;
  private readonly overscan: number;

  constructor(options?: VirtualListOptions) {
    this.rowHeightPx = options?.rowHeightPx ?? 24;
    this.overscan = options?.overscan ?? 4;
  }

  renderInto(
    container: HTMLElement,
    nodes: readonly CockpitFileTreeNode[],
    scrollTopPx: number,
    viewportHeightPx: number,
    focusedIndex = 0,
  ): VirtualWindowSlice<CockpitFileTreeNode> {
    const slice = computeVirtualWindowSlice(nodes, scrollTopPx, viewportHeightPx, {
      rowHeightPx: this.rowHeightPx,
      overscan: this.overscan,
    });

    container.setAttribute("role", "tree");
    container.setAttribute("aria-label", `Workspace File Explorer (${slice.totalCount} files)`);
    container.dataset.totalCount = String(slice.totalCount);
    container.dataset.totalHeightPx = String(slice.totalHeightPx);
    container.innerHTML = "";

    const runway = container.ownerDocument.createElement("div");
    runway.className = "cm-coloride-virtual-runway";
    runway.style.position = "relative";
    runway.style.height = `${slice.totalHeightPx}px`;

    for (let i = 0; i < slice.visibleItems.length; i += 1) {
      const node = slice.visibleItems[i];
      if (!node) {
        continue;
      }
      const absoluteIndex = slice.startIndex + i;
      const token = COLORIDE_DESIGN_TOKENS[node.validationState];

      const row = container.ownerDocument.createElement("div");
      row.className = "cm-coloride-virtual-tree-row";
      row.setAttribute("role", "treeitem");
      row.setAttribute("tabindex", absoluteIndex === focusedIndex ? "0" : "-1");
      row.setAttribute("aria-selected", absoluteIndex === focusedIndex ? "true" : "false");
      row.setAttribute("aria-label", `${node.path} — ${token.labelFr}`);
      row.dataset.index = String(absoluteIndex);
      row.dataset.path = node.path;
      row.dataset.validationState = node.validationState;
      row.style.position = "absolute";
      row.style.top = `${absoluteIndex * this.rowHeightPx}px`;
      row.style.height = `${this.rowHeightPx}px`;
      row.style.paddingLeft = `${node.depth * 12}px`;

      const badge = container.ownerDocument.createElement("span");
      badge.className = "cm-coloride-tree-state-badge";
      badge.textContent = token.icon;
      badge.setAttribute("aria-hidden", "true");
      badge.style.color = token.darkText;

      const label = container.ownerDocument.createElement("span");
      label.className = "cm-coloride-tree-label";
      label.textContent = ` ${node.name}`;

      row.appendChild(badge);
      row.appendChild(label);
      runway.appendChild(row);
    }

    container.appendChild(runway);
    return slice;
  }
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
      row.innerHTML =
        msg.renderedHtmlBlocks.length > 0 ? msg.renderedHtmlBlocks.join("\n") : msg.content;

      runway.appendChild(row);
    }

    container.appendChild(runway);
    return slice;
  }
}
