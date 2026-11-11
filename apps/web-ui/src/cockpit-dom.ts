import type { ColorideEditorView } from "@coloride/editor-cm6";
import {
  type ActivityBarSection,
  COLORIDE_DESIGN_TOKENS,
  type CockpitGridMode,
  type CockpitPersonaMode,
  type CockpitStoreBundle,
} from "./stores.js";
import { VirtualChatMessageListRenderer, VirtualFileTreeRenderer } from "./virtualizer.js";

export interface CockpitDomControllerOptions {
  readonly rootContainer: HTMLElement;
  readonly stores: CockpitStoreBundle;
  readonly editorView: ColorideEditorView;
}

const ACTIVITY_ITEMS: readonly {
  readonly section: ActivityBarSection;
  readonly icon: string;
  readonly labelFr: string;
  readonly shortcut: string;
}[] = [
  { section: "sessions", icon: "💬", labelFr: "Sessions de Chat", shortcut: "Cmd/Ctrl+1" },
  { section: "files", icon: "📁", labelFr: "Explorateur de fichiers", shortcut: "Cmd/Ctrl+2" },
  { section: "search", icon: "🔍", labelFr: "Recherche globale", shortcut: "Cmd/Ctrl+3" },
  { section: "git", icon: "🌿", labelFr: "Git & Checkpoints", shortcut: "Cmd/Ctrl+4" },
  { section: "debug", icon: "🐛", labelFr: "Debug & Tests", shortcut: "Cmd/Ctrl+5" },
  { section: "mcp", icon: "🔌", labelFr: "Connecteurs MCP / Modèles", shortcut: "Cmd/Ctrl+6" },
];

const PERSONA_OPTIONS: readonly {
  readonly mode: CockpitPersonaMode;
  readonly labelFr: string;
}[] = [
  { mode: "Create", labelFr: "Créer" },
  { mode: "Learn", labelFr: "Apprendre" },
  { mode: "Develop", labelFr: "Développer" },
  { mode: "Infrastructure", labelFr: "Infrastructure" },
  { mode: "Data", labelFr: "Données" },
];

const GRID_MODES: readonly CockpitGridMode[] = [1, 2, 4, 8];

/**
 * 4-Zone Multi-Chat Cockpit DOM Controller enforcing:
 * - Zone 1 (`48px` Activity Bar) with keyboard navigation (`Cmd/Ctrl+1..6`, arrow keys).
 * - Zone 2 (`240px - 320px` Dynamic Sidebar) with virtualized session badges & >50,000-node file tree.
 * - Zone 3 (`1fr` Multi-Chat Grid `1 | 2 | 4 | 8`) with `2px` Coloride state borders, geometric icons, and virtualized messages.
 * - Zone 4 (`380px - 50%` Contextual Inspector `[ 👁 Preview | 💻 Code & Diff ]`) hosting the singleton `ColorideEditorView`
 *   in a dedicated permanent DOM container that is NEVER unmounted or re-rendered when Zone 2 or Zone 3 updates.
 */
export class CockpitDomController {
  private readonly rootContainer: HTMLElement;
  private readonly stores: CockpitStoreBundle;
  private readonly editorView: ColorideEditorView;
  private readonly fileTreeVirtualizer = new VirtualFileTreeRenderer();
  private readonly messageVirtualizer = new VirtualChatMessageListRenderer();
  private readonly unsubscribers: Array<() => void> = [];

  private cockpitShellEl!: HTMLElement;
  private zone1El!: HTMLElement;
  private zone2El!: HTMLElement;
  private zone2SessionsEl!: HTMLElement;
  private zone2FileTreeEl!: HTMLElement;
  private zone3El!: HTMLElement;
  private zone3HeaderEl!: HTMLElement;
  private zone3GridEl!: HTMLElement;
  private zone4El!: HTMLElement;
  private zone4HeaderEl!: HTMLElement;
  private zone4PreviewHostEl!: HTMLElement;
  private zone4EditorHostEl!: HTMLElement;
  private zone4RenderCount = 0;

