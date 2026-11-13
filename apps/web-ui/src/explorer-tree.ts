import { COLORIDE_DESIGN_TOKENS, type CockpitFileTreeNode } from "./stores/index.js";
import {
  TREE_CHEVRON_SVG,
  TREE_FOLDER_CLOSED_SVG,
  TREE_FOLDER_OPEN_SVG,
  fileTreeIconColor,
  fileTreeIconSvg,
} from "./theme/file-tree-icons.js";
import { computeVirtualWindowSlice } from "./virtualizer.js";

export const EXPLORER_ROW_HEIGHT_PX = 22;
/** Chevron (14px) + gap (4px): children start exactly under their parent folder icon. */
const INDENT_PX = 18;

export interface ExplorerTreeOptions {
  readonly activePath: string;
  readonly collapsed: ReadonlySet<string>;
  readonly onOpenFile: (node: CockpitFileTreeNode) => void;
  readonly onToggleDirectory: (node: CockpitFileTreeNode) => void;
}

/** Nodes left once the descendants of collapsed folders are hidden. */
export function visibleExplorerNodes(
  nodes: readonly CockpitFileTreeNode[],
  collapsed: ReadonlySet<string>,
): readonly CockpitFileTreeNode[] {
  if (collapsed.size === 0) return nodes;
  const result: CockpitFileTreeNode[] = [];
  let hiddenBelowDepth = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    if (node.depth > hiddenBelowDepth) continue;
    hiddenBelowDepth = Number.POSITIVE_INFINITY;
    result.push(node);
    if (node.isDirectory && collapsed.has(node.path)) hiddenBelowDepth = node.depth;
  }
  return result;
}

/**
 * Indices of the folders to pin above the list, outermost first: the parents of the row that has
 * just reached the top. Deterministic in the scroll position, so it never flickers.
 */
export function stickyAncestorIndices(
  nodes: readonly CockpitFileTreeNode[],
  scrollTopPx: number,
  maxRows = 5,
): readonly number[] {
  if (nodes.length === 0 || scrollTopPx <= 0) return [];
  const first = Math.min(nodes.length - 1, Math.floor(scrollTopPx / EXPLORER_ROW_HEIGHT_PX));
  const chain: number[] = [];
  let need = (nodes[first] as CockpitFileTreeNode).depth;
  for (let i = first - 1; i >= 0 && need > 0; i -= 1) {
    const node = nodes[i] as CockpitFileTreeNode;
    if (node.isDirectory && node.depth < need) {
      chain.push(i);
      need = node.depth;
    }
  }
  return chain.reverse().slice(0, maxRows);
}

/**
 * Virtualized project tree in the style of the Rectury explorer: 22px rows, indentation guides,
 * rotating chevrons, per-language icons. Only the visible window is ever mounted.
 */
export class ExplorerTreeRenderer {
  renderInto(
    container: HTMLElement,
    nodes: readonly CockpitFileTreeNode[],
    scrollTopPx: number,
    viewportHeightPx: number,
    options: ExplorerTreeOptions,
  ): void {
    const doc = container.ownerDocument;
    const slice = computeVirtualWindowSlice(nodes, scrollTopPx, viewportHeightPx, {
      rowHeightPx: EXPLORER_ROW_HEIGHT_PX,
      overscan: 6,
    });
    container.setAttribute("role", "tree");
    container.setAttribute("aria-label", `Project files (${slice.totalCount})`);
    container.dataset.totalCount = String(slice.totalCount);

    const runway = doc.createElement("div");
    runway.className = "explorer-runway";
    runway.style.height = `${slice.totalHeightPx}px`;

    slice.visibleItems.forEach((node, offset) => {
      runway.append(
        this.createRow(doc, node, slice.startIndex + offset, options, false, () => {
          if (node.isDirectory) options.onToggleDirectory(node);
          else options.onOpenFile(node);
        }),
      );
    });

    container.replaceChildren(runway);
  }

