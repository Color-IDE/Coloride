// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ColorideEditorView, InMemoryBinaryHostBridge } from "./index.js";

function editor() {
  const view = new ColorideEditorView({
    initialDocumentId: "src/app.js",
    initialContent: "const a = 1;\nconst b = 2;\nconsole.log(a + b);\n",
    ipcChannel: new InMemoryBinaryHostBridge(),
  });
  view.mount(document.createElement("div"));
  return view;
}

describe("breakpoints", () => {
  it("F9 toggles the current line's breakpoint and listeners hear about it", () => {
    const view = editor();
    const heard: Array<readonly number[]> = [];
    view.onBreakpointsChange((lines) => heard.push(lines));
    const cm = view.getEditorView();
    cm.dispatch({ selection: { anchor: cm.state.doc.line(2).from + 3 } });
    const f9 = new KeyboardEvent("keydown", { key: "F9", bubbles: true, cancelable: true });
    cm.contentDOM.dispatchEvent(f9);
    expect(view.getBreakpointLines()).toEqual([2]);
    cm.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F9", bubbles: true, cancelable: true }),
    );
    expect(view.getBreakpointLines()).toEqual([]);
    expect(heard).toEqual([[2], []]);
  });

  it("breakpoints move with the lines they are on", () => {
    const view = editor();
    view.setBreakpointLines([2, 3]);
    view.dispatchUserEdit(0, 0, "// header\n");
    expect(view.getBreakpointLines()).toEqual([3, 4]);
    // Deleting the line a breakpoint is on leaves one on the line that takes its place.
    const text = view.getDocumentText();
    const line3 = text.indexOf("const b");
    view.dispatchUserEdit(line3, line3 + "const b = 2;\n".length, "");
    expect(view.getBreakpointLines()).toEqual([3]);
  });

  it("another document starts with no breakpoints, and out-of-range lines are ignored", () => {
    const view = editor();
    view.setBreakpointLines([1, 99, 0]);
    expect(view.getBreakpointLines()).toEqual([1]);
    view.switchDocument("src/other.js", "x();\n");
    expect(view.getBreakpointLines()).toEqual([]);
  });
});
