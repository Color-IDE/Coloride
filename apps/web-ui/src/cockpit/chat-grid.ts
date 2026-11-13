import { reconcile } from "../dom-utils.js";
import { COLORIDE_DESIGN_TOKENS, type CockpitChatTab, type CockpitStoreBundle } from "../stores.js";
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
 * Zone 3: group tabs in the header and the multi-chat grid. Tabs and cells are keyed (by group
 * and chat id) and updated in place, so token streaming does not rebuild the grid.
 */
export class ChatGrid {
  readonly element: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly tabBar: HTMLElement;
  private readonly tabs = new Map<string, HTMLButtonElement>();
  private readonly cells = new Map<string, ChatCellNodes>();
  private readonly empty: HTMLElement;
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
    this.grid.className = "coloride-zone-3-grid flex-1 p-3.5 gap-3 overflow-auto";
    this.grid.style.display = "grid";
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
    this.grid.dataset.gridMode = String(z3.gridMode);
    const columns = z3.gridMode === 1 ? 1 : 2;
    this.grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;

    const groupChats = z3.chats.filter((chat) => activeGroup?.chatIds.includes(chat.chatId));
    const visible = groupChats.slice(0, z3.gridMode);
    const selected = groupChats.find((chat) => chat.chatId === z3.activeChatId);
    if (selected && !visible.includes(selected)) visible[0] = selected;

    const shownIds = new Set(visible.map((chat) => chat.chatId));
    for (const id of this.cells.keys()) if (!shownIds.has(id)) this.cells.delete(id);
    if (visible.length === 0) {
      reconcile(this.grid, [this.empty]);
      return;
    }
    reconcile(
      this.grid,
      visible.map((chat) => this.updateCell(chat, z3.activeChatId === chat.chatId)),
    );
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
