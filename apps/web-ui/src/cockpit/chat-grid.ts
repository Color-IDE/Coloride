import { reconcile } from "../dom-utils.js";
import { type LayoutNode, panel, panelIds, reconcileLayout } from "../layout-tree.js";
import { PLUS_ICON } from "../sidebar/icons.js";
import { sessionDisplayTitle } from "../sidebar/sidebar-row.js";
import {
  COLORIDE_DESIGN_TOKENS,
  type CockpitChatTab,
  type CockpitStoreBundle,
  resolveGroupLayout,
  resolveGroupMaximized,
} from "../stores/index.js";
import { UI_STRINGS, uiText } from "../ui-strings.js";
import { VirtualChatMessageListRenderer } from "../virtualizer.js";
import { type HeaderTabSpec, HeaderTabs } from "./header-tabs.js";
import {
  type LayoutHandleHost,
  applySizes,
  createSeparator,
  layoutShape,
} from "./layout-handles.js";
import { NewPanelMenu } from "./new-panel-menu.js";
import { PanelDrag } from "./panel-drag.js";
import {
  CLOSE_PANEL_ICON,
  MAXIMIZE_ICON,
  RESTORE_ICON,
  SPLIT_DOWN_ICON,
  SPLIT_RIGHT_ICON,
} from "./panel-icons.js";
import { sessionIcon } from "./session-presentation.js";
import { type TerminalHost, TerminalPane, type TerminalViewFactory } from "./terminal-pane.js";

/** The icon of a session's header tab: the terminal glyph, the Codex mark, or its state glyph. */
function tabIcon(chat: CockpitChatTab, stateGlyph: string): { svg: string } | { text: string } {
  const icon = sessionIcon(chat);
  if (icon) return { svg: icon };
  return { text: stateGlyph };
}

/** What shells need: the host that starts them and the emulator that draws them. */
export interface ChatGridTerminals {
  readonly host: TerminalHost;
  readonly createView: TerminalViewFactory;
}

interface ChatCellNodes {
  readonly el: HTMLElement;
  readonly header: HTMLElement;
  readonly title: HTMLElement;
  /** The mark of the agent (Codex) before the title, and the text after it. */
  readonly titleIcon: HTMLElement;
  readonly titleText: HTMLElement;
  readonly splitRight: HTMLButtonElement;
  readonly splitDown: HTMLButtonElement;
  readonly maximize: HTMLButtonElement;
  readonly close: HTMLButtonElement;
  readonly messages: HTMLElement;
  readonly logs: HTMLElement;
  readonly kind: "agent" | "terminal";
}

/**
 * Zone 3: a header tab per session of the active group, and the panels of that group arranged
 * by its layout tree (any number of panels). Tabs and cells are keyed (by group and chat id) and updated in
 * place, so token streaming does not rebuild anything. The split containers are only rebuilt
 * when the shape of the layout changes; a resize just updates the sizes.
 */
export class ChatGrid {
  readonly element: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly tabs: HeaderTabs;
  private readonly cells = new Map<string, ChatCellNodes>();
  private readonly empty: HTMLElement;
  private readonly addButton: HTMLButtonElement;
  private readonly emptyAdd: HTMLButtonElement;
  private layoutRoot: HTMLElement | null = null;
  private layoutShape = "";
  /** The layout on screen and the group it belongs to (what a drag starts from and saves into). */
  private shownLayout: LayoutNode | null = null;
  private shownGroupId: string | null = null;
  /** The session shown alone in the active tab, if any. */
  private maximizedId: string | null = null;
  /** Scroll of every panel, kept while a rebuild or a maximize takes it out of the page. */
  private readonly savedScrolls = new Map<string, number>();
  /** What the enabled/disabled state of the creation buttons was computed for. */
  private actionsKey = "";
  private readonly resizeObserver: ResizeObserver | null;
  private readonly messageRenderer = new VirtualChatMessageListRenderer();
  /** One pane per terminal session, alive for as long as the session exists (any group). */
  private readonly panes = new Map<string, TerminalPane>();
  private readonly newPanelMenu: NewPanelMenu;
  private focusedTerminalId: string | null = null;
  /** Moves a panel by its header. */
  private readonly panelDrag: PanelDrag;
  /** What the resize bars read from, and where they save. */
  private readonly handleHost: LayoutHandleHost;

