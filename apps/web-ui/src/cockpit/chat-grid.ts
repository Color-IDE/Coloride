import { reconcile } from "../dom-utils.js";
import { type LayoutNode, panelIds, reconcileLayout } from "../layout-tree.js";
import {
  COLORIDE_DESIGN_TOKENS,
  type CockpitChatTab,
  type CockpitStoreBundle,
  resolveGroupLayout,
} from "../stores.js";
import { UI_STRINGS, uiText } from "../ui-strings.js";
import { VirtualChatMessageListRenderer } from "../virtualizer.js";
import { attachHeaderScroll } from "./header-scroll.js";

interface ChatCellNodes {
  readonly el: HTMLElement;
  readonly header: HTMLElement;
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
  private layoutRoot: HTMLElement | null = null;
  private layoutShape = "";
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
    this.grid.className = "coloride-zone-3-grid flex-1 overflow-auto";
    this.grid.style.display = "flex";
    this.element.append(this.grid);

    this.empty = doc.createElement("div");
    this.empty.className = "coloride-group-empty";
    this.empty.textContent = UI_STRINGS.chat.emptyGroup;

    this.tabBar = doc.createElement("div");
    this.tabBar.className = "coloride-chat-tab-bar";
    this.tabBar.setAttribute("data-tauri-drag-region", "");
    this.tabBar.setAttribute("role", "tablist");
    header.replaceChildren(this.tabBar);
    this.releaseHeaderScroll = attachHeaderScroll(header, this.tabBar);
  }

  update(): void {
    this.updateTabs();
    this.updateGrid();
  }

  destroy(): void {
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
    reconcile(this.tabBar, ordered);
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
    if (cell.header.textContent !== headerText) cell.header.textContent = headerText;
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
    const messages = doc.createElement("div");
    messages.className = "coloride-chat-cell-messages";
    const logs = doc.createElement("div");
    logs.className = "coloride-chat-cell-logs";
    el.append(header, messages, logs);
    return { el, header, messages, logs };
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
