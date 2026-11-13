// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CockpitFileTreeNode } from "../stores/index.js";
import { FileTreePanel } from "./file-tree-panel.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("file tree panel", () => {
  it("draws the rows that fill its real height as soon as it is laid out, without a scroll", () => {
    let notify: () => void = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    const nodes: CockpitFileTreeNode[] = Array.from({ length: 200 }, (_, index) => ({
      path: `file-${String(index).padStart(3, "0")}.ts`,
      name: `file-${String(index).padStart(3, "0")}.ts`,
      depth: 0,
      isDirectory: false,
      validationState: "UnchangedBlue" as const,
    }));
    const panel = new FileTreePanel(document, {
      className: "test",
      withFilter: false,
      onOpenFile: () => {},
    });
    document.body.append(panel.element);
    panel.update(nodes, "");
    const rows = () => panel.element.querySelectorAll(".coloride-file-tree [data-path]").length;
    const before = rows();

    // The panel turns out to be much taller than the default the tree assumed.
    const scroller = panel.element.querySelector<HTMLElement>(".coloride-file-tree-scroll");
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 3000 });
    notify();
    expect(rows()).toBeGreaterThan(before);
    panel.destroy();
    panel.element.remove();
  });
});