  constructor(
    doc: Document,
    private readonly stores: CockpitStoreBundle,
    header: HTMLElement,
    private readonly terminals: ChatGridTerminals | null = null,
  ) {
    this.newPanelMenu = new NewPanelMenu(doc);
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

    const save = (layout: LayoutNode | null) => {
      if (layout && this.shownGroupId) this.stores.setWorkGroupLayout(this.shownGroupId, layout);
    };
    this.handleHost = {
      grid: this.grid,
      layoutRoot: () => this.layoutRoot,
      shownLayout: () => this.shownLayout,
      save,
    };
    this.panelDrag = new PanelDrag({
      grid: this.grid,
      cell: (chatId) => this.cells.get(chatId)?.el,
      shownLayout: () => this.shownLayout,
      maximized: () => this.maximizedId !== null,
      save,
    });

    this.empty = doc.createElement("div");
    this.empty.className = "coloride-group-empty";
    const emptyText = doc.createElement("p");
    emptyText.textContent = UI_STRINGS.chat.emptyGroup;
    this.emptyAdd = this.createAddButton(
      doc,
      "coloride-group-empty-add",
      UI_STRINGS.chat.newSession,
      () => this.stores.createChat(this.terminals ? { kind: "terminal" } : undefined),
    );
    this.empty.append(emptyText, this.emptyAdd);

    this.addButton = this.createAddButton(doc, "coloride-header-tab-add", "", () =>
      this.newPanelMenu.toggle(this.addButton, {
        ...(this.terminals
          ? {
              openTerminal: () => this.stores.createChat({ kind: "terminal", nextToActive: true }),
            }
          : {}),
        openAgentInterface: () => this.stores.createChat({ nextToActive: true }),
      }),
    );
    this.addButton.setAttribute("aria-label", UI_STRINGS.chat.newMenu);
    this.addButton.setAttribute("aria-haspopup", "menu");
    this.addButton.setAttribute("aria-expanded", "false");
    this.addButton.innerHTML = PLUS_ICON;
    this.tabs = new HeaderTabs(doc, header, {
      ariaLabel: UI_STRINGS.shell.openSessions,
      dataKey: "chatId",
      closeLabel: () => UI_STRINGS.chat.closePanel,
      unsavedLabel: UI_STRINGS.editor.unsaved,
      onSelect: (chatId) => this.stores.selectChat(chatId),
      onClose: (chatId) => this.stores.closeChat(chatId),
      trailing: [this.addButton],
    });

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

  private createAddButton(
    doc: Document,
    className: string,
    label: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = className;
    if (label) btn.textContent = label;
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      onClick();
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
    const key = `${nav.activeGroupId}|${this.layoutShape}|${z3.chats.length}|${area?.widthPx}x${area?.heightPx}|${z3.activeRunningAgentChatId}|${z3.sequentialAgentQueue.join(",")}|${this.maximizedId}`;
    if (!force && key === this.actionsKey) return;
    this.actionsKey = key;
    const noRoom = UI_STRINGS.chat.noRoom;
    const panelCount = panelIds(this.shownLayout).length;
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
      cell.close.disabled = !this.canCloseSession(chatId);
      // Showing one panel alone only makes sense when there are others.
      const alone = this.maximizedId === chatId;
      cell.maximize.hidden = panelCount <= 1;
      cell.maximize.innerHTML = alone ? RESTORE_ICON : MAXIMIZE_ICON;
      const label = alone ? UI_STRINGS.chat.restorePanels : UI_STRINGS.chat.maximizePanel;
      cell.maximize.setAttribute("aria-label", label);
      cell.maximize.title = label;
      cell.maximize.setAttribute("aria-pressed", String(alone));
    }
  }

  update(): void {
    this.updateTabs();
    this.updateGrid();
    this.updateActions();
  }

  destroy(): void {
    this.panelDrag.cancel();
    this.resizeObserver?.disconnect();
    this.newPanelMenu.close(false);
    for (const pane of this.panes.values()) pane.destroy();
    this.panes.clear();
    this.tabs.destroy();
  }

  /** One header tab per session of the active group; selecting one focuses its panel. */
  private updateTabs(): void {
    const z3 = this.stores.zone3.getState();
    const navigation = this.stores.navigation.getState();
    const activeGroup = navigation.groups.find((group) => group.id === navigation.activeGroupId);
    const chatsById = new Map(z3.chats.map((chat) => [chat.chatId, chat]));
    const chats = (activeGroup?.chatIds ?? []).flatMap((id) => chatsById.get(id) ?? []);
    this.tabs.update(
      chats.map((chat): HeaderTabSpec => {
        const token = COLORIDE_DESIGN_TOKENS[chat.validationState];
        return {
          key: chat.chatId,
          label: sessionDisplayTitle(chat.title),
          title: chat.kind === "terminal" ? chat.title : `${chat.title} · ${chat.modelName}`,
          icon: tabIcon(chat, token.icon),
          selected: chat.chatId === z3.activeChatId,
          closable: this.canCloseSession(chat.chatId),
          data: { validationState: chat.validationState },
        };
      }),
    );
  }

