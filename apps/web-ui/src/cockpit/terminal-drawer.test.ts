// @vitest-environment happy-dom
import { ColorideEditorView, InMemoryBinaryHostBridge } from "@coloride/editor-cm6";
import { afterEach, describe, expect, it } from "vitest";
import {
  CockpitDomController,
  type TerminalHandle,
  type TerminalHost,
  type TerminalView,
  createCockpitStoreBundle,
} from "../index.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeView implements TerminalView {
  cols = 80;
  rows = 24;
  written: Array<Uint8Array | string> = [];
  disposed = false;
  private listener: ((data: string) => void) | null = null;
  open(): void {}
  write(data: Uint8Array | string): void {
    this.written.push(data);
  }
  onData(listener: (data: string) => void): void {
    this.listener = listener;
  }
  type(data: string): void {
    this.listener?.(data);
  }
  nextFit: [number, number] | null = null;
  fit(): boolean {
    if (!this.nextFit) return false;
    [this.cols, this.rows] = this.nextFit;
    this.nextFit = null;
    return true;
  }
  focus(): void {}
  dispose(): void {
    this.disposed = true;
  }
}

function setup(refuse?: string) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const views: FakeView[] = [];
  const opened: Array<{
    size: { cols: number; rows: number };
    output: (bytes: Uint8Array) => void;
    exit: () => void;
    writes: string[];
    resizes: Array<[number, number]>;
    closed: boolean;
  }> = [];
  const host: TerminalHost = {
    open: async (size, output, exit) => {
      if (refuse) throw new Error(refuse);
      const record = {
        size,
        output,
        exit,
        writes: [] as string[],
        resizes: [] as Array<[number, number]>,
        closed: false,
      };
      opened.push(record);
      const handle: TerminalHandle = {
        write: (data) => record.writes.push(data),
        resize: (cols, rows) => record.resizes.push([cols, rows]),
        close: () => {
          record.closed = true;
        },
      };
      return handle;
    },
  };
  const editorView = new ColorideEditorView({
    initialDocumentId: "src/main.ts",
    initialContent: "",
    ipcChannel: new InMemoryBinaryHostBridge(),
  });
  const controller = new CockpitDomController({
    rootContainer: root,
    stores: createCockpitStoreBundle(),
    editorView,
    terminalHost: host,
    createTerminalView: () => {
      const view = new FakeView();
      views.push(view);
      return view;
    },
  });
  cleanups.push(() => {
    controller.destroy();
    editorView.destroy();
    root.remove();
  });
  const press = () =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "`", code: "Backquote", ctrlKey: true }),
    );
  const drawer = () => root.querySelector<HTMLElement>(".coloride-terminal-drawer");
  return { controller, views, opened, press, drawer };
}

describe("integrated terminal drawer", () => {
  it("starts nothing until the user opens it with Ctrl+`", async () => {
    const { opened, press, drawer } = setup();
    await settle();
    expect(drawer()?.hidden).toBe(true);
    expect(opened).toHaveLength(0);
    press();
    await settle();
    expect(drawer()?.hidden).toBe(false);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.size).toEqual({ cols: 80, rows: 24 });
  });

  it("streams output to the screen and keystrokes to the shell", async () => {
    const { opened, press, views } = setup();
    press();
    await settle();
    const bytes = new TextEncoder().encode("$ ");
    opened[0]?.output(bytes);
    expect(views[0]?.written).toEqual([bytes]);
    views[0]?.type("ls\r");
    expect(opened[0]?.writes).toEqual(["ls\r"]);
  });

  it("hiding keeps the shell running; reopening reuses it", async () => {
    const { opened, press, drawer, controller } = setup();
    press();
    await settle();
    press();
    await settle();
    expect(drawer()?.hidden).toBe(true);
    expect(opened[0]?.closed).toBe(false);
    press();
    await settle();
    expect(opened).toHaveLength(1);
    expect(controller.getTerminal()?.isRunning()).toBe(true);
  });

  it("the size follows the panel", async () => {
    const { opened, press, views, controller } = setup();
    press();
    await settle();
    const view = views[0] as FakeView;
    view.nextFit = [120, 30];
    // What the ResizeObserver does when the panel is resized.
    await controller.getTerminal()?.setVisible(true);
    expect(opened[0]?.resizes).toEqual([[120, 30]]);
  });

  it("the kill button ends the shell; the next open starts a new one", async () => {
    const { opened, press, drawer, views } = setup();
    press();
    await settle();
    drawer()?.querySelector<HTMLButtonElement>(".coloride-terminal-kill")?.click();
    expect(opened[0]?.closed).toBe(true);
    expect(views[0]?.disposed).toBe(true);
    expect(drawer()?.hidden).toBe(true);
    press();
    await settle();
    expect(opened).toHaveLength(2);
  });

  it("an exited shell is reported, and the reason a shell was refused is shown", async () => {
    const exited = setup();
    exited.press();
    await settle();
    exited.opened[0]?.exit();
    expect(exited.drawer()?.querySelector(".coloride-terminal-status")?.textContent).toBe(
      "Process exited",
    );
    expect(exited.controller.getTerminal()?.isRunning()).toBe(false);

    const refused = setup("workspace is not trusted: Terminal is blocked");
    refused.press();
    await settle();
    expect(refused.drawer()?.querySelector(".coloride-terminal-status")?.textContent).toContain(
      "not trusted",
    );
  });
});
