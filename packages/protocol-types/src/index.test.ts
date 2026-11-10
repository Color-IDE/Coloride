import { describe, expect, it } from "vitest";
import { COLORIDE_STATE_META } from "./index.js";

describe("@coloride/protocol-types", () => {
  it("defines all 5 accessible Coloride validation states with distinct icons", () => {
    const icons = new Set(Object.values(COLORIDE_STATE_META).map((m) => m.icon));
    expect(icons.size).toBe(5);
    expect(COLORIDE_STATE_META.ValidatedGreen.icon).toBe("✓");
    expect(COLORIDE_STATE_META.StaleOrange.icon).toBe("⟳");
  });
});
