/**
 * Layout of the panels (agent chats, terminals…) inside one Zone 3 workspace tab.
 *
 * A layout is a tree: a leaf is one panel, a split lays its children out in a row or a column
 * with fractional sizes. There is no limit on the number of panels or on nesting. Everything here
 * is pure and immutable; the DOM is rendered from the tree elsewhere.
 */

/** `row` places children side by side, `column` stacks them. */
export type SplitDirection = "row" | "column";
export type SplitPosition = "before" | "after";

export interface PanelNode {
  readonly kind: "panel";
  readonly id: string;
}

export interface SplitNode {
  readonly kind: "split";
  readonly direction: SplitDirection;
  readonly children: readonly LayoutNode[];
  /** Fraction of the split taken by each child. Same length as `children`, sums to 1. */
  readonly sizes: readonly number[];
}

export type LayoutNode = PanelNode | SplitNode;

/** Child indices leading from the root to a split node. `[]` is the root. */
export type LayoutPath = readonly number[];

export interface LayoutRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Width/height ratio assumed for the workspace when deciding where a new panel goes. */
export const DEFAULT_LAYOUT_ASPECT = 1.6;
/** A panel never shrinks below this fraction of its split when resized by hand. */
export const MIN_PANEL_FRACTION = 0.1;

export function panel(id: string): PanelNode {
  return { kind: "panel", id };
}

function normalizeSizes(sizes: readonly number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return total > 0 ? sizes.map((size) => size / total) : sizes.map(() => 1 / sizes.length);
}

/** Builds a split, lifting the children of nested splits that go the same way into it. */
function makeSplit(
  direction: SplitDirection,
  children: readonly LayoutNode[],
  sizes: readonly number[] = children.map(() => 1 / children.length),
): SplitNode {
  const flatChildren: LayoutNode[] = [];
  const flatSizes: number[] = [];
  const weights = normalizeSizes(sizes);
  children.forEach((child, index) => {
    const weight = weights[index] ?? 0;
    if (child.kind === "split" && child.direction === direction) {
      child.children.forEach((grandChild, i) => {
        flatChildren.push(grandChild);
        flatSizes.push(weight * (child.sizes[i] ?? 0));
      });
    } else {
      flatChildren.push(child);
      flatSizes.push(weight);
    }
  });
  return { kind: "split", direction, children: flatChildren, sizes: normalizeSizes(flatSizes) };
}

/** Panel ids in reading order (left to right, top to bottom). */
export function panelIds(node: LayoutNode | null): string[] {
  if (!node) return [];
  return node.kind === "panel" ? [node.id] : node.children.flatMap((child) => panelIds(child));
}

export function hasPanel(node: LayoutNode | null, id: string): boolean {
  return panelIds(node).includes(id);
}

/** Where each panel sits in a workspace of `aspect` x 1, as fractions of the whole area. */
export function computeRects(
  node: LayoutNode | null,
  aspect = DEFAULT_LAYOUT_ASPECT,
): Map<string, LayoutRect> {
  const rects = new Map<string, LayoutRect>();
  const visit = (current: LayoutNode, rect: LayoutRect) => {
    if (current.kind === "panel") {
      rects.set(current.id, rect);
      return;
    }
    let offset = 0;
    current.children.forEach((child, index) => {
      const size = current.sizes[index] ?? 0;
      if (current.direction === "row") {
        visit(child, { ...rect, x: rect.x + offset * rect.width, width: size * rect.width });
      } else {
        visit(child, { ...rect, y: rect.y + offset * rect.height, height: size * rect.height });
      }
      offset += size;
    });
  };
  if (node) visit(node, { x: 0, y: 0, width: aspect, height: 1 });
  return rects;
}