  constructor(options: CockpitDomControllerOptions) {
    this.rootContainer = options.rootContainer;
    this.stores = options.stores;
    this.editorView = options.editorView;

    this.buildStaticSkeleton();
    this.renderZone1();
    this.renderZone2();
    this.renderZone3();
    this.renderZone4HeaderAndVisibility();

    // Mount the singleton CodeMirror 6 instance once into the permanent Zone 4 editor host container
    this.editorView.mount(this.zone4EditorHostEl);

    this.unsubscribers.push(
      this.stores.zone1.subscribe(() => {
        this.renderZone1();
        this.renderZone2();
      }),
      this.stores.zone2.subscribe(() => {
        this.renderZone2();
      }),
      this.stores.zone3.subscribe(() => {
        this.renderZone3();
      }),
      this.stores.zone4.subscribe((next, prev) => {
        this.zone4RenderCount += 1;
        this.renderZone4HeaderAndVisibility();
        if (next.activeDocumentId !== prev.activeDocumentId) {
          const targetChat = this.stores.zone3
            .getState()
            .chats.find((c) => c.chatId === next.syncedChatId);
          const nextContent =
            targetChat?.targetDocumentContent ?? this.editorView.getDocumentText();
          this.editorView.switchDocument(next.activeDocumentId, nextContent, [
            {
              fromLine: 1,
              toLine: 1,
              state: next.activeValidationState,
              snapshotHash: `sync-${next.syncedChatId}`,
            },
          ]);
        }
      }),
    );
  }

  getZoneElements(): {
    readonly shell: HTMLElement;
    readonly zone1: HTMLElement;
    readonly zone2: HTMLElement;
    readonly zone3: HTMLElement;
    readonly zone4: HTMLElement;
    readonly zone4EditorHost: HTMLElement;
  } {
    return {
      shell: this.cockpitShellEl,
      zone1: this.zone1El,
      zone2: this.zone2El,
      zone3: this.zone3El,
      zone4: this.zone4El,
      zone4EditorHost: this.zone4EditorHostEl,
    };
  }

  getZone4RenderCount(): number {
    return this.zone4RenderCount;
  }

  scrollFileTree(scrollTopPx: number, viewportHeightPx = 600): void {
    this.stores.zone2.setState((prev) => ({
      ...prev,
      fileTreeScrollTop: scrollTopPx,
      fileTreeViewportHeight: viewportHeightPx,
    }));
  }

  destroy(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers.length = 0;
  }

  private buildStaticSkeleton(): void {
    const doc = this.rootContainer.ownerDocument;
    this.rootContainer.innerHTML = "";

    this.cockpitShellEl = doc.createElement("div");
    this.cockpitShellEl.className = "coloride-cockpit-shell";
    this.cockpitShellEl.setAttribute("role", "application");
    this.cockpitShellEl.setAttribute("aria-label", "Coloride 4-Zone Multi-Chat Cockpit");
    this.cockpitShellEl.style.display = "grid";
    this.cockpitShellEl.style.gridTemplateColumns =
      "48px minmax(240px, 320px) minmax(0, 1fr) minmax(380px, 50%)";
    this.cockpitShellEl.style.width = "100%";
    this.cockpitShellEl.style.height = "100vh";
    this.cockpitShellEl.style.overflow = "hidden";

    this.cockpitShellEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (this.stores.handleActivityBarShortcut(event.key, event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        return;
      }
      if (event.altKey && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
        const chats = this.stores.zone3.getState().chats;
        const activeId = this.stores.zone3.getState().activeChatId;
        const idx = chats.findIndex((c) => c.chatId === activeId);
        if (idx >= 0 && chats.length > 1) {
          const delta = event.key === "ArrowRight" ? 1 : -1;
          const nextIdx = (idx + delta + chats.length) % chats.length;
          const nextChat = chats[nextIdx];
          if (nextChat) {
            this.stores.selectChat(nextChat.chatId);
            event.preventDefault();
          }
        }
      }
    });

    // Zone 1: Activity Bar (48px fixed)
    this.zone1El = doc.createElement("nav");
    this.zone1El.className = "coloride-zone-1-activity-bar";
    this.zone1El.setAttribute("aria-label", "Zone 1 — Activity Bar");
    this.zone1El.style.width = "48px";
    this.zone1El.style.minWidth = "48px";

    // Zone 2: Dynamic Sidebar (Virtualized Sessions & File Tree)
    this.zone2El = doc.createElement("aside");
    this.zone2El.className = "coloride-zone-2-sidebar";
    this.zone2El.setAttribute("aria-label", "Zone 2 — Dynamic Sidebar");
    this.zone2El.style.minWidth = "0";
    this.zone2El.style.overflow = "auto";

    this.zone2SessionsEl = doc.createElement("div");
    this.zone2SessionsEl.className = "coloride-zone-2-sessions";
    this.zone2FileTreeEl = doc.createElement("div");
    this.zone2FileTreeEl.className = "coloride-zone-2-file-tree";
    this.zone2El.appendChild(this.zone2SessionsEl);
    this.zone2El.appendChild(this.zone2FileTreeEl);

