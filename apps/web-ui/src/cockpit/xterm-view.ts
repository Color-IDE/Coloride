import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { TerminalView } from "./terminal-drawer.js";

/** xterm.js behind the drawer's `TerminalView`. */
export function createXtermView(): TerminalView {
  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: 'Menlo, "SF Mono", Consolas, "Liberation Mono", monospace',
    fontSize: 12,
    scrollback: 5_000,
    theme: { background: "#181818", foreground: "#d4d4d4" },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  return {
    get cols() {
      return terminal.cols;
    },
    get rows() {
      return terminal.rows;
    },
    open: (container) => terminal.open(container),
    write: (data) => terminal.write(data),
    onData: (listener) => {
      terminal.onData(listener);
    },
    fit: () => {
      const before = `${terminal.cols}x${terminal.rows}`;
      try {
        fit.fit();
      } catch {
        // Not laid out yet (hidden): keep the current size.
      }
      return `${terminal.cols}x${terminal.rows}` !== before;
    },
    focus: () => terminal.focus(),
    dispose: () => terminal.dispose(),
  };
}