  /** The last session stays, and one with a running or queued agent cannot be closed. */
  private canCloseSession(chatId: string): boolean {
    const z3 = this.stores.zone3.getState();
    return !(
      z3.chats.length <= 1 ||
      z3.activeRunningAgentChatId === chatId ||
      z3.sequentialAgentQueue.includes(chatId)
    );
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

    // A shell ends with its session, wherever the session was shown.
    for (const [id, pane] of this.panes) {
      if (!chatsById.has(id)) {
        pane.destroy();
        this.panes.delete(id);
      }
    }
    this.shownLayout = layout;
    this.shownGroupId = activeGroup?.id ?? null;
    const maximized = activeGroup ? resolveGroupMaximized(activeGroup) : null;
    this.maximizedId = maximized && chatsById.has(maximized) ? maximized : null;
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

    // A session shown alone is the whole layout; the other panels stay out of the page (their
    // cells are kept, so they come back as they were) and need no separators.
    const displayed = this.maximizedId ? panel(this.maximizedId) : layout;
    const shape = layoutShape(displayed);
    if (this.layoutRoot?.isConnected && shape === this.layoutShape) {
      applySizes(displayed, this.layoutRoot, true);
      this.startVisibleTerminals(z3.activeChatId);
      return;
    }
    // Moving a cell in the DOM resets its scroll position: put it back after the rebuild. The
    // ones out of the page keep what they had before they left.
    for (const [id, cell] of this.cells) {
      if (cell.el.isConnected) this.savedScrolls.set(id, cell.messages.scrollTop);
    }
    this.layoutRoot = this.buildLayout(displayed, true, []);
    this.layoutShape = shape;
    reconcile(this.grid, [this.layoutRoot]);
    for (const [id, cell] of this.cells) {
      if (cell.el.isConnected) cell.messages.scrollTop = this.savedScrolls.get(id) ?? 0;
    }
    this.startVisibleTerminals(z3.activeChatId);
  }

  /** Starts the shells that are on screen and gives the keyboard to a newly selected one. */
  private startVisibleTerminals(activeChatId: string): void {
    for (const [id, pane] of this.panes) {
      if (!pane.element.isConnected) continue;
      void pane.ensureStarted().then(() => {
        if (this.focusedTerminalId !== activeChatId && id === activeChatId) {
          this.focusedTerminalId = activeChatId;
          pane.focus();
        }
      });
    }
    if (!this.panes.has(activeChatId)) this.focusedTerminalId = null;
  }

  /** `path` is the child indices from the root to `node`; separators remember it. */
  private buildLayout(node: LayoutNode, isRoot: boolean, path: readonly number[]): HTMLElement {
    let el: HTMLElement;
    if (node.kind === "panel") {
      el = (this.cells.get(node.id) as ChatCellNodes).el;
    } else {
      el = this.grid.ownerDocument.createElement("div");
      el.className = "coloride-layout-split";
      el.dataset.direction = node.direction;
      el.append(
        ...node.children.map((child, index) => this.buildLayout(child, false, [...path, index])),
      );
      // After the children, so `children[i]` stays the i-th child; they are positioned by sizes.
      for (let boundary = 0; boundary < node.children.length - 1; boundary += 1) {
        el.append(createSeparator(this.handleHost, node.direction, path, boundary));
      }
    }
    el.classList.toggle("coloride-layout-root", isRoot);
    applySizes(node, el, isRoot);
    return el;
  }