    // Zone 3: Center Multi-Chat Grid (1 | 2 | 4 | 8)
    this.zone3El = doc.createElement("main");
    this.zone3El.className = "coloride-zone-3-multichat";
    this.zone3El.setAttribute("aria-label", "Zone 3 — Multi-Chat Grid");
    this.zone3El.style.minWidth = "0";
    this.zone3El.style.overflow = "hidden";

    this.zone3HeaderEl = doc.createElement("header");
    this.zone3HeaderEl.className = "coloride-zone-3-header";
    this.zone3GridEl = doc.createElement("section");
    this.zone3GridEl.className = "coloride-zone-3-grid";
    this.zone3El.appendChild(this.zone3HeaderEl);
    this.zone3El.appendChild(this.zone3GridEl);

    // Zone 4: Right Contextual Inspector ([ 👁 Preview | 💻 Code & Diff ])
    this.zone4El = doc.createElement("section");
    this.zone4El.className = "coloride-zone-4-inspector";
    this.zone4El.setAttribute("aria-label", "Zone 4 — Contextual Inspector");
    this.zone4El.style.minWidth = "0";
    this.zone4El.style.overflow = "hidden";

    this.zone4HeaderEl = doc.createElement("header");
    this.zone4HeaderEl.className = "coloride-zone-4-header";

    this.zone4PreviewHostEl = doc.createElement("div");
    this.zone4PreviewHostEl.className = "coloride-zone-4-preview-host";

    this.zone4EditorHostEl = doc.createElement("div");
    this.zone4EditorHostEl.className = "coloride-zone-4-editor-host";
    this.zone4EditorHostEl.dataset.isolatedCm6Container = "true";

    this.zone4El.appendChild(this.zone4HeaderEl);
    this.zone4El.appendChild(this.zone4PreviewHostEl);
    this.zone4El.appendChild(this.zone4EditorHostEl);

    this.cockpitShellEl.appendChild(this.zone1El);
    this.cockpitShellEl.appendChild(this.zone2El);
    this.cockpitShellEl.appendChild(this.zone3El);
    this.cockpitShellEl.appendChild(this.zone4El);

