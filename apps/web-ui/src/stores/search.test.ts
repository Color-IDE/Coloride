import { describe, expect, it } from "vitest";
import type { DocumentBuffers } from "./documents.js";
import { createCockpitStoreBundle } from "./index.js";
import { searchDocumentBuffers } from "./search.js";

const buffers = (): DocumentBuffers =>
  new Map([
    [
      "src/a.ts",
      {
        content: "const token = 1;\nexport const login = 2;",
        unsaved: false,
        validationState: "UnchangedBlue",
      },
    ],
    [
      "src/b.ts",
      { content: "export const login = 3;", unsaved: true, validationState: "UnchangedBlue" },
    ],
    [".env", { content: "login=hunter2", unsaved: false, validationState: "UnchangedBlue" }],
    [
      "src/k.ts",
      {
        content: "const k = 'sk-abcdefghijklmnop'; // login",
        unsaved: false,
        validationState: "UnchangedBlue",
      },
    ],
  ]);

describe("searchDocumentBuffers", () => {
  it("ranks unsaved buffers first, skips secret-bearing files and redacts tokens", () => {
    const results = searchDocumentBuffers(buffers(), "login");
    expect(results.map((r) => `${r.filePath}:${r.line}`)).toEqual([
      "src/b.ts:1",
      "src/a.ts:2",
      "src/k.ts:1",
    ]);
    expect(results[0]?.freshness).toBe("LiveUnsavedBuffer");
    expect(results[1]?.freshness).toBe("IndexedCommit");
    expect(results.some((r) => r.filePath === ".env")).toBe(false);
    const redacted = results.find((r) => r.filePath === "src/k.ts");
    expect(redacted?.secretsRedacted).toBe(1);
    expect(redacted?.snippet).not.toContain("sk-abcdefghijklmnop");
  });

  it("requires every term, also matching the path, and returns nothing for an empty query", () => {
    expect(searchDocumentBuffers(buffers(), "login src/a").map((r) => r.filePath)).toEqual([
      "src/a.ts",
    ]);
    expect(searchDocumentBuffers(buffers(), "   ")).toEqual([]);
    expect(searchDocumentBuffers(buffers(), "nothinghere")).toEqual([]);
  });
});

describe("store bundle composition", () => {
  it("keeps actions usable detached from the bundle (no reliance on this)", () => {
    const { setActivitySection, handleActivityBarShortcut, runGlobalSearch, zone1, zone2 } =
      createCockpitStoreBundle();
    handleActivityBarShortcut("3", true);
    expect(zone1.getState().activeSection).toBe("search");
    setActivitySection("debug");
    expect(zone1.getState().activeSection).toBe("debug");
    runGlobalSearch("LoginView");
    expect(zone2.getState().searchQuery).toBe("LoginView");
    expect(zone2.getState().searchResults.length).toBeGreaterThan(0);
  });
});