function splitIn(
  node: LayoutNode,
  targetId: string,
  newId: string,
  direction: SplitDirection,
  position: SplitPosition,
): LayoutNode {
  if (node.kind === "panel") {
    if (node.id !== targetId) return node;
    const pair = position === "before" ? [panel(newId), node] : [node, panel(newId)];
    return makeSplit(direction, pair);
  }
  const index = node.children.findIndex((child) => child.kind === "panel" && child.id === targetId);
  if (index >= 0 && node.direction === direction) {
    // Same direction as the parent: the new panel becomes one more sibling and takes half of
    // the target's share.
    const at = position === "before" ? index : index + 1;
    const half = (node.sizes[index] ?? 0) / 2;
    const children = [...node.children];
    const sizes = [...node.sizes];
    children.splice(at, 0, panel(newId));
    sizes[index] = half;
    sizes.splice(at, 0, half);
    return { ...node, children, sizes };
  }
  return {
    ...node,
    children: node.children.map((child) => splitIn(child, targetId, newId, direction, position)),
  };
}

/** Splits `targetId` in two, putting the new panel before or after it. Unknown target: no change. */
export function splitPanel(
  root: LayoutNode | null,
  targetId: string,
  newId: string,
  direction: SplitDirection,
  position: SplitPosition = "after",
): LayoutNode | null {
  if (!root || !hasPanel(root, targetId) || hasPanel(root, newId)) return root;
  return splitIn(root, targetId, newId, direction, position);
}

export interface AddPanelOptions {
  /** Panel to split. Defaults to the one with the largest area. */
  readonly target?: string;
  readonly direction?: SplitDirection;
  readonly position?: SplitPosition;
  readonly aspect?: number;
}

/**
 * Adds a panel. With no hint it splits the largest panel along its longer side, so panels
 * spread out on their own: 1, 2, 3, 4 panels become a row, a row plus a column, a 2x2…
 */
export function addPanel(
  root: LayoutNode | null,
  id: string,
  options: AddPanelOptions = {},
): LayoutNode {
  if (!root) return panel(id);
  if (hasPanel(root, id)) return root;
  const rects = computeRects(root, options.aspect);
  let target = options.target && rects.has(options.target) ? options.target : undefined;
  if (!target) {
    let largest = -1;
    for (const [panelId, rect] of rects) {
      const area = rect.width * rect.height;
      // Strictly larger (with a little tolerance), so ties keep the earliest panel.
      if (area > largest + 1e-9) {
        largest = area;
        target = panelId;
      }
    }
  }
  const rect = target ? rects.get(target) : undefined;
  if (!target || !rect) return root;
  const direction = options.direction ?? (rect.width >= rect.height ? "row" : "column");
  return splitIn(root, target, id, direction, options.position ?? "after");
}

function removeIn(node: LayoutNode, id: string): LayoutNode | null {
  if (node.kind === "panel") return node.id === id ? null : node;
  const kept: LayoutNode[] = [];
  const keptSizes: number[] = [];
  node.children.forEach((child, index) => {
    const remaining = removeIn(child, id);
    if (remaining) {
      kept.push(remaining);
      keptSizes.push(node.sizes[index] ?? 0);
    }
  });
  if (kept.length === 0) return null;
  const [only] = kept;
  if (kept.length === 1 && only) return only;
  // The freed share goes to the remaining siblings in proportion to their size.
  return makeSplit(node.direction, kept, keptSizes);
}

/** Removes a panel; its neighbours grow into the space. Returns null when nothing is left. */
export function removePanel(root: LayoutNode | null, id: string): LayoutNode | null {
  return root ? removeIn(root, id) : null;
}

/** Moves `id` next to `targetId`. Either id missing, or both equal: no change. */
export function movePanel(
  root: LayoutNode | null,
  id: string,
  targetId: string,
  direction: SplitDirection,
  position: SplitPosition = "after",
): LayoutNode | null {
  if (!root || id === targetId || !hasPanel(root, id) || !hasPanel(root, targetId)) return root;
  const without = removePanel(root, id);
  return splitPanel(without, targetId, id, direction, position);
}