    this.rootContainer.appendChild(this.cockpitShellEl);
  }

  private renderZone1(): void {
    const doc = this.zone1El.ownerDocument;
    const z1 = this.stores.zone1.getState();

    this.cockpitShellEl.dataset.uiZoomPercent = String(z1.uiZoomPercent);
    this.cockpitShellEl.dataset.activePersona = z1.activePersona;
    this.cockpitShellEl.style.fontSize = `${(z1.uiZoomPercent / 100).toFixed(2)}rem`;
    this.cockpitShellEl.style.gridTemplateColumns = z1.sidebarOpen
      ? "48px minmax(200px, 280px) minmax(0, 1fr) minmax(300px, 45%)"
      : "48px 0px minmax(0, 1fr) minmax(300px, 45%)";

    this.zone1El.innerHTML = "";

    for (const item of ACTIVITY_ITEMS) {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "coloride-activity-btn";
      btn.dataset.section = item.section;
      btn.setAttribute("aria-label", `${item.labelFr} (${item.shortcut})`);
      btn.setAttribute("aria-pressed", z1.activeSection === item.section ? "true" : "false");
      btn.textContent = item.icon;
      btn.addEventListener("click", () => {
        this.stores.setActivitySection(item.section);
      });
      this.zone1El.appendChild(btn);
    }

    // Explicit Persona Selector (always keeps File Tree accessible in every persona)
    const personaSelect = doc.createElement("select");
    personaSelect.className = "coloride-persona-selector";
    personaSelect.setAttribute("aria-label", "Sélecteur de profil / persona du workspace");
    for (const opt of PERSONA_OPTIONS) {
      const optionEl = doc.createElement("option");
      optionEl.value = opt.mode;
      optionEl.textContent = opt.labelFr;
      optionEl.selected = z1.activePersona === opt.mode;
      personaSelect.appendChild(optionEl);
    }
    personaSelect.addEventListener("change", () => {
      this.stores.setPersona(personaSelect.value as CockpitPersonaMode);
    });
    this.zone1El.appendChild(personaSelect);
  }

  private renderZone2(): void {
    const doc = this.zone2El.ownerDocument;
    const z1 = this.stores.zone1.getState();
    const z2 = this.stores.zone2.getState();

    this.zone2El.dataset.sidebarOpen = String(z1.sidebarOpen);
    this.zone2El.dataset.fileTreeAccessible = String(z1.fileTreeAccessible);
    this.zone2El.dataset.activeSection = z1.activeSection;

    const showSessions = z1.activeSection === "sessions";
    const showFiles = z1.activeSection === "files";
    this.zone2SessionsEl.hidden = !showSessions;
    this.zone2SessionsEl.style.display = showSessions ? "block" : "none";
    this.zone2FileTreeEl.hidden = !showFiles;
    this.zone2FileTreeEl.style.display = showFiles ? "block" : "none";

    // Render session badges (visible on 1st tab of Z1: "sessions")
    this.zone2SessionsEl.innerHTML = "";
    this.zone2SessionsEl.setAttribute("role", "list");
    this.zone2SessionsEl.setAttribute("aria-label", "Sessions de Chat");
    for (const session of z2.sessions) {
      const token = COLORIDE_DESIGN_TOKENS[session.validationState];
      const item = doc.createElement("button");
      item.type = "button";
      item.className = "coloride-sidebar-session-item";
      item.setAttribute("role", "listitem");
      item.dataset.chatId = session.chatId;
      item.dataset.validationState = session.validationState;
      item.setAttribute("aria-label", `${session.title} — ${token.labelFr}`);
      item.style.borderLeft = `3px solid ${token.darkBorder}`;
      item.textContent = `${token.icon} ${session.title} (${session.modelName})`;
      item.addEventListener("click", () => {
        this.stores.selectChat(session.chatId);
      });
      this.zone2SessionsEl.appendChild(item);
    }

    // Virtualize the file tree (visible on 2nd tab of Z1: "files") so > 50,000 files render in O(1) DOM nodes
    this.fileTreeVirtualizer.renderInto(
      this.zone2FileTreeEl,
      z2.fileTree,
      z2.fileTreeScrollTop,
      z2.fileTreeViewportHeight,
      z2.focusedFileIndex,
    );
  }

  private renderZone3(): void {
    const doc = this.zone3El.ownerDocument;
    const z3 = this.stores.zone3.getState();

    // Header: chat tabs + Grid selector 1 | 2 | 4 | 8
    this.zone3HeaderEl.innerHTML = "";
    const tabBar = doc.createElement("div");
    tabBar.className = "coloride-chat-tab-bar";
    tabBar.setAttribute("role", "tablist");

    for (const chat of z3.chats) {
      const token = COLORIDE_DESIGN_TOKENS[chat.validationState];
      const tabBtn = doc.createElement("button");
      tabBtn.type = "button";
      tabBtn.className = "coloride-chat-tab";
      tabBtn.setAttribute("role", "tab");
      tabBtn.dataset.chatId = chat.chatId;
      tabBtn.setAttribute("aria-selected", z3.activeChatId === chat.chatId ? "true" : "false");
      tabBtn.setAttribute("aria-label", `${chat.title} — ${token.labelFr}`);
      tabBtn.textContent = `${token.icon} ${chat.title}`;
      tabBtn.addEventListener("click", () => {
        this.stores.selectChat(chat.chatId);
      });
      tabBar.appendChild(tabBtn);
    }

    const gridSelector = doc.createElement("div");
    gridSelector.className = "coloride-grid-mode-selector";
    gridSelector.setAttribute("role", "group");
    gridSelector.setAttribute("aria-label", "Disposition Grille Multi-Chat (1 | 2 | 4 | 8)");

    for (const mode of GRID_MODES) {
      const modeBtn = doc.createElement("button");
      modeBtn.type = "button";
      modeBtn.className = "coloride-grid-mode-btn";
      modeBtn.dataset.gridMode = String(mode);
      modeBtn.setAttribute("aria-pressed", z3.gridMode === mode ? "true" : "false");
      modeBtn.textContent = `Grille ${mode}`;
      modeBtn.addEventListener("click", () => {
        this.stores.setGridMode(mode);
      });
      gridSelector.appendChild(modeBtn);
    }

    this.zone3HeaderEl.appendChild(tabBar);
    this.zone3HeaderEl.appendChild(gridSelector);

    // Multi-Chat Grid cells (up to `gridMode` visible cells)
    this.zone3GridEl.innerHTML = "";
    this.zone3GridEl.dataset.gridMode = String(z3.gridMode);
    this.zone3GridEl.style.display = "grid";
    const columns = z3.gridMode === 1 ? 1 : z3.gridMode === 2 ? 2 : 2;
    this.zone3GridEl.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;

    const visibleChats = z3.chats.slice(0, z3.gridMode);
    for (const chat of visibleChats) {
      const token = COLORIDE_DESIGN_TOKENS[chat.validationState];
      const cell = doc.createElement("section");
      cell.className = "coloride-chat-cell";
      cell.dataset.chatId = chat.chatId;
      cell.dataset.validationState = chat.validationState;
      cell.dataset.active = String(z3.activeChatId === chat.chatId);
      cell.setAttribute("aria-label", `Cellule ${chat.title} (${token.labelFr})`);
      // Exact 2px Coloride state border from DESIGN_SYSTEM.md §2
      cell.style.border = `2px solid ${token.darkBorder}`;
      cell.style.backgroundColor = token.darkBg;
      cell.style.color = token.darkText;

      const cellHeader = doc.createElement("div");
      cellHeader.className = "coloride-chat-cell-header";
      cellHeader.textContent = `${token.icon} ${chat.title} [${chat.modelName}] — ${token.labelFr}`;
      cellHeader.addEventListener("click", () => {
        this.stores.selectChat(chat.chatId);
      });

      const messagesContainer = doc.createElement("div");
      messagesContainer.className = "coloride-chat-cell-messages";
      const chatMessages = z3.messagesByChatId[chat.chatId] ?? [];
      this.messageVirtualizer.renderInto(messagesContainer, chatMessages, 0, 400);

      const logsContainer = doc.createElement("div");
      logsContainer.className = "coloride-chat-cell-logs";
      const logs = z3.terminalLogsByChatId[chat.chatId] ?? [];
      logsContainer.dataset.logCount = String(logs.length);
      logsContainer.textContent = logs.slice(-5).join("\n");

      cell.appendChild(cellHeader);
      cell.appendChild(messagesContainer);
      cell.appendChild(logsContainer);
      this.zone3GridEl.appendChild(cell);
    }
  }

  private renderZone4HeaderAndVisibility(): void {
    const doc = this.zone4El.ownerDocument;
    const z4 = this.stores.zone4.getState();
    const token = COLORIDE_DESIGN_TOKENS[z4.activeValidationState];

    this.zone4El.dataset.syncedChatId = z4.syncedChatId;
    this.zone4El.dataset.activeDocumentId = z4.activeDocumentId;
    this.zone4El.dataset.activeInspectorTab = z4.activeInspectorTab;

    this.zone4HeaderEl.innerHTML = "";

    const fileBadge = doc.createElement("span");
    fileBadge.className = "coloride-inspector-doc-badge";
    fileBadge.setAttribute("aria-label", `${z4.activeDocumentId} — ${token.labelFr}`);
    fileBadge.textContent = `${token.icon} ${z4.activeDocumentId} (${token.labelFr})`;

    const previewBtn = doc.createElement("button");
    previewBtn.type = "button";
    previewBtn.dataset.inspectorTab = "preview";
    previewBtn.setAttribute("aria-pressed", z4.activeInspectorTab === "preview" ? "true" : "false");
    previewBtn.textContent = "👁 Preview";
    previewBtn.addEventListener("click", () => {
      this.stores.setInspectorTab("preview");
    });

    const codeDiffBtn = doc.createElement("button");
    codeDiffBtn.type = "button";
    codeDiffBtn.dataset.inspectorTab = "code-diff";
    codeDiffBtn.setAttribute(
      "aria-pressed",
      z4.activeInspectorTab === "code-diff" ? "true" : "false",
    );
    codeDiffBtn.textContent = "💻 Code & Diff";
    codeDiffBtn.addEventListener("click", () => {
      this.stores.setInspectorTab("code-diff");
    });

    this.zone4HeaderEl.appendChild(fileBadge);
    this.zone4HeaderEl.appendChild(previewBtn);
    this.zone4HeaderEl.appendChild(codeDiffBtn);

    // Toggle visibility WITHOUT ever unmounting `zone4EditorHostEl` or `ColorideEditorView`
    if (z4.activeInspectorTab === "preview") {
      this.zone4PreviewHostEl.style.display = "block";
      this.zone4PreviewHostEl.textContent = `Preview: ${z4.previewUrl}`;
      this.zone4EditorHostEl.style.display = "none";
    } else {
      this.zone4PreviewHostEl.style.display = "none";
      this.zone4EditorHostEl.style.display = "block";
    }
  }
}
