// @vitest-environment happy-dom
import { ColorideEditorView, InMemoryBinaryHostBridge } from "@coloride/editor-cm6";
import { afterEach, describe, expect, it } from "vitest";
import {
  CockpitDomController,
  type DebugCommandMessage,
  type DebugEventMessage,
  type DebugHost,
  createCockpitStoreBundle,
} from "../index.js";
import type { Inspector } from "./inspector.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const stores = createCockpitStoreBundle();
  stores.setProjectPath("/work/app");
  const started: Array<{ program: string; breakpoints: Array<[string, number[]]> }> = [];
  const requests: DebugCommandMessage[] = [];
  const updates: Array<[string, readonly number[]]> = [];
  let emit: (events: readonly DebugEventMessage[]) => void = () => undefined;
  let stops = 0;
  const host: DebugHost = {
    start: async (program, breakpoints, onEvents) => {
      started.push({ program, breakpoints: breakpoints.map(([p, l]) => [p, [...l]]) });
      emit = onEvents;
    },
    request: async (command) => {
      requests.push(command);
      if (typeof command === "object" && "StackTrace" in command) {
        return {
          stackFrames: [{ id: 7, name: "add", line: 3, source: { path: "/work/app/src/app.js" } }],
        };
      }
      if (typeof command === "object" && "Scopes" in command) {
        return { scopes: [{ variablesReference: 11, expensive: false }] };
      }
      if (typeof command === "object" && "Variables" in command) {
        return {
          variables: [
            { name: "a", value: "40" },
            { name: "b", value: "2" },
          ],
        };
      }
      return {};
    },
    setBreakpoints: async (path, lines) => {
      updates.push([path, lines]);
    },
    stop: async () => {
      stops += 1;
    },
  };
  const editorView = new ColorideEditorView({
    initialDocumentId: "src/app.js",
    initialContent: "",
    ipcChannel: new InMemoryBinaryHostBridge(),
  });
  const controller = new CockpitDomController({
    rootContainer: root,
    stores,
    editorView,
    debugHost: host,
    readWorkspaceFile: async (path) =>
      path === "src/app.js"
        ? "function add(a, b) {\n  const sum = a + b;\n  return sum;\n}\nadd(40, 2);\n"
        : "x();\n",
  });
  cleanups.push(() => {
    controller.destroy();
    editorView.destroy();
    root.remove();
  });
  const inspector = (controller as unknown as { inspector: Inspector }).inspector;
  const key = (key: string, shiftKey = false) =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
  const panel = () => root.querySelector<HTMLElement>(".coloride-debug-panel");
  return {
    controller,
    editorView,
    inspector,
    started,
    requests,
    updates,
    key,
    panel,
    emit: (e: DebugEventMessage[]) => emit(e),
    stops: () => stops,
  };
}

describe("JavaScript debugger panel", () => {
  it("F5 debugs the shown file with every breakpoint of the project", async () => {
    const t = setup();
    await t.inspector.openFile("src/app.js");
    await settle();
    t.editorView.setBreakpointLines([3]);
    await t.inspector.openFile("src/other.js");
    await settle();
    t.editorView.setBreakpointLines([1]);
    await t.inspector.openFile("src/app.js");
    await settle();
    // Each file got its own breakpoints back.
    expect(t.editorView.getBreakpointLines()).toEqual([3]);
    t.key("F5");
    await settle();
    expect(t.started).toEqual([
      {
        program: "src/app.js",
        breakpoints: [
          ["src/app.js", [3]],
          ["src/other.js", [1]],
        ],
      },
    ]);
  });

  it("a stop shows the call stack and variables; F10 steps; Shift+F5 stops", async () => {
    const t = setup();
    await t.inspector.openFile("src/app.js");
    await settle();
    t.key("F5");
    await settle();
    t.emit([{ role: "Debuggee", event: "stopped", body: { reason: "breakpoint", threadId: 4 } }]);
    await settle();
    await settle();
    expect(t.panel()?.dataset.debugState).toBe("paused");
    expect(t.panel()?.querySelector(".coloride-debug-stack")?.textContent).toContain(
      "add  src/app.js:3",
    );
    expect(t.panel()?.querySelector(".coloride-debug-variables")?.textContent).toBe("a = 40b = 2");

    t.key("F10");
    expect(t.requests.at(-1)).toEqual({ Next: { thread_id: 4 } });
    t.emit([{ role: "Debuggee", event: "continued", body: { threadId: 4 } }]);
    expect(t.panel()?.querySelector(".coloride-debug-variables")?.textContent).toBe("");
    t.emit([
      { role: "Debuggee", event: "output", body: { category: "stdout", output: "héllo 𝄞 42\n" } },
    ]);
    t.emit([
      {
        role: "Launcher",
        event: "output",
        body: { category: "telemetry", output: "js-debug/launch" },
      },
    ]);
    expect(t.panel()?.querySelector(".coloride-debug-output")?.textContent).toBe("héllo 𝄞 42");

    t.key("F5", true);
    await settle();
    expect(t.stops()).toBe(1);
    expect(t.panel()?.dataset.debugState).toBe("ended");
  });

  it("breakpoints changed while running reach the program; untrusted refusals are shown", async () => {
    const t = setup();
    await t.inspector.openFile("src/app.js");
    await settle();
    t.key("F5");
    await settle();
    t.editorView.setBreakpointLines([2]);
    expect(t.updates).toEqual([["src/app.js", [2]]]);

    // A malformed adapter payload is ignored rather than breaking the panel.
    t.emit([{ role: "Debuggee", event: "stopped", body: "garbage" }]);
    await settle();
    expect(t.panel()?.dataset.debugState).toBe("paused");
    t.emit([
      { role: "Launcher", event: "launchFailed", body: { message: "workspace is not trusted" } },
    ]);
    expect(t.panel()?.querySelector(".coloride-debug-status")?.textContent).toBe(
      "workspace is not trusted",
    );
  });
});
