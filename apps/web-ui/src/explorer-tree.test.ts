import { describe, expect, it } from "vitest";
import {
  EXPLORER_ROW_HEIGHT_PX,
  stickyAncestorIndices,
  visibleExplorerNodes,
} from "./explorer-tree.js";
import type { CockpitFileTreeNode } from "./stores.js";
import { fileTreeIconColor, fileTreeIconSvg } from "./theme/file-tree-icons.js";

function node(path: string, depth: number, isDirectory = false): CockpitFileTreeNode {
  return {
    path,
    name: path.split("/").pop() ?? path,
    depth,
    isDirectory,
    validationState: "UnchangedBlue",
  };
}

describe("explorer tree", () => {
  const nodes = [
    node("src", 0, true),
    node("src/a", 1, true),
    node("src/a/one.ts", 2),
    node("src/two.ts", 1),
    node("README.md", 0),
  ];

  it("hides every descendant of a collapsed folder and nothing else", () => {
    expect(visibleExplorerNodes(nodes, new Set()).map((n) => n.path)).toHaveLength(5);
    expect(visibleExplorerNodes(nodes, new Set(["src/a"])).map((n) => n.path)).toEqual([
      "src",
      "src/a",
      "src/two.ts",
      "README.md",
    ]);
    expect(visibleExplorerNodes(nodes, new Set(["src"])).map((n) => n.path)).toEqual([
      "src",
      "README.md",
    ]);
  });

  it("picks a language icon and color by file name, with a generic fallback", () => {
    expect(fileTreeIconColor("app.tsx")).toBe("filetree-color-cyan");
    expect(fileTreeIconColor("main.rs")).toBe("filetree-color-orange");
    expect(fileTreeIconColor(".env.local")).toBe("filetree-color-green");
    expect(fileTreeIconColor("unknown.xyz")).toBe("filetree-color-muted");
    expect(fileTreeIconSvg("a.ts")).not.toBe(fileTreeIconSvg("a.py"));
    expect(fileTreeIconSvg("a.ts")).toContain("<svg");
    expect(fileTreeIconSvg("LICENSE")).toBe(fileTreeIconSvg("noext.xyz"));
  });

  describe("sticky folders", () => {
    // 0 docs / 1 adr / 2 a.md / 3 b.md / 4 evidence / 5 c.json / 6 README.md
    const tree = [
      node("docs", 0, true),
      node("docs/adr", 1, true),
      node("docs/adr/a.md", 2),
      node("docs/adr/b.md", 2),
      node("docs/evidence", 1, true),
      node("docs/evidence/c.json", 2),
      node("README.md", 0),
    ];
    const at = (row: number) => row * EXPLORER_ROW_HEIGHT_PX;

    it("pins nothing at the top of the list", () => {
      expect(stickyAncestorIndices(tree, 0)).toEqual([]);
    });

    it("pins the parents of the row that reaches the top, outermost first", () => {
      // `a.md` reached the top: its parents `docs` and `adr` are pinned.
      expect(stickyAncestorIndices(tree, at(2))).toEqual([0, 1]);
    });

    it("drops a folder once its last child has scrolled past", () => {
      expect(stickyAncestorIndices(tree, at(4))).toEqual([0]);
      expect(stickyAncestorIndices(tree, at(6))).toEqual([]);
    });

    it("caps how many folders can be pinned", () => {
      const deep = Array.from({ length: 12 }, (_, i) => node(`d${i}`, i, true));
      deep.push(node("leaf.ts", 12));
      expect(stickyAncestorIndices(deep, at(10), 3)).toHaveLength(3);
    });
  });
});
