import { describe, expect, it } from "vitest";
import { createInitialCockpitShellState } from "./index.js";

describe("@coloride/web-ui", () => {
  it("initializes the 4-zone Cockpit shell in Develop mode with code-diff inspector", () => {
    const state = createInitialCockpitShellState();
    expect(state.activePersona).toBe("Develop");
    expect(state.gridMode).toBe(1);
    expect(state.activeInspectorTab).toBe("code-diff");
  });
});
