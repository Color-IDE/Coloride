import type { CockpitStoreBundle, Zone1ActivityState } from "../stores.js";
import { INSPECTOR_TOGGLE_ICONS, NAV_BACK_ICON } from "../theme/index.js";
import { UI_STRINGS } from "../ui-strings.js";

const MAX_HISTORY = 50;

/**
 * The window title bar: header slots for Zones 3 and 4, the panel toggles and the chat history
 * arrows (next to the macOS traffic lights).
 */
export class TitleBar {
  readonly element: HTMLElement;
  readonly zone3Header: HTMLElement;
  readonly zone4Header: HTMLElement;
  private readonly sidebarToggle: HTMLButtonElement;
  private readonly inspectorToggle: HTMLButtonElement;
  private readonly back: HTMLButtonElement;
  private readonly forward: HTMLButtonElement;
  /** Chats the user selected, oldest first. */
  private history: string[] = [];
  private historyIndex = -1;
  private navigating = false;

  constructor(
    doc: Document,
    rootContainer: HTMLElement,
    private readonly stores: CockpitStoreBundle,
  ) {
    // Reuse the `.coloride-macos-titlebar` of the host page if present.
    const existing = doc.querySelector<HTMLElement>(".coloride-macos-titlebar");
    if (existing) {
      this.element = existing;
      this.element.replaceChildren();
    } else {
      this.element = doc.createElement("header");
      this.element.className = "coloride-macos-titlebar";
      rootContainer.append(this.element);
    }
    this.element.setAttribute("data-tauri-drag-region", "");

    const spacer = doc.createElement("div");
    spacer.className = "coloride-top-header-spacer";
    spacer.setAttribute("data-tauri-drag-region", "");

    this.zone3Header = doc.createElement("div");
    this.zone3Header.className = "coloride-zone-3-header";
    this.zone3Header.setAttribute("data-tauri-drag-region", "");
    this.zone3Header.setAttribute("aria-label", UI_STRINGS.shell.openSessions);

    this.zone4Header = doc.createElement("div");
    this.zone4Header.className = "coloride-zone-4-header";
    this.zone4Header.setAttribute("data-tauri-drag-region", "");
    this.zone4Header.setAttribute("aria-label", UI_STRINGS.shell.openFiles);

    // Pinned to the corners so they stay reachable when the side panels collapse.
    this.inspectorToggle = this.button(doc, "coloride-inspector-toggle", () =>
      stores.toggleInspector(),
    );
    this.back = this.historyButton(doc, "coloride-history-back", UI_STRINGS.titleBar.back, -1);
    this.forward = this.historyButton(
      doc,
      "coloride-history-forward",
      UI_STRINGS.titleBar.forward,
      1,
    );
    this.sidebarToggle = this.button(doc, "coloride-sidebar-toggle", () => stores.toggleSidebar());

    this.element.append(
      spacer,
      this.zone3Header,
      this.zone4Header,
      this.inspectorToggle,
      this.back,
      this.forward,
      this.sidebarToggle,
    );
  }

  update(z1: Zone1ActivityState, gridColumns: string): void {
    this.element.style.gridTemplateColumns = gridColumns;
    // Lets the header keep its tabs clear of the corner toggles and the traffic lights.
    this.element.dataset.sidebarOpen = String(z1.sidebarOpen);
    this.element.dataset.inspectorOpen = String(z1.inspectorOpen);
    this.zone4Header.style.visibility = z1.inspectorOpen ? "visible" : "hidden";
    this.updateToggle(
      this.sidebarToggle,
      z1.sidebarOpen,
      UI_STRINGS.titleBar.hideSidebar,
      UI_STRINGS.titleBar.showSidebar,
    );
    this.updateToggle(
      this.inspectorToggle,
      z1.inspectorOpen,
      UI_STRINGS.titleBar.hideInspector,
      UI_STRINGS.titleBar.showInspector,
    );
  }

  /** Records a chat selection unless it comes from the arrows themselves. */
  recordChatVisit(chatId: string): void {
    if (this.navigating || !chatId) return;
    if (this.history[this.historyIndex] !== chatId) {
      this.history = [...this.history.slice(0, this.historyIndex + 1), chatId].slice(-MAX_HISTORY);
      this.historyIndex = this.history.length - 1;
    }
    this.refreshHistory();
  }

  /** Re-evaluates the arrows (e.g. after a chat was closed). */
  refreshHistory(): void {
    this.back.disabled = this.findHistoryTarget(-1) < 0;
    this.forward.disabled = this.findHistoryTarget(1) < 0;
  }

  private button(doc: Document, className: string, onClick: () => void): HTMLButtonElement {
    const el = doc.createElement("button");
    el.type = "button";
    el.className = className;
    el.addEventListener("click", onClick);
    return el;
  }

  private historyButton(
    doc: Document,
    className: string,
    label: string,
    delta: -1 | 1,
  ): HTMLButtonElement {
    const el = this.button(doc, `coloride-history-btn ${className}`, () => this.navigate(delta));
    el.setAttribute("aria-label", label);
    el.title = label;
    el.innerHTML = NAV_BACK_ICON;
    return el;
  }

  private updateToggle(el: HTMLButtonElement, open: boolean, hide: string, show: string): void {
    const label = open ? hide : show;
    el.setAttribute("aria-label", label);
    el.title = label;
    el.setAttribute("aria-pressed", String(!open));
    const icon = open ? "hide" : "show";
    if (el.dataset.icon !== icon) {
      el.innerHTML = INSPECTOR_TOGGLE_ICONS[icon];
      el.dataset.icon = icon;
    }
  }

  /** Nearest entry in `delta` direction whose chat still exists, or -1. */
  private findHistoryTarget(delta: -1 | 1): number {
    const open = new Set(this.stores.zone3.getState().chats.map((chat) => chat.chatId));
    for (let i = this.historyIndex + delta; i >= 0 && i < this.history.length; i += delta) {
      if (open.has(this.history[i] as string)) return i;
    }
    return -1;
  }

  private navigate(delta: -1 | 1): void {
    const target = this.findHistoryTarget(delta);
    if (target < 0) return;
    this.navigating = true;
    try {
      this.historyIndex = target;
      this.stores.selectChat(this.history[target] as string);
    } finally {
      this.navigating = false;
    }
    this.refreshHistory();
  }
}
