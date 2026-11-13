import { describe, expect, it } from "vitest";
import { detectIndentSize, indentGuideColumns } from "./indent-guide-columns.js";

describe("CodeMirror indentation guides", () => {
  it("continues a scope guide across blank lines until the closing brace", () => {
    expect(
      indentGuideColumns(["export function LoginView() {", "  return true;", "", "", "}"], 2),
    ).toEqual([[], [0], [0], [0], []]);
  });

  it("guesses the indentation step of a file like an editor does", () => {
    const code = ["function a() {", "  if (x) {", "    run();", "  }", "}", "", "const b = 1;"];
    expect(detectIndentSize(code)).toBe(2);
    const wide = ["fn a() {", "    if x {", "        run();", "    }", "}"];
    expect(detectIndentSize(wide)).toBe(4);
    // A text with paragraphs indented by 3, like the Apache LICENSE.
    const license = [
      "TERMS AND CONDITIONS",
      "",
      "1. Definitions.",
      "",
      '   "License" shall mean the terms',
      "   and distribution as defined",
      "",
      '   "Licensor" shall mean the owner',
      "",
      "2. Grant of License.",
      "",
      "   Subject to the terms",
    ];
    expect(detectIndentSize(license)).toBe(3);
    // No regular indentation: the usual default.
    expect(detectIndentSize(["a", "b", "c"])).toBe(4);
    expect(indentGuideColumns(license, 3)[4]).toEqual([0]);
    expect(indentGuideColumns(["      x"], 3)[0]).toEqual([0, 3]);
  });
});
