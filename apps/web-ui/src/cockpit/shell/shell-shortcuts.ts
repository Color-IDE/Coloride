import type { CockpitStoreBundle } from "../../stores/index.js";
import { UI_STRINGS } from "../../ui-strings.js";
import type { DebugPanel } from "../inspector/debug-panel.js";
interface ShellShortcutHost {
  readonly stores: CockpitStoreBundle;
  readonly debug: Pick<DebugPanel, "handleKey"> | null;
  readonly terminalAvailable: boolean;
  openTerminal(): void;
  toggleTree(): void;
  save(): Promise<void>;
  reportError(message: string): void;
}
/** Document-scoped shortcuts, detached when the shell is destroyed. */
export function bindShellShortcuts(doc: Document, host: ShellShortcutHost): () => void {
  const listener = (event: KeyboardEvent) => handleShortcut(event, host);
  doc.addEventListener("keydown", listener);
  return () => doc.removeEventListener("keydown", listener);
}
function handleShortcut(event: KeyboardEvent, host: ShellShortcutHost): void {
  if (host.debug?.handleKey(event)) {
    event.preventDefault();
    return;
  }
  // Ctrl+` (also on macOS, as in VS Code) or Ctrl/Cmd+J, for keyboards where the backtick is
  // a dead key: go to the terminal panel, creating it if there is none.
  const backtick =
    event.ctrlKey && !event.metaKey && (event.code === "Backquote" || event.key === "`");
  const panelKey =
    (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "j";
  if (host.terminalAvailable && (backtick || panelKey)) {
    event.preventDefault();
    host.openTerminal();
    return;
  }
  // Ctrl/Cmd+Shift+E: hide or show the file tree.
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "e") {
    event.preventDefault();
    host.toggleTree();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void host.save().catch((error: unknown) => {
      host.reportError(error instanceof Error ? error.message : UI_STRINGS.editor.saveFailed);
    });
    return;
  }
  if (host.stores.handleActivityBarShortcut(event.key, event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    return;
  }
  if (event.altKey && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
    // Alt+Arrow also moves the caret by word in the editor and in text fields (macOS): there it
    // belongs to the text, never to the session switcher.
    if (event.defaultPrevented || isTextEditingTarget(event.target)) return;
    const { chats, activeChatId } = host.stores.zone3.getState();
    const index = chats.findIndex((chat) => chat.chatId === activeChatId);
    if (index < 0 || chats.length < 2) return;
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = chats[(index + delta + chats.length) % chats.length];
    if (next) {
      host.stores.selectChat(next.chatId);
      event.preventDefault();
    }
  }
}

/** Whether keys typed at `target` edit text: a field, or the code editor's content. */
function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable || target.closest("input, textarea, [contenteditable='true']") !== null
  );
}
