import { describe, expect, it } from "vitest";
import { indentGuideColumns } from "./indent-guide-columns.js";

describe("CodeMirror indentation guides", () => {
  it("continues a scope guide across blank lines until the closing brace", () => {
    expect(
      indentGuideColumns(["export function LoginView() {", "  return true;", "", "", "}"], 2),
    ).toEqual([[], [0], [0], [0], []]);
  });
});
