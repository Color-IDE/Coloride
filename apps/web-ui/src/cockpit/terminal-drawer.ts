import { UI_STRINGS } from "../ui-strings.js";

/** A running shell on the host side. */
export interface TerminalHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/**
 * How the cockpit starts shells. The host streams the shell's output in frames (at most one
 * every 16 ms) to `onOutput`, then calls `onExit` once.
 */
export interface TerminalHost {
  open(
    size: { readonly cols: number; readonly rows: number },
    onOutput: (bytes: Uint8Array) => void,
    onExit: () => void,
  ): Promise<TerminalHandle>;
}

/** The terminal emulator on screen (xterm.js in the app; replaceable in tests). */
export interface TerminalView {
  readonly cols: number;
  readonly rows: number;
  open(container: HTMLElement): void;
  write(data: Uint8Array | string): void;
  onData(listener: (data: string) => void): void;
  /** Fits the grid to the container; true when the number of columns or rows changed. */
  fit(): boolean;
  focus(): void;
  dispose(): void;
}

export type TerminalViewFactory = () => TerminalView;

/**
 * The integrated terminal, docked under the Zone 3 panels and toggled with Ctrl+`. Hiding it
 * keeps the shell running; the trash button ends it. Nothing starts until the user opens it,
 * and the host refuses a shell for an untrusted folder (the reason is shown in the drawer).
 */
export class TerminalDrawer {
  readonly element: HTMLElement;
  private readonly screen: HTMLElement;
  private readonly status: HTMLElement;
  private view: TerminalView | null = null;
  private handle: TerminalHandle | null = null;
  private starting = false;
  private readonly resizeObserver: ResizeObserver | null;
  private destroyed = false;

  constructor(
    doc: Document,
    private readonly host: TerminalHost,
    private readonly createView: TerminalViewFactory,
  ) {
    this.element = doc.createElement("section");
    this.element.className = "coloride-terminal-drawer";
    this.element.setAttribute("aria-label", UI_STRINGS.terminal.panel);
    this.element.hidden = true;

    const bar = doc.createElement("div");
    bar.className = "coloride-terminal-bar";
    const title = doc.createElement("span");
    title.textContent = UI_STRINGS.terminal.title;
    this.status = doc.createElement("span");
    this.status.className = "coloride-terminal-status";
    const kill = doc.createElement("button");
    kill.type = "button";
    kill.className = "coloride-terminal-kill";
    kill.textContent = UI_STRINGS.terminal.kill;
    kill.addEventListener("click", () => this.kill());
    const hide = doc.createElement("button");
    hide.type = "button";
    hide.className = "coloride-terminal-hide";
    hide.textContent = UI_STRINGS.terminal.hide;
    hide.addEventListener("click", () => this.setVisible(false));
    bar.append(title, this.status, kill, hide);

    this.screen = doc.createElement("div");
    this.screen.className = "coloride-terminal-screen";
    this.element.append(bar, this.screen);

    this.resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.refit());
    this.resizeObserver?.observe(this.screen);
  }

  isVisible(): boolean {
    return !this.element.hidden;
  }

  isRunning(): boolean {
    return this.handle !== null;
  }

  toggle(): Promise<void> {
    return this.setVisible(!this.isVisible());
  }

  /** Shows the drawer, starting a shell if none runs. */
  async setVisible(visible: boolean): Promise<void> {
    this.element.hidden = !visible;
    if (!visible) return;
    if (!this.handle) await this.start();
    this.refit();
    this.view?.focus();
  }

  private async start(): Promise<void> {
    if (this.starting || this.destroyed) return;
    this.starting = true;
    this.status.textContent = "";
    this.view?.dispose();
    this.screen.replaceChildren();
    const view = this.createView();
    this.view = view;
    view.open(this.screen);
    view.fit();
    try {
      const handle = await this.host.open(
        { cols: view.cols, rows: view.rows },
        (bytes) => {
          if (this.view === view) view.write(bytes);
        },
        () => {
          if (this.view !== view) return;
          this.handle = null;
          this.status.textContent = UI_STRINGS.terminal.exited;
        },
      );
      if (this.destroyed || this.view !== view) {
        handle.close();
        return;
      }
      this.handle = handle;
      view.onData((data) => this.handle?.write(data));
    } catch (error: unknown) {
      this.status.textContent =
        error instanceof Error ? error.message : String(error || UI_STRINGS.terminal.failed);
    } finally {
      this.starting = false;
    }
  }

  private refit(): void {
    if (!this.view || this.element.hidden) return;
    if (this.view.fit()) this.handle?.resize(this.view.cols, this.view.rows);
  }

  /** Ends the shell and every job it started. */
  kill(): void {
    this.handle?.close();
    this.handle = null;
    this.view?.dispose();
    this.view = null;
    this.screen.replaceChildren();
    this.status.textContent = "";
    this.setVisible(false);
  }

  destroy(): void {
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    this.handle?.close();
    this.handle = null;
    this.view?.dispose();
    this.view = null;
    this.element.remove();
  }
}