function nodeAt(root: LayoutNode, path: LayoutPath): SplitNode | null {
  let current: LayoutNode = root;
  for (const index of path) {
    if (current.kind !== "split") return null;
    const next: LayoutNode | undefined = current.children[index];
    if (!next) return null;
    current = next;
  }
  return current.kind === "split" ? current : null;
}

function replaceAt(root: LayoutNode, path: LayoutPath, replacement: LayoutNode): LayoutNode {
  const [head, ...rest] = path;
  if (head === undefined || root.kind !== "split") return replacement;
  return {
    ...root,
    children: root.children.map((child, index) =>
      index === head ? replaceAt(child, rest, replacement) : child,
    ),
  };
}

/**
 * Drags the boundary between child `boundary` and `boundary + 1` of the split at `path` by
 * `delta` (a fraction of that split). Neither side goes below `minFraction`.
 */
export function resizeBoundary(
  root: LayoutNode | null,
  path: LayoutPath,
  boundary: number,
  delta: number,
  minFraction = MIN_PANEL_FRACTION,
): LayoutNode | null {
  if (!root) return root;
  const split = nodeAt(root, path);
  const before = split?.sizes[boundary];
  const after = split?.sizes[boundary + 1];
  if (!split || before === undefined || after === undefined) return root;
  const applied = Math.min(Math.max(delta, minFraction - before), after - minFraction);
  if (applied === 0 || Number.isNaN(applied)) return root;
  const sizes = [...split.sizes];
  sizes[boundary] = before + applied;
  sizes[boundary + 1] = after - applied;
  return replaceAt(root, path, { ...split, sizes });
}

/** A layout holding exactly `ids`, spread automatically. */
export function layoutFromPanels(ids: readonly string[]): LayoutNode | null {
  return ids.reduce<LayoutNode | null>((layout, id) => addPanel(layout, id), null);
}

/**
 * Brings a stored layout in line with the panels that exist: panels that are gone are removed
 * (their neighbours grow) and new ones are added where there is room.
 */
export function reconcileLayout(
  root: LayoutNode | null | undefined,
  ids: readonly string[],
): LayoutNode | null {
  const wanted = new Set(ids);
  let layout = root ?? null;
  for (const id of panelIds(layout)) {
    if (!wanted.has(id)) layout = removePanel(layout, id);
  }
  for (const id of ids) layout = addPanel(layout, id);
  return layout;
}

/**
 * Reads a layout from untrusted data (a saved session). Anything malformed is dropped: bad
 * nodes disappear, duplicate panel ids keep their first occurrence, bad sizes become equal.
 */
export function parseLayout(raw: unknown): LayoutNode | null {
  const seen = new Set<string>();
  const read = (value: unknown): LayoutNode | null => {
    if (!value || typeof value !== "object") return null;
    const node = value as Record<string, unknown>;
    if (node.kind === "panel") {
      if (typeof node.id !== "string" || node.id === "" || seen.has(node.id)) return null;
      seen.add(node.id);
      return panel(node.id);
    }
    if (node.kind !== "split" || (node.direction !== "row" && node.direction !== "column")) {
      return null;
    }
    if (!Array.isArray(node.children)) return null;
    const rawSizes = Array.isArray(node.sizes) ? node.sizes : [];
    const children: LayoutNode[] = [];
    const sizes: number[] = [];
    node.children.forEach((child, index) => {
      const parsed = read(child);
      if (!parsed) return;
      const size = rawSizes[index];
      children.push(parsed);
      sizes.push(typeof size === "number" && Number.isFinite(size) && size > 0 ? size : 0);
    });
    const [only] = children;
    if (children.length === 0) return null;
    if (children.length === 1 && only) return only;
    // Missing or invalid sizes (any zero) fall back to equal shares.
    return makeSplit(node.direction, children, sizes.includes(0) ? undefined : sizes);
  };
  return read(raw);
}