  private updateCell(chat: CockpitChatTab, active: boolean): HTMLElement {
    const z3 = this.stores.zone3.getState();
    let cell = this.cells.get(chat.chatId);
    if (!cell) {
      cell = this.createCell(chat.chatId, chat.kind === "terminal" ? "terminal" : "agent");
      this.cells.set(chat.chatId, cell);
    }
    if (chat.kind === "terminal") {
      let pane = this.panes.get(chat.chatId);
      if (!pane && this.terminals) {
        pane = new TerminalPane(
          this.grid.ownerDocument,
          this.terminals.host,
          this.terminals.createView,
        );
        this.panes.set(chat.chatId, pane);
      }
      if (pane && pane.element.parentElement !== cell.el) cell.el.append(pane.element);
      cell.el.dataset.kind = "terminal";
      cell.el.dataset.active = String(active);
      cell.el.setAttribute("aria-label", chat.title);
      if (cell.titleText.textContent !== chat.title) cell.titleText.textContent = chat.title;
      return cell.el;
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
    // The title is just the session's name ("New session #8"); the model and the validation
    // state stay available as its tooltip.
    const plainTitle = sessionDisplayTitle(chat.title);
    if (cell.titleText.textContent !== plainTitle) cell.titleText.textContent = plainTitle;
    cell.titleText.title = headerText;
    const mark = sessionIcon(chat) ?? "";
    if (cell.titleIcon.innerHTML !== mark) cell.titleIcon.innerHTML = mark;
    cell.titleIcon.hidden = mark === "";
    this.messageRenderer.renderInto(cell.messages, z3.messagesByChatId[chat.chatId] ?? [], 0, 400);
    const logs = z3.terminalLogsByChatId[chat.chatId] ?? [];
    cell.logs.dataset.logCount = String(logs.length);
    cell.logs.textContent = logs.slice(-5).join("\n");
    return cell.el;
  }

  private createCell(chatId: string, kind: "agent" | "terminal"): ChatCellNodes {
    const doc = this.grid.ownerDocument;
    const el = doc.createElement("section");
    el.className = "coloride-chat-cell";
    el.dataset.chatId = chatId;
    // Working inside a panel (clicking its body, or focusing its terminal) selects it, so the
    // header tab and the active panel follow where the user is.
    const selectFromInside = () => {
      if (this.stores.zone3.getState().activeChatId !== chatId) this.stores.selectChat(chatId);
    };
    el.addEventListener("pointerdown", selectFromInside);
    el.addEventListener("focusin", selectFromInside);
    const header = doc.createElement("div");
    header.className = "coloride-chat-cell-header";
    header.title = UI_STRINGS.chat.movePanel;
    header.addEventListener("click", () => this.stores.selectChat(chatId));
    header.addEventListener("pointerdown", (event) => this.panelDrag.begin(chatId, header, event));
    header.addEventListener("pointermove", (event) => this.panelDrag.move(event));
    header.addEventListener("pointerup", (event) => this.panelDrag.end(event));
    header.addEventListener("pointercancel", () => this.panelDrag.cancel());
    const title = doc.createElement("span");
    title.className = "coloride-chat-cell-title";
    const titleIcon = doc.createElement("span");
    titleIcon.className = "coloride-chat-cell-title-icon";
    titleIcon.setAttribute("aria-hidden", "true");
    titleIcon.hidden = true;
    const titleText = doc.createElement("span");
    title.append(titleIcon, titleText);
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
      () =>
        this.stores.createChat({
          from: chatId,
          direction: "row",
          ...(kind === "terminal" ? { kind } : {}),
        }),
    );
    const splitDown = action(
      "coloride-split-down",
      SPLIT_DOWN_ICON,
      UI_STRINGS.chat.splitDown,
      () =>
        this.stores.createChat({
          from: chatId,
          direction: "column",
          ...(kind === "terminal" ? { kind } : {}),
        }),
    );
    const maximize = action(
      "coloride-maximize-panel",
      MAXIMIZE_ICON,
      UI_STRINGS.chat.maximizePanel,
      () => this.stores.toggleMaximizeChat(chatId),
    );
    // Double click on the title shows the panel alone, like the maximize button.
    header.addEventListener("dblclick", (event) => {
      if ((event.target as HTMLElement).closest("button")) return;
      this.stores.toggleMaximizeChat(chatId);
    });
    const close = action("coloride-close-panel", CLOSE_PANEL_ICON, UI_STRINGS.chat.closePanel, () =>
      this.stores.closeChat(chatId),
    );
    actions.append(splitRight, splitDown, maximize, close);
    header.append(title, actions);
    const messages = doc.createElement("div");
    messages.className = "coloride-chat-cell-messages";
    const logs = doc.createElement("div");
    logs.className = "coloride-chat-cell-logs";
    // A shell shows its pane instead of messages and logs.
    if (kind === "terminal") {
      messages.hidden = true;
      logs.hidden = true;
    }
    el.append(header, messages, logs);
    return {
      el,
      header,
      title,
      titleIcon,
      titleText,
      splitRight,
      splitDown,
      maximize,
      close,
      messages,
      logs,
      kind,
    };
  }
}
