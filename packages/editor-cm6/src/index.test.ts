import { describe, expect, it } from "vitest";
import { describeDecorationAccessibleLabel, invalidateRangeOnLocalEdit } from "./index.js";

describe("@coloride/editor-cm6", () => {
  it("immediately invalidates a ValidatedGreen range to StaleOrange on local edit", () => {
    const initial = {
      fromLine: 10,
      toLine: 20,
      state: "ValidatedGreen" as const,
      snapshotHash: "blake3-abc123",
    };
    const updated = invalidateRangeOnLocalEdit(initial, 15);
    expect(updated.state).toBe("StaleOrange");
    expect(describeDecorationAccessibleLabel(updated)).toContain("⟳ Validation périmée");
  });
});
