import { describe, expect, it } from "vitest";
import {
  type LayoutNode,
  addPanel,
  canAddPanel,
  computeRects,
  fitsArea,
  hasPanel,
  layoutFromPanels,
  movePanel,
  panel,
  panelIds,
  parseLayout,
  placePanel,
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

  it("fits panels without scrolling until the minimum size is reached, then refuses more", () => {
    const area = { widthPx: 1000, heightPx: 700 };
    expect(fitsArea(null, area)).toBe(true);
    expect(fitsArea(panel("a"), { widthPx: 0, heightPx: 0 })).toBe(false);

    // Add panels one by one wherever there is room, exactly as the UI will.
    let layout: LayoutNode | null = null;
    let count = 0;
    while (canAddPanel(layout, area)) {
      layout = addPanel(layout, `p${count}`, { aspect: area.widthPx / area.heightPx });
      count += 1;
      expect(fitsArea(layout, area)).toBe(true);
      expect(count).toBeLessThan(200);
    }
    // 1000x700 with 220x140 panels: a real limit, well above the old 8 and not unbounded.
    expect(count).toBeGreaterThan(8);
    expect(count).toBeLessThan(30);
    expect(canAddPanel(layout, area)).toBe(false);

    // A smaller window fits fewer; removing a panel makes room again.
    expect(canAddPanel(layout, { widthPx: 500, heightPx: 300 })).toBe(false);
    const fewer = removePanel(layout, "p0");
    expect(canAddPanel(fewer, area)).toBe(true);
  });

  // Two columns: the largest panel (A, 400x270) cannot be split either way, and two panels are
  // already below the minimum height (S, K) after a window resize. B (500x200) can still be split.
  const crowded = (): { layout: LayoutNode; area: { widthPx: number; heightPx: number } } => ({
    area: { widthPx: 900, heightPx: 300 },
    layout: {
      kind: "split",
      direction: "row",
      sizes: [400 / 900, 500 / 900],
      children: [
        {
          kind: "split",
          direction: "column",
          sizes: [0.9, 0.1],
          children: [panel("A"), panel("S")],
        },
        {
          kind: "split",
          direction: "column",
          sizes: [2 / 3, 1 / 3],
          children: [panel("B"), panel("K")],
        },
      ],
    },
  });

  it("finds room in another panel when the largest one cannot be split", () => {
    const { layout, area } = crowded();
    expect(canAddPanel(layout, area)).toBe(true);
    const placed = placePanel(layout, "new", area);
    expect(placed).not.toBeNull();
    // It went into B (the only splittable one), side by side, and nothing else moved.
    const rects = computeRects(placed, area.widthPx / area.heightPx);
    const px = (id: string) => {
      const r = rects.get(id);
      return { w: (r?.width ?? 0) * area.heightPx, h: (r?.height ?? 0) * area.heightPx };
    };
    expect(px("B").w).toBeCloseTo(250);
    expect(px("new").w).toBeCloseTo(250);
    expect(px("A")).toEqual({ w: expect.closeTo(400), h: expect.closeTo(270) });
  });

  it("only checks the panels a split changes, not ones that were already too small", () => {
    const { layout, area } = crowded();
    // Per-panel buttons: B can be split right, A cannot, whatever the tiny panels around do.
    expect(canAddPanel(layout, area, { target: "B", direction: "row" })).toBe(true);
    expect(canAddPanel(layout, area, { target: "A", direction: "row" })).toBe(false);
    expect(canAddPanel(layout, area, { target: "A", direction: "column" })).toBe(false);
    // An explicit direction is respected: B cannot be split down (200 / 2 < 140).
    expect(canAddPanel(layout, area, { target: "B", direction: "column" })).toBe(false);
  });

  it("agrees with an exhaustive search over every panel, direction and side, for any layout", () => {
    // Deterministic pseudo-random walk of adds, splits and closes in several window sizes.
    let seed = 12345;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed % n;
    };
    const exists = (layout: LayoutNode | null, area: { widthPx: number; heightPx: number }) => {
      if (!layout) return true;
      for (const target of panelIds(layout)) {
        for (const direction of ["row", "column"] as const) {
          for (const position of ["before", "after"] as const) {
            const next = splitPanel(layout, target, "probe", direction, position);
            const rects = computeRects(next, area.widthPx / area.heightPx);
            const ok = [target, "probe"].every((id) => {
              const r = rects.get(id);
              return (
                r !== undefined &&
                r.width * area.heightPx >= 220 - 1e-6 &&
                r.height * area.heightPx >= 140 - 1e-6
              );
            });
            if (ok) return true;
          }
        }
      }
      return false;
    };
    let counter = 0;
    for (const area of [
      { widthPx: 1000, heightPx: 700 },
      { widthPx: 1400, heightPx: 500 },
      { widthPx: 520, heightPx: 900 },
      { widthPx: 700, heightPx: 700 },
    ]) {
      let layout: LayoutNode | null = null;
      for (let step = 0; step < 120; step += 1) {
        const ids = panelIds(layout);
        const op = random(4);
        if (op === 0 && ids.length > 0) {
          layout = removePanel(layout, ids[random(ids.length)] as string);
        } else if (op === 1 && ids.length > 0) {
          const target = ids[random(ids.length)] as string;
          const direction = random(2) === 0 ? "row" : "column";
          const next = placePanel(layout, `p${counter}`, area, { target, direction });
          if (next) {
            layout = next;
            counter += 1;
          }
        } else {
          const next = placePanel(layout, `p${counter}`, area);
          if (next) {
            layout = next;
            counter += 1;
          }
        }
        // "Is there room?" must match reality: never "no room" while some split fits, and never
        // "room" when none does.
        expect(canAddPanel(layout, area)).toBe(exists(layout, area));
        // And after the window shrinks, when some panels are already below the minimum.
        for (const factor of [0.85, 0.7, 0.55]) {
          const shrunk = { widthPx: area.widthPx * factor, heightPx: area.heightPx * factor };
          expect(canAddPanel(layout, shrunk)).toBe(exists(layout, shrunk));
        }
      }
    }
  });
});
