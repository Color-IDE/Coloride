import { UI_STRINGS } from "../../ui-strings.js";

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
 * One shell shown inside a Zone 3 panel. Nothing starts until the panel is on screen (the grid
 * calls `ensureStarted` once it is attached), and the host refuses a shell for an untrusted
 * folder (the reason is shown in the panel). Closing the panel ends the shell.
 */
export class TerminalPane {
  readonly element: HTMLElement;
  private readonly screen: HTMLElement;
  private readonly status: HTMLElement;
  private view: TerminalView | null = null;
  private handle: TerminalHandle | null = null;
  private starting = false;
  private started = false;
  private readonly resizeObserver: ResizeObserver | null;
  private destroyed = false;

  constructor(
    doc: Document,
    private readonly host: TerminalHost,
    private readonly createView: TerminalViewFactory,
  ) {
    this.element = doc.createElement("div");
    this.element.className = "coloride-terminal-pane";
    this.element.setAttribute("aria-label", UI_STRINGS.terminal.panel);
    this.status = doc.createElement("div");
    this.status.className = "coloride-terminal-status";
    this.status.setAttribute("role", "status");
    this.screen = doc.createElement("div");
    this.screen.className = "coloride-terminal-screen";
    this.element.append(this.screen, this.status);
    this.resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.refit());
    this.resizeObserver?.observe(this.screen);
  }

  isRunning(): boolean {
    return this.handle !== null;
  }

  /** Starts the shell the first time the pane is on screen; later calls only refit. */
  async ensureStarted(): Promise<void> {
    if (!this.started) await this.start();
    this.refit();
  }

  focus(): void {
    this.view?.focus();
  }

  private async start(): Promise<void> {
    if (this.starting || this.destroyed) return;
    this.starting = true;
    this.started = true;
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
    if (!this.view || !this.element.isConnected) return;
    if (this.view.fit()) this.handle?.resize(this.view.cols, this.view.rows);
  }

  /** Ends the shell and every job it started. */
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
