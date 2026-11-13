import { describe, expect, it } from "vitest";
import {
  type LayoutNode,
  addPanel,
  computeRects,
  hasPanel,
  layoutFromPanels,
  movePanel,
  panel,
  panelIds,
  parseLayout,
  reconcileLayout,
  removePanel,
  resizeBoundary,
  splitPanel,
} from "./layout-tree.js";

function sizesSumToOne(node: LayoutNode | null): boolean {
  if (!node || node.kind === "panel") return true;
  const total = node.sizes.reduce((sum, size) => sum + size, 0);
  return (
    Math.abs(total - 1) < 1e-9 &&
    node.sizes.length === node.children.length &&
    node.children.every(sizesSumToOne)
  );
}

function totalArea(node: LayoutNode | null): number {
  let area = 0;
  for (const rect of computeRects(node).values()) area += rect.width * rect.height;
  return area;
}

describe("layout-tree", () => {
  it("spreads panels automatically: 1, 2, 3 and 4 panels become row, row+column and 2x2", () => {
    const one = layoutFromPanels(["a"]);
    expect(one).toEqual(panel("a"));

    const two = layoutFromPanels(["a", "b"]);
    expect(two).toMatchObject({ kind: "split", direction: "row" });

    // Ties go to the earliest panel: a is split, giving a/c on the left and b on the right.
    const three = computeRects(layoutFromPanels(["a", "b", "c"]));
    expect(three.get("a")).toMatchObject({ x: 0, y: 0, width: 0.8, height: 0.5 });
    expect(three.get("c")).toMatchObject({ x: 0, width: 0.8, height: 0.5 });
    expect(three.get("c")?.y).toBeCloseTo(0.5);
    expect(three.get("b")).toMatchObject({ y: 0, width: 0.8, height: 1 });

    // Four panels form a 2x2 grid in row order: a b on top, c d below.
    const four = computeRects(layoutFromPanels(["a", "b", "c", "d"]));
    for (const rect of four.values()) {
      expect(rect.width).toBeCloseTo(0.8);
      expect(rect.height).toBeCloseTo(0.5);
    }
    expect(four.get("a")?.y).toBe(0);
    expect(four.get("b")?.y).toBe(0);
    expect(four.get("c")?.y).toBeCloseTo(0.5);
    expect(four.get("d")?.y).toBeCloseTo(0.5);
    expect(four.get("b")?.x).toBeCloseTo(0.8);
  });

  it("has no panel limit, tiles the whole area and keeps every size valid", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `p${i}`);
    const layout = layoutFromPanels(ids);
    expect(panelIds(layout).sort()).toEqual([...ids].sort());
    expect(totalArea(layout)).toBeCloseTo(1.6);
    expect(sizesSumToOne(layout)).toBe(true);
    for (const rect of computeRects(layout).values()) {
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
    }
  });

  it("splits a chosen panel in the chosen direction and ignores unknown or duplicate ids", () => {
    const base = layoutFromPanels(["a", "b"]);
    const split = splitPanel(base, "a", "c", "column", "before");
    expect(split).not.toBeNull();
    expect(panelIds(split)).toEqual(["c", "a", "b"]);
    const rects = computeRects(split);
    expect(rects.get("c")?.y).toBe(0);
    expect(rects.get("a")?.y).toBeCloseTo(0.5);

    expect(splitPanel(base, "zzz", "c", "row")).toBe(base);
    expect(splitPanel(base, "a", "b", "row")).toBe(base);
    expect(addPanel(base, "a")).toBe(base);
  });

  it("puts a same-direction split next to its siblings instead of nesting", () => {
    const base = layoutFromPanels(["a", "b"]);
    const split = splitPanel(base, "b", "c", "row");
    expect(split).toMatchObject({ kind: "split", direction: "row" });
    expect((split as unknown as { children: unknown[] }).children).toHaveLength(3);
    const widths = [...computeRects(split).values()].map((r) => r.width);
    expect(widths[0]).toBeCloseTo(0.8);
    expect(widths[1]).toBeCloseTo(0.4);
    expect(widths[2]).toBeCloseTo(0.4);
  });

  it("removes a panel: neighbours take its space and single-child splits collapse", () => {
    const three = layoutFromPanels(["a", "b", "c"]);
    // b is the whole right column: removing it leaves a/c stacked across the full width.
    const withoutB = removePanel(three, "b");
    expect(panelIds(withoutB)).toEqual(["a", "c"]);
    expect(withoutB).toMatchObject({ kind: "split", direction: "column" });
    expect(computeRects(withoutB).get("a")?.width).toBeCloseTo(1.6);
    expect(totalArea(withoutB)).toBeCloseTo(1.6);
    expect(sizesSumToOne(withoutB)).toBe(true);

    // c is half of the left column: a takes the whole column back.
    const withoutC = removePanel(three, "c");
    expect(withoutC).toMatchObject({ kind: "split", direction: "row" });
    expect(computeRects(withoutC).get("a")).toMatchObject({ width: 0.8, height: 1 });

    expect(removePanel(layoutFromPanels(["a", "b"]), "a")).toEqual(panel("b"));
    expect(removePanel(panel("a"), "a")).toBeNull();
    expect(removePanel(null, "a")).toBeNull();
  });

  it("moves a panel next to another without losing or duplicating panels", () => {
    const layout = layoutFromPanels(["a", "b", "c", "d"]);
    const moved = movePanel(layout, "d", "a", "row", "before");
    expect(panelIds(moved).sort()).toEqual(["a", "b", "c", "d"]);
    expect(computeRects(moved).get("d")?.x).toBe(0);
    expect(sizesSumToOne(moved)).toBe(true);
    expect(movePanel(layout, "a", "a", "row")).toBe(layout);
    expect(movePanel(layout, "zzz", "a", "row")).toBe(layout);
  });

  it("resizes a boundary and never lets a panel shrink under the minimum", () => {
    const layout = layoutFromPanels(["a", "b"]);
    const wider = resizeBoundary(layout, [], 0, 0.2);
    expect(computeRects(wider).get("a")?.width).toBeCloseTo(1.6 * 0.7);
    expect(sizesSumToOne(wider)).toBe(true);

    const extreme = resizeBoundary(layout, [], 0, 5);
    const rects = computeRects(extreme);
    expect(rects.get("b")?.width).toBeCloseTo(1.6 * 0.1);
    expect(rects.get("a")?.width).toBeCloseTo(1.6 * 0.9);

    expect(resizeBoundary(layout, [3], 0, 0.1)).toBe(layout);
    expect(resizeBoundary(layout, [], 7, 0.1)).toBe(layout);
  });

  it("reconciles a stored layout with the panels that exist, keeping the arrangement", () => {
    const stored = layoutFromPanels(["a", "b", "c"]);
    const next = reconcileLayout(stored, ["a", "c", "d"]);
    expect(panelIds(next).sort()).toEqual(["a", "c", "d"]);
    expect(hasPanel(next, "b")).toBe(false);
    expect(computeRects(next).get("a")?.x).toBe(0);
    expect(totalArea(next)).toBeCloseTo(1.6);

    expect(reconcileLayout(undefined, ["x", "y"])).toEqual(layoutFromPanels(["x", "y"]));
    expect(reconcileLayout(stored, [])).toBeNull();
  });

  it("round-trips through JSON and survives corrupted saved data", () => {
    const layout = layoutFromPanels(["a", "b", "c", "d", "e"]);
    expect(parseLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);

    expect(parseLayout(null)).toBeNull();
    expect(parseLayout("nope")).toBeNull();
    expect(parseLayout({ kind: "split", direction: "diagonal", children: [] })).toBeNull();
    expect(parseLayout({ kind: "panel", id: "" })).toBeNull();

    const messy = parseLayout({
      kind: "split",
      direction: "row",
      sizes: [0.5, -1, 0.5],
      children: [
        { kind: "panel", id: "a" },
        { kind: "panel", id: "a" }, // duplicate: dropped
        { kind: "bogus" }, // dropped
        { kind: "panel", id: "b" },
      ],
    });
    expect(panelIds(messy)).toEqual(["a", "b"]);
    expect(sizesSumToOne(messy)).toBe(true);

    expect(
      parseLayout({
        kind: "split",
        direction: "column",
        children: [{ kind: "panel", id: "only" }],
      }),
    ).toEqual(panel("only"));
  });
});
