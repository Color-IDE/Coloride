import { reconcile } from "../dom-utils.js";
import { type LayoutNode, panelIds, reconcileLayout } from "../layout-tree.js";
import { PLUS_ICON } from "../sidebar/icons.js";
import {
  COLORIDE_DESIGN_TOKENS,
  type CockpitChatTab,
  type CockpitStoreBundle,
  resolveGroupLayout,
} from "../stores.js";
import { UI_STRINGS, uiText } from "../ui-strings.js";
import { VirtualChatMessageListRenderer } from "../virtualizer.js";
import { attachHeaderScroll } from "./header-scroll.js";
import { CLOSE_PANEL_ICON, SPLIT_DOWN_ICON, SPLIT_RIGHT_ICON } from "./panel-icons.js";

interface ChatCellNodes {
  readonly el: HTMLElement;
  readonly header: HTMLElement;
  readonly title: HTMLElement;
  readonly splitRight: HTMLButtonElement;
  readonly splitDown: HTMLButtonElement;
  readonly close: HTMLButtonElement;
  readonly messages: HTMLElement;
  readonly logs: HTMLElement;
}

/**
 * Zone 3: group tabs in the header and the panels of the active tab, arranged by its layout
 * tree (any number of panels). Tabs and cells are keyed (by group and chat id) and updated in
 * place, so token streaming does not rebuild anything. The split containers are only rebuilt
 * when the shape of the layout changes; a resize just updates the sizes.
 */
export class ChatGrid {
  readonly element: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly tabBar: HTMLElement;
  private readonly tabs = new Map<string, HTMLButtonElement>();
  private readonly cells = new Map<string, ChatCellNodes>();
  private readonly empty: HTMLElement;
  private readonly addButton: HTMLButtonElement;
  private readonly emptyAdd: HTMLButtonElement;
  private layoutRoot: HTMLElement | null = null;
  private layoutShape = "";
  /** What the enabled/disabled state of the creation buttons was computed for. */
  private actionsKey = "";
  private readonly resizeObserver: ResizeObserver | null;
  private readonly messageRenderer = new VirtualChatMessageListRenderer();
  private readonly releaseHeaderScroll: () => void;

