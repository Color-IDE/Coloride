import { reconcile } from "../dom-utils.js";
import {
  type LayoutNode,
  MIN_PANEL_SIZE_PX,
  minExtentPx,
  nodeAt,
  panel,
  panelIds,
  reconcileLayout,
  resizeBoundary,
} from "../layout-tree.js";
import { PLUS_ICON } from "../sidebar/icons.js";
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
  CLOSE_PANEL_ICON,
  MAXIMIZE_ICON,
  RESTORE_ICON,
  SPLIT_DOWN_ICON,
  SPLIT_RIGHT_ICON,
} from "./panel-icons.js";

/** A bar closer than this to another one of the same orientation is pulled onto it. */
const SNAP_DISTANCE_PX = 8;

interface ChatCellNodes {
  readonly el: HTMLElement;
  readonly header: HTMLElement;
  readonly title: HTMLElement;
  readonly splitRight: HTMLButtonElement;
  readonly splitDown: HTMLButtonElement;
  readonly maximize: HTMLButtonElement;
  readonly close: HTMLButtonElement;
  readonly messages: HTMLElement;
  readonly logs: HTMLElement;
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

    this.addButton = this.createAddButton(doc, "coloride-header-tab-add", "");
    this.addButton.setAttribute("aria-label", UI_STRINGS.chat.newSession);
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
    this.resizeObserver?.disconnect();
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
          label: chat.title,
          title: `${chat.title} · ${chat.modelName}`,
          icon: { text: token.icon },
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
        el.append(this.createSeparator(node.direction, path, boundary));
      }
    }
    el.classList.toggle("coloride-layout-root", isRoot);
    applySizes(node, el, isRoot);
    return el;
  }

  /**
   * The draggable bar between child `boundary` and the next one of the split at `path`. It is
   * absolutely positioned over the boundary (see `applySizes`), so it takes no room.
   */
  private createSeparator(
    direction: "row" | "column",
    path: readonly number[],
    boundary: number,
  ): HTMLElement {
    const doc = this.grid.ownerDocument;
    const bar = doc.createElement("div");
    bar.className = "coloride-layout-handle";
    bar.setAttribute("role", "separator");
    // A row of panels is split by vertical bars, and the other way round.
    bar.setAttribute("aria-orientation", direction === "row" ? "vertical" : "horizontal");
    bar.setAttribute("aria-label", UI_STRINGS.chat.resizePanels);
    bar.tabIndex = 0;

    /** What the drag works with, measured when it starts. */
    const measure = () => {
      const layout = this.shownLayout;
      const split = layout ? nodeAt(layout, path) : null;
      const container = bar.parentElement;
      if (!layout || !split || !container) return null;
      const rect = container.getBoundingClientRect();
      const extent = direction === "row" ? rect.width : rect.height;
      if (!(extent > 0)) return null;
      const side = (index: number) => {
        const child = split.children[index];
        return child ? minExtentPx(child, direction, MIN_PANEL_SIZE_PX) / extent : 0;
      };
      return {
        layout,
        extent,
        min: { before: side(boundary), after: side(boundary + 1) },
        sizes: split.sizes,
      };
    };
    const save = (layout: LayoutNode | null) => {
      if (layout && this.shownGroupId) this.stores.setWorkGroupLayout(this.shownGroupId, layout);
    };

    let drag: {
      start: number;
      /** Where the bar is on the page when the drag starts, and where the other parallel bars are. */
      center: number;
      targets: readonly number[];
      measured: NonNullable<ReturnType<typeof measure>>;
      layout: LayoutNode | null;
    } | null = null;
    bar.addEventListener("pointerdown", (event) => {
      const measured = measure();
      if (!measured) return;
      event.preventDefault();
      bar.setPointerCapture?.((event as PointerEvent).pointerId);
      // Where this bar and every other bar of the same orientation are on the page. The bars
      // inside this split move with the drag, so they are no use as targets.
      const centerOf = (el: Element) => {
        const rect = el.getBoundingClientRect();
        return direction === "row" ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
      };
      const orientation = bar.getAttribute("aria-orientation");
      const targets = Array.from(this.grid.querySelectorAll(".coloride-layout-handle"))
        .filter(
          (other) =>
            other !== bar &&
            other.getAttribute("aria-orientation") === orientation &&
            !bar.parentElement?.contains(other),
        )
        .map(centerOf);
      drag = {
        start: direction === "row" ? event.clientX : event.clientY,
        center: centerOf(bar),
        targets,
        measured,
        layout: null,
      };
      this.grid.dataset.resizing = direction;
    });
    bar.addEventListener("pointermove", (event) => {
      if (!drag || !this.layoutRoot) return;
      const position = direction === "row" ? event.clientX : event.clientY;
      let movedPx = position - drag.start;
      // Line up with the nearest other bar when close to it (Alt turns this off), so panels that
      // sit side by side end up level instead of a few pixels apart.
      let snapped = false;
      if (!event.altKey) {
        const proposed = drag.center + movedPx;
        let nearest: number | null = null;
        for (const target of drag.targets) {
          const distance = Math.abs(target - proposed);
          if (
            distance <= SNAP_DISTANCE_PX &&
            (nearest === null || distance < Math.abs(nearest - proposed))
          )
            nearest = target;
        }
        if (nearest !== null) {
          movedPx = nearest - drag.center;
          snapped = true;
        }
      }
      bar.dataset.snapped = String(snapped);
      const next = resizeBoundary(
        drag.measured.layout,
        path,
        boundary,
        movedPx / drag.measured.extent,
        drag.measured.min,
      );
      drag.layout = next;
      // Live, straight on the DOM: the store is only written when the drag ends.
      if (next) applySizes(next, this.layoutRoot, true);
    });
    const finish = () => {
      if (!drag) return;
      const { layout, measured } = drag;
      drag = null;
      delete bar.dataset.snapped;
      delete this.grid.dataset.resizing;
      if (layout && layout !== measured.layout) save(layout);
    };
    bar.addEventListener("pointerup", finish);
    bar.addEventListener("pointercancel", finish);

    // Keyboard: arrows move the bar (Shift for larger steps); a double click evens out the
    // two neighbours.
    bar.addEventListener("keydown", (event) => {
      const forward = direction === "row" ? "ArrowRight" : "ArrowDown";
      const backward = direction === "row" ? "ArrowLeft" : "ArrowUp";
      if (event.key !== forward && event.key !== backward) return;
      const measured = measure();
      if (!measured) return;
      event.preventDefault();
      const step = event.shiftKey ? 0.1 : 0.02;
      save(
        resizeBoundary(
          measured.layout,
          path,
          boundary,
          event.key === forward ? step : -step,
          measured.min,
        ),
      );
    });
    bar.addEventListener("dblclick", () => {
      const measured = measure();
      const before = measured?.sizes[boundary];
      const after = measured?.sizes[boundary + 1];
      if (!measured || before === undefined || after === undefined) return;
      save(resizeBoundary(measured.layout, path, boundary, (after - before) / 2, measured.min));
    });
    return bar;
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
    el.append(header, messages, logs);
    return { el, header, title, splitRight, splitDown, maximize, close, messages, logs };
  }
}

/** Identifies the structure of a layout (panels and split directions) but not the sizes. */
function layoutShape(node: LayoutNode): string {
  return node.kind === "panel"
    ? node.id
    : `${node.direction === "row" ? "r" : "c"}(${node.children.map(layoutShape).join(",")})`;
}

/**
 * Sizes every child of a split with `flex-grow` proportional to its share, and puts each
 * separator over the boundary it moves (the separators are the elements after the children).
 */
function applySizes(node: LayoutNode, el: HTMLElement, isRoot: boolean): void {
  if (isRoot) el.style.flex = "";
  if (node.kind === "panel") return;
  el.dataset.direction = node.direction;
  const edge = node.direction === "row" ? "left" : "top";
  let offset = 0;
  node.children.forEach((child, index) => {
    const size = node.sizes[index] ?? 0;
    const childEl = el.children[index] as HTMLElement | undefined;
    if (childEl) {
      childEl.style.flex = `${size} 1 0px`;
      applySizes(child, childEl, false);
    }
    offset += size;
    const bar = el.children[node.children.length + index] as HTMLElement | undefined;
    if (bar?.classList.contains("coloride-layout-handle")) bar.style[edge] = `${offset * 100}%`;
  });
}
