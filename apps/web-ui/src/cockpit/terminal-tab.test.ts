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
  const stores = createCockpitStoreBundle();
  const controller = new CockpitDomController({
    rootContainer: root,
    stores,
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
  const pressKey = (init: KeyboardEventInit) =>
    document.dispatchEvent(new KeyboardEvent("keydown", init));
  const terminals = () => stores.zone3.getState().chats.filter((chat) => chat.kind === "terminal");
  const panes = () => root.querySelectorAll<HTMLElement>(".coloride-terminal-pane");
  const plus = () => root.querySelector<HTMLButtonElement>(".coloride-header-tab-add");
  const menuItems = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>(".coloride-new-panel-item"));
  const item = (label: string) =>
    menuItems().find((candidate) => candidate.textContent?.startsWith(label));
  return { controller, stores, views, opened, press, pressKey, terminals, panes, plus, item };
}

describe("terminal as a Zone 3 panel", () => {
  it("starts nothing until the user opens a terminal; Ctrl+` then adds a Terminal tab", async () => {
    const { opened, press, terminals, panes, stores } = setup();
    await settle();
    expect(opened).toHaveLength(0);
    expect(terminals()).toHaveLength(0);
    press();
    await settle();
    expect(terminals()).toHaveLength(1);
    expect(terminals()[0]?.title).toBe("Terminal");
    expect(panes()).toHaveLength(1);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.size).toEqual({ cols: 80, rows: 24 });
    expect(stores.zone3.getState().activeChatId).toBe(terminals()[0]?.chatId);
    // A shell is a panel, not a session of the sidebar.
    expect(stores.zone2.getState().sessions.some((s) => s.chatId === terminals()[0]?.chatId)).toBe(
      false,
    );
  });

  it("also opens with Ctrl+J or Cmd+J, and when the backtick is typed without its own key", async () => {
    const { pressKey, terminals } = setup();
    pressKey({ key: "j", code: "KeyJ", ctrlKey: true });
    await settle();
    expect(terminals()).toHaveLength(1);
    pressKey({ key: "j", code: "KeyJ", metaKey: true });
    pressKey({ key: "`", code: "BracketLeft", ctrlKey: true });
    await settle();
    // The shortcut goes back to the terminal that exists; it does not pile up new ones.
    expect(terminals()).toHaveLength(1);
  });

  it("the + button offers Terminal and Codex, and Codex opens to Interface or Terminal", async () => {
    const { plus, item, terminals, stores, opened } = setup();
    const sessionsBefore = stores.zone3.getState().chats.length;
    plus()?.click();
    expect(item("Terminal")).toBeDefined();
    expect(item("Codex")).toBeDefined();
    expect(item("Interface")).toBeUndefined();
    item("Codex")?.click();
    expect(item("Interface")).toBeDefined();
    // An agent in a terminal needs the sandbox runner: offered but not available.
    expect(item("Terminal")?.disabled ?? false).toBe(false);
    const agentTerminal = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".coloride-new-panel-submenu button"),
    ).find((button) => button.textContent?.startsWith("Terminal"));
    expect(agentTerminal?.disabled).toBe(true);
    agentTerminal?.click();
    expect(stores.zone3.getState().chats).toHaveLength(sessionsBefore);
    item("Interface")?.click();
    expect(stores.zone3.getState().chats).toHaveLength(sessionsBefore + 1);
    expect(terminals()).toHaveLength(0);
    expect(opened).toHaveLength(0);
    expect(document.querySelector(".coloride-new-panel-menu")).toBeNull();
  });

  it("choosing Terminal in the + menu adds a terminal tab and starts a shell", async () => {
    const { plus, item, terminals, opened } = setup();
    plus()?.click();
    item("Terminal")?.click();
    await settle();
    expect(terminals()).toHaveLength(1);
    expect(opened).toHaveLength(1);
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

  it("switching to another tab keeps the shell running", async () => {
    const { opened, press, stores, terminals } = setup();
    press();
    await settle();
    const other = stores.zone3.getState().chats.find((chat) => chat.kind !== "terminal");
    stores.selectChat(other?.chatId ?? "");
    await settle();
    expect(opened[0]?.closed).toBe(false);
    press();
    await settle();
    expect(stores.zone3.getState().activeChatId).toBe(terminals()[0]?.chatId);
    expect(opened).toHaveLength(1);
  });

  it("closing the tab ends the shell and every job it started", async () => {
    const { opened, press, stores, terminals, views, panes } = setup();
    press();
    await settle();
    stores.closeChat(terminals()[0]?.chatId ?? "");
    await settle();
    expect(opened[0]?.closed).toBe(true);
    expect(views[0]?.disposed).toBe(true);
    expect(panes()).toHaveLength(0);
    expect(terminals()).toHaveLength(0);
  });

  it("an exited shell is reported, and the reason a shell was refused is shown", async () => {
    const exited = setup();
    exited.press();
    await settle();
    exited.opened[0]?.exit();
    expect(exited.panes()[0]?.querySelector(".coloride-terminal-status")?.textContent).toBe(
      "Process exited",
    );

    const refused = setup("workspace is not trusted: Terminal is blocked");
    refused.press();
    await settle();
    expect(refused.panes()[0]?.querySelector(".coloride-terminal-status")?.textContent).toContain(
      "not trusted",
    );
  });

  it("panels open in the order of the tabs: each new one goes to the right of the active one", async () => {
    const { plus, item, stores } = setup();
    const layoutIds = () => {
      const group = stores.navigation
        .getState()
        .groups.find((candidate) => candidate.id === stores.navigation.getState().activeGroupId);
      const layout = group?.layout;
      return layout?.kind === "split"
        ? { direction: layout.direction, panels: layout.children }
        : null;
    };
    plus()?.click();
    item("Codex")?.click();
    item("Interface")?.click();
    plus()?.click();
    item("Terminal")?.click();
    await settle();
    const split = layoutIds();
    expect(split?.direction).toBe("row");
    const ids = (split?.panels ?? []).map((child) => (child.kind === "panel" ? child.id : "?"));
    const chats = stores.zone3.getState().chats.map((chat) => chat.chatId);
    // Tab order and left-to-right order agree, and the terminal is last.
    expect(ids).toEqual(chats);
    expect(stores.zone3.getState().chats.at(-1)?.kind).toBe("terminal");
  });

  it("clicking inside a terminal panel selects it, and so its header tab", async () => {
    const { press, stores, terminals, panes, opened } = setup();
    press();
    await settle();
    const terminalId = terminals()[0]?.chatId ?? "";
    const other = stores.zone3.getState().chats.find((chat) => chat.kind !== "terminal");
    stores.selectChat(other?.chatId ?? "");
    await settle();
    expect(stores.zone3.getState().activeChatId).toBe(other?.chatId);
    panes()[0]?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    await settle();
    expect(stores.zone3.getState().activeChatId).toBe(terminalId);
    const selected = document.querySelector<HTMLElement>(
      `.coloride-zone-3-header [data-chat-id="${terminalId}"]`,
    );
    expect(selected?.getAttribute("aria-selected")).toBe("true");
    expect(opened).toHaveLength(1);
  });

  it("a session created while a terminal is selected is a Codex session, not a 'Shell' one", async () => {
    const { press, stores } = setup();
    press();
    await settle();
    const active = stores.zone3.getState().activeChatId;
    expect(stores.zone3.getState().chats.find((chat) => chat.chatId === active)?.kind).toBe(
      "terminal",
    );
    const created = stores.createChat({ nextToActive: true });
    const session = stores.zone3.getState().chats.find((chat) => chat.chatId === created);
    expect(session?.kind).toBe("agent");
    expect(session?.modelName).toBe("Codex");
  });

  it("'New session' in the sidebar and in an empty group opens a terminal when the host has one", async () => {
    const { stores, terminals, opened } = setup();
    document
      .querySelector<HTMLButtonElement>(
        '.sidebar-group[data-group-id="initial-group"] .sidebar-add',
      )
      ?.click();
    await settle();
    expect(terminals()).toHaveLength(1);
    expect(opened).toHaveLength(1);

    stores.createWorkGroup("Other");
    document.querySelector<HTMLButtonElement>(".coloride-group-empty-add")?.click();
    await settle();
    expect(terminals()).toHaveLength(2);
    expect(opened).toHaveLength(2);
    // The + menu of the header still offers both: Codex > Interface makes an agent session.
    const before = stores.zone3.getState().chats.length;
    document.querySelector<HTMLButtonElement>(".coloride-header-tab-add")?.click();
    Array.from(document.querySelectorAll<HTMLButtonElement>(".coloride-new-panel-item"))
      .find((item) => item.textContent?.startsWith("Codex"))
      ?.click();
    Array.from(document.querySelectorAll<HTMLButtonElement>(".coloride-new-panel-item"))
      .find((item) => item.textContent?.startsWith("Interface"))
      ?.click();
    expect(stores.zone3.getState().chats).toHaveLength(before + 1);
    expect(terminals()).toHaveLength(2);
  });
});