  private createRow(
    doc: Document,
    node: CockpitFileTreeNode,
    index: number,
    options: ExplorerTreeOptions,
    sticky: boolean,
    onClick: () => void,
  ): HTMLElement {
    const expanded = node.isDirectory && !options.collapsed.has(node.path);
    const row = doc.createElement("div");
    row.className = "explorer-row cm-coloride-virtual-tree-row";
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", String(node.depth + 1));
    row.setAttribute(
      "aria-selected",
      String(!node.isDirectory && node.path === options.activePath),
    );
    if (node.isDirectory) row.setAttribute("aria-expanded", String(expanded));
    row.tabIndex = -1;
    row.dataset.index = String(index);
    row.dataset.path = node.path;
    row.dataset.validationState = node.validationState;
    if (!sticky) row.style.top = `${index * EXPLORER_ROW_HEIGHT_PX}px`;
    row.style.height = `${EXPLORER_ROW_HEIGHT_PX}px`;
    row.style.paddingLeft = `${8 + node.depth * INDENT_PX}px`;

    for (let level = 0; level < node.depth; level += 1) {
      const guide = doc.createElement("span");
      guide.className = "explorer-guide";
      guide.setAttribute("aria-hidden", "true");
      guide.style.left = `${14 + level * INDENT_PX}px`;
      row.append(guide);
    }

    // Files have no chevron slot, so their icon sits where a sibling folder's chevron is.
    const chevron = doc.createElement("span");
    chevron.className = "explorer-chevron";
    chevron.setAttribute("aria-hidden", "true");
    if (node.isDirectory) {
      chevron.innerHTML = TREE_CHEVRON_SVG;
      if (!expanded) chevron.classList.add("explorer-chevron--collapsed");
    }

    const icon = doc.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    if (node.isDirectory) {
      icon.className = "explorer-icon filetree-folder-color";
      icon.innerHTML = expanded ? TREE_FOLDER_OPEN_SVG : TREE_FOLDER_CLOSED_SVG;
    } else {
      icon.className = `explorer-icon ${fileTreeIconColor(node.name)}`;
      icon.innerHTML = fileTreeIconSvg(node.name);
    }

    const name = doc.createElement("span");
    name.className = "explorer-name cm-coloride-tree-label";
    name.textContent = node.name;

    if (node.isDirectory) row.append(chevron);
    row.append(icon, name);

    // Coloride state stays visible, but only when it says something (not "unchanged").
    if (node.validationState !== "UnchangedBlue") {
      const token = COLORIDE_DESIGN_TOKENS[node.validationState];
      const badge = doc.createElement("span");
      badge.className = "explorer-state cm-coloride-tree-state-badge";
      badge.textContent = token.icon;
      badge.style.color = token.darkText;
      badge.setAttribute("role", "img");
      badge.setAttribute("aria-label", token.labelEn);
      row.append(badge);
      row.setAttribute("aria-label", `${node.path} — ${token.labelEn}`);
    }

    row.addEventListener("click", onClick);

    return row;
  }

  /**
   * Pins the parent folders of the first visible row to the top of the viewport (sticky scroll).
   * Clicking a pinned folder reveals it in the list.
   */
  renderSticky(
    container: HTMLElement,
    nodes: readonly CockpitFileTreeNode[],
    scrollTopPx: number,
    options: ExplorerTreeOptions,
    onReveal: (index: number, stickyLevel: number) => void,
  ): void {
    const doc = container.ownerDocument;
    const indices = stickyAncestorIndices(nodes, scrollTopPx);
    container.hidden = indices.length === 0;
    container.replaceChildren(
      ...indices.map((index, level) => {
        const node = nodes[index] as CockpitFileTreeNode;
        const row = this.createRow(doc, node, index, options, true, () => onReveal(index, level));
        row.classList.add("explorer-row--sticky");
        return row;
      }),
    );
  }
}
