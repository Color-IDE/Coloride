import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { TerminalView } from "./terminal-pane.js";

/** xterm.js behind a terminal panel's `TerminalView`; same background as the other panels. */
export function createXtermView(): TerminalView {
  // xterm paints its own canvas: give it the panels' colour (`--color-main` of the theme).
  const background =
    globalThis.document?.defaultView
      ?.getComputedStyle(document.documentElement)
      .getPropertyValue("--color-main")
      .trim() || "#1e1e1e";
  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: 'Menlo, "SF Mono", Consolas, "Liberation Mono", monospace',
    fontSize: 12,
    scrollback: 5_000,
    theme: { background, foreground: "#d4d4d4" },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  let container: HTMLElement | null = null;

  /**
   * Columns and rows that fill the container. The fit addon always keeps 14px free for a
   * scrollbar; with overlay scrollbars (macOS) that is an empty strip on the right, so once the
   * terminal has been drawn the grid is measured from its own cells and only a real scrollbar
   * is subtracted. Returns false when nothing could be measured.
   */
  const fitToCells = (): boolean => {
    const screen = container?.querySelector<HTMLElement>(".xterm-screen");
    const viewport = container?.querySelector<HTMLElement>(".xterm-viewport");
    if (!container || !screen || terminal.cols === 0 || terminal.rows === 0) return false;
    const drawn = screen.getBoundingClientRect();
    const cellWidth = drawn.width / terminal.cols;
    const cellHeight = drawn.height / terminal.rows;
    if (!(cellWidth > 0) || !(cellHeight > 0)) return false;
    const scrollbar = viewport ? viewport.offsetWidth - viewport.clientWidth : 0;
    // The room inside xterm's own padding (its element fills the container).
    const style = container.ownerDocument.defaultView?.getComputedStyle(
      terminal.element ?? container,
    );
    const pad = (side: string) =>
      Number.parseFloat(style?.getPropertyValue(`padding-${side}`) ?? "0") || 0;
    const width = container.clientWidth - pad("left") - pad("right") - scrollbar;
    const height = container.clientHeight - pad("top") - pad("bottom");
    const cols = Math.floor(width / cellWidth);
    const rows = Math.floor(height / cellHeight);
    if (cols < 2 || rows < 1) return false;
    if (cols !== terminal.cols || rows !== terminal.rows) terminal.resize(cols, rows);
    return true;
  };
  return {
    get cols() {
      return terminal.cols;
    },
    get rows() {
      return terminal.rows;
    },
    open: (element) => {
      container = element;
      terminal.open(element);
    },
    write: (data) => terminal.write(data),
    onData: (listener) => {
      terminal.onData(listener);
    },
    fit: () => {
      const before = `${terminal.cols}x${terminal.rows}`;
      try {
        // The addon gives the first size (before anything is drawn); the cells do the rest.
        if (!fitToCells()) fit.fit();
      } catch {
        // Not laid out yet (hidden): keep the current size.
      }
      return `${terminal.cols}x${terminal.rows}` !== before;
    },
    focus: () => terminal.focus(),
    dispose: () => terminal.dispose(),
  };
}