  constructor(
    doc: Document,
    private readonly stores: CockpitStoreBundle,
    header: HTMLElement,
  ) {
    this.element = doc.createElement("main");
    this.element.className =
      "coloride-zone-3-multichat bg-main border-t border-b border-l border-white/8 flex flex-col h-full";
    this.element.setAttribute("aria-label", UI_STRINGS.shell.chatGrid);
    this.element.style.minWidth = "0";
    this.element.style.overflow = "hidden";

    this.grid = doc.createElement("section");
    this.grid.className = "coloride-zone-3-grid flex-1 overflow-hidden";
    this.grid.style.display = "flex";
    this.element.append(this.grid);

    this.empty = doc.createElement("div");
    this.empty.className = "coloride-group-empty";
    const emptyText = doc.createElement("p");
    emptyText.textContent = UI_STRINGS.chat.emptyGroup;
    this.emptyAdd = this.createAddButton(
      doc,
      "coloride-group-empty-add",
      UI_STRINGS.chat.newSession,
    );
    this.empty.append(emptyText, this.emptyAdd);

    this.tabBar = doc.createElement("div");
    this.tabBar.className = "coloride-chat-tab-bar";
    this.tabBar.setAttribute("data-tauri-drag-region", "");
    this.tabBar.setAttribute("role", "tablist");
    this.addButton = this.createAddButton(doc, "coloride-chat-tab-add", "");
    this.addButton.setAttribute("aria-label", UI_STRINGS.chat.newSession);
    this.addButton.innerHTML = PLUS_ICON;
    header.replaceChildren(this.tabBar);
    this.releaseHeaderScroll = attachHeaderScroll(header, this.tabBar);

    // The panel area drives how many panels fit; it is unknown (no limit) without layout.
    this.resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            this.reportArea();
            this.updateActions();
          });
    this.resizeObserver?.observe(this.grid);
  }

  private createAddButton(doc: Document, className: string, label: string): HTMLButtonElement {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = className;
    if (label) btn.textContent = label;
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      this.stores.createChat();
    });
    return btn;
  }

  private reportArea(): void {
    this.stores.setPanelArea({ widthPx: this.grid.clientWidth, heightPx: this.grid.clientHeight });
  }

  /** Enables the buttons that create or close panels depending on room and running agents. */
  private updateActions(force = false): void {
    const z3 = this.stores.zone3.getState();
    const { navigation } = this.stores;
    const nav = navigation.getState();
    const area = this.stores.getPanelArea();
    const key = `${nav.activeGroupId}|${this.layoutShape}|${z3.chats.length}|${area?.widthPx}x${area?.heightPx}|${z3.activeRunningAgentChatId}|${z3.sequentialAgentQueue.join(",")}`;
    if (!force && key === this.actionsKey) return;
    this.actionsKey = key;
    const noRoom = UI_STRINGS.chat.noRoom;
    const canAny = this.stores.canCreateChat();
    for (const btn of [this.addButton, this.emptyAdd]) {
      btn.disabled = !canAny;
      btn.title = canAny ? UI_STRINGS.chat.newSession : noRoom;
    }
    for (const [chatId, cell] of this.cells) {
      const right = this.stores.canCreateChat({ from: chatId, direction: "row" });
      const down = this.stores.canCreateChat({ from: chatId, direction: "column" });
      cell.splitRight.disabled = !right;
      cell.splitRight.title = right ? UI_STRINGS.chat.splitRight : noRoom;
      cell.splitDown.disabled = !down;
      cell.splitDown.title = down ? UI_STRINGS.chat.splitDown : noRoom;
      const busy =
        z3.chats.length <= 1 ||
        z3.activeRunningAgentChatId === chatId ||
        z3.sequentialAgentQueue.includes(chatId);
      cell.close.disabled = busy;
    }
  }

  update(): void {
    this.updateTabs();
    this.updateGrid();
    this.updateActions();
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.releaseHeaderScroll();
  }

  private updateTabs(): void {
    const doc = this.tabBar.ownerDocument;
    const navigation = this.stores.navigation.getState();
    const ids = new Set(navigation.groups.map((group) => group.id));
    for (const id of this.tabs.keys()) if (!ids.has(id)) this.tabs.delete(id);
    const ordered = navigation.groups.map((group) => {
      let tab = this.tabs.get(group.id);
      if (!tab) {
        tab = doc.createElement("button");
        tab.type = "button";
        tab.className = "coloride-chat-tab coloride-work-group-tab";
        tab.setAttribute("role", "tab");
        tab.addEventListener("click", () => this.stores.selectWorkGroup(group.id));
        this.tabs.set(group.id, tab);
      }
      if (tab.textContent !== group.title) tab.textContent = group.title;
      tab.setAttribute("aria-selected", String(group.id === navigation.activeGroupId));
      return tab;
    });
    reconcile(this.tabBar, [...ordered, this.addButton]);
  }

  private updateGrid(): void {
    const z3 = this.stores.zone3.getState();
    const navigation = this.stores.navigation.getState();
    const activeGroup = navigation.groups.find((group) => group.id === navigation.activeGroupId);
    const chatsById = new Map(z3.chats.map((chat) => [chat.chatId, chat]));
    let layout = activeGroup ? resolveGroupLayout(activeGroup) : null;
    // A group can still list a chat that no longer exists.
    if (layout && panelIds(layout).some((id) => !chatsById.has(id))) {
      layout = reconcileLayout(
        layout,
        panelIds(layout).filter((id) => chatsById.has(id)),
      );
    }

    const shownIds = new Set(panelIds(layout));
    for (const id of this.cells.keys()) if (!shownIds.has(id)) this.cells.delete(id);
    if (!layout) {
      this.layoutRoot = null;
      this.layoutShape = "";
      reconcile(this.grid, [this.empty]);
      return;
    }
    for (const id of shownIds) {
      const chat = chatsById.get(id);
      if (chat) this.updateCell(chat, z3.activeChatId === id);
    }

    const shape = layoutShape(layout);
    if (this.layoutRoot?.isConnected && shape === this.layoutShape) {
      applySizes(layout, this.layoutRoot, true);
      return;
    }
    // Moving a cell in the DOM resets its scroll position: put it back after the rebuild.
    const scrolls = new Map<string, number>();
    for (const [id, cell] of this.cells) scrolls.set(id, cell.messages.scrollTop);
    this.layoutRoot = this.buildLayout(layout, true);
    this.layoutShape = shape;
    reconcile(this.grid, [this.layoutRoot]);
    for (const [id, cell] of this.cells) cell.messages.scrollTop = scrolls.get(id) ?? 0;
  }

  private buildLayout(node: LayoutNode, isRoot: boolean): HTMLElement {
    let el: HTMLElement;
    if (node.kind === "panel") {
      el = (this.cells.get(node.id) as ChatCellNodes).el;
    } else {
      el = this.grid.ownerDocument.createElement("div");
      el.className = "coloride-layout-split";
      el.dataset.direction = node.direction;
      el.append(...node.children.map((child) => this.buildLayout(child, false)));
    }
    el.classList.toggle("coloride-layout-root", isRoot);
    applySizes(node, el, isRoot);
    return el;
  }

  private updateCell(chat: CockpitChatTab, active: boolean): HTMLElement {
    const z3 = this.stores.zone3.getState();
    let cell = this.cells.get(chat.chatId);
    if (!cell) {
      cell = this.createCell(chat.chatId);
      this.cells.set(chat.chatId, cell);
    }
    const token = COLORIDE_DESIGN_TOKENS[chat.validationState];
    cell.el.dataset.validationState = chat.validationState;
    cell.el.dataset.active = String(active);
    cell.el.setAttribute("aria-label", uiText.chatCell(chat.title, token.labelEn));
    // Exact 2px Coloride state border from DESIGN_SYSTEM.md §2
    cell.el.style.border = `2px solid ${token.darkBorder}`;
    cell.el.style.backgroundColor = token.darkBg;
    cell.el.style.color = token.darkText;
    const headerText = uiText.chatCellHeader(token.icon, chat.title, chat.modelName, token.labelEn);
    if (cell.title.textContent !== headerText) cell.title.textContent = headerText;
    this.messageRenderer.renderInto(cell.messages, z3.messagesByChatId[chat.chatId] ?? [], 0, 400);
    const logs = z3.terminalLogsByChatId[chat.chatId] ?? [];
    cell.logs.dataset.logCount = String(logs.length);
    cell.logs.textContent = logs.slice(-5).join("\n");
    return cell.el;
  }

  private createCell(chatId: string): ChatCellNodes {
    const doc = this.grid.ownerDocument;
    const el = doc.createElement("section");
    el.className = "coloride-chat-cell";
    el.dataset.chatId = chatId;
    const header = doc.createElement("div");
    header.className = "coloride-chat-cell-header";
    header.addEventListener("click", () => this.stores.selectChat(chatId));
    const title = doc.createElement("span");
    title.className = "coloride-chat-cell-title";
    const actions = doc.createElement("div");
    actions.className = "coloride-chat-cell-actions";
    const action = (className: string, icon: string, label: string, run: () => void) => {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = `coloride-chat-cell-action ${className}`;
      btn.innerHTML = icon;
      btn.setAttribute("aria-label", label);
      btn.title = label;
      // The header selects the chat on click: acting on a panel must not also do that.
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!btn.disabled) run();
      });
      return btn;
    };
    const splitRight = action(
      "coloride-split-right",
      SPLIT_RIGHT_ICON,
      UI_STRINGS.chat.splitRight,
      () => this.stores.createChat({ from: chatId, direction: "row" }),
    );
    const splitDown = action(
      "coloride-split-down",
      SPLIT_DOWN_ICON,
      UI_STRINGS.chat.splitDown,
      () => this.stores.createChat({ from: chatId, direction: "column" }),
    );
    const close = action("coloride-close-panel", CLOSE_PANEL_ICON, UI_STRINGS.chat.closePanel, () =>
      this.stores.closeChat(chatId),
    );
    actions.append(splitRight, splitDown, close);
    header.append(title, actions);
    const messages = doc.createElement("div");
    messages.className = "coloride-chat-cell-messages";
    const logs = doc.createElement("div");
    logs.className = "coloride-chat-cell-logs";
    el.append(header, messages, logs);
    return { el, header, title, splitRight, splitDown, close, messages, logs };
  }
}

/** Identifies the structure of a layout (panels and split directions) but not the sizes. */
function layoutShape(node: LayoutNode): string {
  return node.kind === "panel"
    ? node.id
    : `${node.direction === "row" ? "r" : "c"}(${node.children.map(layoutShape).join(",")})`;
}

/** Sizes every child of a split with `flex-grow` proportional to its share; recurses. */
function applySizes(node: LayoutNode, el: HTMLElement, isRoot: boolean): void {
  if (isRoot) el.style.flex = "";
  if (node.kind === "panel") return;
  el.dataset.direction = node.direction;
  node.children.forEach((child, index) => {
    const childEl = el.children[index] as HTMLElement | undefined;
    if (!childEl) return;
    childEl.style.flex = `${node.sizes[index] ?? 0} 1 0px`;
    applySizes(child, childEl, false);
  });
}
