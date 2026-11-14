import { describe, expect, it } from "vitest";
import { placeMenu } from "./menu-placement.js";

const bounds = { top: 0, bottom: 600 };

describe("placeMenu", () => {
  it("opens below when the menu fits there", () => {
    expect(placeMenu({ anchor: { top: 100, bottom: 120 }, height: 150, bounds })).toEqual({
      side: "below",
    });
  });

  it("opens above when it does not fit below but fits above", () => {
    expect(placeMenu({ anchor: { top: 500, bottom: 520 }, height: 150, bounds })).toEqual({
      side: "above",
    });
  });

  it("uses the larger side with a height limit when neither side fits", () => {
    const below = placeMenu({ anchor: { top: 200, bottom: 220 }, height: 900, bounds });
    expect(below.side).toBe("below");
    expect(below.maxHeight).toBe(600 - 220 - 2 - 4);
    const above = placeMenu({ anchor: { top: 400, bottom: 420 }, height: 900, bounds });
    expect(above.side).toBe("above");
    expect(above.maxHeight).toBe(400 - 2 - 4);
  });

  it("keeps a margin from the edge: a menu that touches the bound does not fit", () => {
    // 600 - 120 - 2 - 4 = 474 of room below
    expect(placeMenu({ anchor: { top: 100, bottom: 120 }, height: 474, bounds }).side).toBe(
      "below",
    );
    expect(placeMenu({ anchor: { top: 100, bottom: 120 }, height: 475, bounds }).side).toBe(
      "below",
    );
    expect(placeMenu({ anchor: { top: 100, bottom: 120 }, height: 475, bounds }).maxHeight).toBe(
      474,
    );
  });
});
