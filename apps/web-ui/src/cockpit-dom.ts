import type { ColorideEditorView } from "@coloride/editor-cm6";
import { OnboardingModalController, createInitialOnboardingState } from "./onboarding-modal.js";
import { WorkspaceSidebar } from "./sidebar/workspace-sidebar.js";
import {
  type ActivityBarSection,
  COLORIDE_DESIGN_TOKENS,
  type CockpitPersonaMode,
  type CockpitStoreBundle,
} from "./stores.js";
import {
  ACTIVITY_BAR_SVG_ICONS,
  type StatefulActivityIcon,
  injectCockpitThemeStyles,
} from "./theme/index.js";
import { VirtualChatMessageListRenderer, VirtualFileTreeRenderer } from "./virtualizer.js";

export interface CockpitDomControllerOptions {
  readonly rootContainer: HTMLElement;
  readonly stores: CockpitStoreBundle;
  readonly editorView: ColorideEditorView;
  readonly onboardingController?: OnboardingModalController;
  readonly openWorkspace?: () => Promise<
    readonly import("./stores.js").CockpitFileTreeNode[] | null
  >;
  readonly readWorkspaceFile?: (path: string) => Promise<string>;
  readonly searchWorkspace?: (
    query: string,
  ) => Promise<readonly import("./stores.js").CockpitSearchResultItem[]>;
  readonly analyzeDocument?: (
    documentId: string,
    sessionGeneration: number,
  ) => Promise<{
    readonly symbols: readonly import("./stores.js").CockpitAstSymbolItem[];
    readonly impactedTests: readonly import("./stores.js").CockpitImpactedTestItem[];
  }>;
}

const ACTIVITY_ITEMS: readonly {
  readonly section: ActivityBarSection;
  readonly iconSvg: StatefulActivityIcon;
  readonly labelFr: string;
  readonly shortcut: string;
  readonly dividerBefore?: boolean;
}[] = [
  {
    section: "sessions",
    iconSvg: ACTIVITY_BAR_SVG_ICONS.sessions,
    labelFr: "Sessions de Chat",
    shortcut: "Cmd/Ctrl+1",
  },
  {
    section: "files",
    iconSvg: ACTIVITY_BAR_SVG_ICONS.files,
    labelFr: "Explorateur de fichiers",
    shortcut: "Cmd/Ctrl+2",
  },
  {
    section: "search",
    iconSvg: ACTIVITY_BAR_SVG_ICONS.search,
    labelFr: "Recherche globale",
    shortcut: "Cmd/Ctrl+3",
  },
  {
    section: "debug",
    iconSvg: ACTIVITY_BAR_SVG_ICONS.debug,
    labelFr: "Debug & Tests",
    shortcut: "Cmd/Ctrl+5",
  },
  {
    section: "git",
    iconSvg: ACTIVITY_BAR_SVG_ICONS.git,
    labelFr: "Git & Checkpoints",
    shortcut: "Cmd/Ctrl+4",
    dividerBefore: true,
  },
  {
    section: "mcp",
    iconSvg: ACTIVITY_BAR_SVG_ICONS.mcp,
    labelFr: "Connecteurs MCP / Modèles",
    shortcut: "Cmd/Ctrl+6",
  },
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
  private readonly onboardingController: OnboardingModalController;
  private readonly openWorkspace?: CockpitDomControllerOptions["openWorkspace"];
  private readonly readWorkspaceFile?: CockpitDomControllerOptions["readWorkspaceFile"];
  private readonly searchWorkspace?: CockpitDomControllerOptions["searchWorkspace"];
  private readonly analyzeDocument?: CockpitDomControllerOptions["analyzeDocument"];
  private readonly ownsOnboardingController: boolean;
  private readonly fileTreeVirtualizer = new VirtualFileTreeRenderer();
  private readonly messageVirtualizer = new VirtualChatMessageListRenderer();
  private readonly unsubscribers: Array<() => void> = [];

  private cockpitShellEl!: HTMLElement;
  private outerTopBarEl!: HTMLElement;
  private zone3HeaderEl!: HTMLElement;
  private zone4HeaderEl!: HTMLElement;
  private zone1El!: HTMLElement;
  private zone2El!: HTMLElement;
  private zone2ProjectControlsEl!: HTMLElement;
  private zone2SessionsEl!: HTMLElement;
  private zone2FileTreeEl!: HTMLElement;
  private zone2SearchEl!: HTMLElement;
  private zone2DebugEl!: HTMLElement;
  private zone2McpEl!: HTMLElement;
  private zone3El!: HTMLElement;
  private zone3GridEl!: HTMLElement;
  private zone4El!: HTMLElement;
  private zone4PreviewHostEl!: HTMLElement;
  private zone4EditorHostEl!: HTMLElement;
  private zone4RenderCount = 0;
  private analysisRequestSequence = 0;
  private readonly workspaceSidebar: WorkspaceSidebar;

  constructor(options: CockpitDomControllerOptions) {
    this.rootContainer = options.rootContainer;
    this.stores = options.stores;
    this.editorView = options.editorView;
    this.openWorkspace = options.openWorkspace;
    this.readWorkspaceFile = options.readWorkspaceFile;
    this.searchWorkspace = options.searchWorkspace;
    this.analyzeDocument = options.analyzeDocument;
    this.ownsOnboardingController = !options.onboardingController;
    this.onboardingController =
      options.onboardingController ??
      new OnboardingModalController(this.editorView, {
        ...createInitialOnboardingState(),
        modalOpen: false,
      });

    // Seed initial editor content into the store's UnsavedBufferOverlay
    this.stores.updateInMemoryDocumentContent(
      this.editorView.getStoreSnapshot().documentId,
      this.editorView.getDocumentText(),
      false,
    );

    this.buildStaticSkeleton();
    this.workspaceSidebar = new WorkspaceSidebar({
      controlsHost: this.zone2ProjectControlsEl,
      treeHost: this.zone2SessionsEl,
      stores: this.stores,
      ...(this.openWorkspace ? { openWorkspace: this.openWorkspace } : {}),
    });
    this.onboardingController.mountModal(this.cockpitShellEl);
    this.renderZone1();
    this.renderZone2();
    this.renderZone3();
    this.renderZone4HeaderAndVisibility();

    // Mount the singleton CodeMirror 6 instance once into the permanent Zone 4 editor host container
    this.editorView.mount(this.zone4EditorHostEl);

    this.unsubscribers.push(
      this.stores.navigation.subscribeSelector(
        (state) =>
          [
            state.activeGroupId,
            state.groups.map((group) => `${group.id}:${group.title}`).join("|"),
          ] as const,
        () => this.renderZone3(),
        (a, b) => a[0] === b[0] && a[1] === b[1],
      ),
      this.stores.zone1.subscribe(() => {
        this.renderZone1();
        this.renderZone2();
      }),
      this.stores.zone2.subscribe(() => {
        this.renderZone2();
      }),
      this.stores.zone3.subscribe(() => this.renderZone3()),
      this.stores.zone4.subscribe((next, prev) => {
        this.zone4RenderCount += 1;
        this.renderZone4HeaderAndVisibility();
        if (next.activeDocumentId !== prev.activeDocumentId) {
          const storedContent = this.stores.getDocumentContent(next.activeDocumentId);
          const targetChat = this.stores.zone3
            .getState()
            .chats.find((c) => c.chatId === next.syncedChatId);
          const nextContent =
            storedContent ?? targetChat?.targetDocumentContent ?? this.editorView.getDocumentText();
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
      this.editorView.subscribe(() => {
        const snap = this.editorView.getStoreSnapshot();
        const hasUnsaved = Boolean(snap.lastAckSnapshot?.has_unsaved_changes);
        this.stores.updateInMemoryDocumentContent(
          snap.documentId,
          this.editorView.getDocumentText(),
          hasUnsaved,
        );
        this.syncZone4UnsavedIndicatorInPlace(hasUnsaved);
        if (snap.lastIpcError) this.zone4HeaderEl.title = snap.lastIpcError;
        if (snap.lastAckSnapshot) this.requestNativeAnalysis(snap.documentId);
      }),
      this.onboardingController.store.subscribe(() => {
        if (this.stores.zone1.getState().activeSection === "mcp") {
          this.renderZone2();
        }
      }),
    );
  }

  getOnboardingController(): OnboardingModalController {
    return this.onboardingController;
  }

  async saveActiveDocument(): Promise<void> {
    const snap = await this.editorView.requestSave();
    this.stores.markDocumentSaved(snap.document_id);
    this.syncZone4UnsavedIndicatorInPlace(false);
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
    this.workspaceSidebar.destroy();
    if (this.ownsOnboardingController) {
      this.onboardingController.destroy();
    }
  }

  private buildStaticSkeleton(): void {
    const doc = this.rootContainer.ownerDocument;
    injectCockpitThemeStyles(doc);
    this.rootContainer.innerHTML = "";

    // Mount the outer top bar header (outside the card) into `.coloride-macos-titlebar` if present,
    // or create one inside `rootContainer` above `cockpitShellEl`.
    const existingTitlebar = doc.querySelector<HTMLElement>(".coloride-macos-titlebar");
    if (existingTitlebar) {
      this.outerTopBarEl = existingTitlebar;
      this.outerTopBarEl.innerHTML = "";
    } else {
      this.outerTopBarEl = doc.createElement("header");
      this.outerTopBarEl.className = "coloride-macos-titlebar";
      this.rootContainer.appendChild(this.outerTopBarEl);
    }

    this.outerTopBarEl.setAttribute("data-tauri-drag-region", "");

    const topSpacerEl = doc.createElement("div");
    topSpacerEl.className = "coloride-top-header-spacer";
    topSpacerEl.setAttribute("data-tauri-drag-region", "");

    this.zone3HeaderEl = doc.createElement("div");
    this.zone3HeaderEl.className = "coloride-zone-3-header";
    this.zone3HeaderEl.setAttribute("data-tauri-drag-region", "");
    this.zone3HeaderEl.setAttribute("aria-label", "Header Zone 3 — Onglets de Chat");

    this.zone4HeaderEl = doc.createElement("div");
    this.zone4HeaderEl.className = "coloride-zone-4-header";
    this.zone4HeaderEl.setAttribute("data-tauri-drag-region", "");
    this.zone4HeaderEl.setAttribute("aria-label", "Header Zone 4 — Onglets de l'Inspecteur");

    this.outerTopBarEl.appendChild(topSpacerEl);
    this.outerTopBarEl.appendChild(this.zone3HeaderEl);
    this.outerTopBarEl.appendChild(this.zone4HeaderEl);

    this.cockpitShellEl = doc.createElement("div");
    this.cockpitShellEl.className = "coloride-cockpit-shell";
    this.cockpitShellEl.setAttribute("role", "application");
    this.cockpitShellEl.setAttribute("aria-label", "Coloride 4-Zone Multi-Chat Cockpit");
    this.cockpitShellEl.style.display = "grid";
    this.cockpitShellEl.style.gridTemplateColumns =
      "48px clamp(200px, 19vw, 280px) minmax(0, 1fr) clamp(300px, 45%, 640px)";
    this.cockpitShellEl.style.width = "100%";
    this.cockpitShellEl.style.height = "100vh";
    this.cockpitShellEl.style.overflow = "hidden";

    this.cockpitShellEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void this.saveActiveDocument().catch((error: unknown) => {
          this.zone4HeaderEl.title = error instanceof Error ? error.message : "Save failed";
        });
        return;
      }
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
    this.zone1El.className =
      "coloride-zone-1-activity-bar bg-nav-rail flex flex-col items-center pt-1.5 pb-2.5 px-1 gap-1.5";
    this.zone1El.setAttribute("aria-label", "Zone 1 — Activity Bar");
    this.zone1El.style.width = "48px";
    this.zone1El.style.minWidth = "48px";

    // Zone 2: Dynamic Sidebar (Virtualized Sessions, File Tree, Search, AST/Debug, MCP/Onboarding)
    this.zone2El = doc.createElement("aside");
    this.zone2El.className =
      "coloride-zone-2-sidebar bg-sidebar border-y border-l border-r-0 border-white/8 rounded-tl-[16px] rounded-bl-[16px] p-2.5 h-full";
    this.zone2El.setAttribute("aria-label", "Zone 2 — Dynamic Sidebar");
    this.zone2El.style.minWidth = "0";
    this.zone2El.style.overflow = "auto";

    this.zone2SessionsEl = doc.createElement("div");
    this.zone2SessionsEl.className = "sidebar-navigation";
    this.zone2FileTreeEl = doc.createElement("div");
    this.zone2FileTreeEl.className = "coloride-zone-2-file-tree";
    this.zone2SearchEl = doc.createElement("div");
    this.zone2SearchEl.className = "coloride-zone-2-search flex flex-col gap-2";
    this.zone2DebugEl = doc.createElement("div");
    this.zone2DebugEl.className = "coloride-zone-2-debug flex flex-col gap-2";
    this.zone2McpEl = doc.createElement("div");
    this.zone2McpEl.className = "coloride-zone-2-mcp flex flex-col gap-2";
    this.zone2ProjectControlsEl = doc.createElement("div");
    this.zone2ProjectControlsEl.className = "sidebar-project-controls";
    this.zone2El.appendChild(this.zone2ProjectControlsEl);
    this.zone2El.appendChild(this.zone2SessionsEl);
    this.zone2El.appendChild(this.zone2FileTreeEl);
    this.zone2El.appendChild(this.zone2SearchEl);
    this.zone2El.appendChild(this.zone2DebugEl);
    this.zone2El.appendChild(this.zone2McpEl);

    // Zone 3: Center Multi-Chat Grid (1 | 2 | 4 | 8)
    this.zone3El = doc.createElement("main");
    this.zone3El.className =
      "coloride-zone-3-multichat bg-main border-t border-b border-l border-white/8 flex flex-col h-full";
    this.zone3El.setAttribute("aria-label", "Zone 3 — Multi-Chat Grid");
    this.zone3El.style.minWidth = "0";
    this.zone3El.style.overflow = "hidden";

    this.zone3GridEl = doc.createElement("section");
    this.zone3GridEl.className = "coloride-zone-3-grid flex-1 p-3.5 gap-3 overflow-auto";
    this.zone3El.appendChild(this.zone3GridEl);

    // Zone 4: Right Contextual Inspector ([ 👁 Preview | 💻 Code & Diff ])
    this.zone4El = doc.createElement("section");
    this.zone4El.className =
      "coloride-zone-4-inspector bg-main border border-white/8 rounded-tr-[16px] rounded-br-[16px] flex flex-col h-full overflow-hidden";
    this.zone4El.setAttribute("aria-label", "Zone 4 — Contextual Inspector");
    this.zone4El.style.minWidth = "0";
    this.zone4El.style.overflow = "hidden";

    this.zone4PreviewHostEl = doc.createElement("div");
    this.zone4PreviewHostEl.className =
      "coloride-zone-4-preview-host flex-1 w-full h-full overflow-auto p-0 bg-main select-text";

    this.zone4EditorHostEl = doc.createElement("div");
    this.zone4EditorHostEl.className =
      "coloride-zone-4-editor-host flex-1 w-full h-full overflow-hidden p-0 bg-main select-text";
    this.zone4EditorHostEl.dataset.isolatedCm6Container = "true";

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
    const gridCols = z1.sidebarOpen
      ? "48px clamp(200px, 19vw, 280px) minmax(0, 1fr) clamp(300px, 45%, 640px)"
      : "48px 0px minmax(0, 1fr) clamp(300px, 45%, 640px)";
    this.cockpitShellEl.style.gridTemplateColumns = gridCols;
    this.outerTopBarEl.style.gridTemplateColumns = gridCols;

    this.zone1El.innerHTML = "";

    for (const item of ACTIVITY_ITEMS) {
      if (item.dividerBefore) {
        const divider = doc.createElement("div");
        divider.className = "coloride-activity-divider";
        divider.setAttribute("role", "separator");
        divider.setAttribute("aria-orientation", "horizontal");
        this.zone1El.appendChild(divider);
      }
      const isActive = z1.activeSection === item.section;
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "coloride-activity-btn flex items-center justify-center";
      btn.dataset.section = item.section;
      btn.setAttribute("aria-label", `${item.labelFr} (${item.shortcut})`);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      btn.innerHTML = isActive ? item.iconSvg.active : item.iconSvg.inactive;
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
    const showSearch = z1.activeSection === "search";
    const showDebug = z1.activeSection === "debug";
    const showMcp = z1.activeSection === "mcp";

    this.zone2ProjectControlsEl.hidden = !showSessions;
    this.zone2ProjectControlsEl.style.display = showSessions ? "flex" : "none";
    this.zone2SessionsEl.hidden = !showSessions;
    this.zone2SessionsEl.style.display = showSessions ? "block" : "none";
    this.zone2FileTreeEl.hidden = !showFiles;
    this.zone2FileTreeEl.style.display = showFiles ? "block" : "none";
    this.zone2SearchEl.hidden = !showSearch;
    this.zone2SearchEl.style.display = showSearch ? "flex" : "none";
    this.zone2DebugEl.hidden = !showDebug;
    this.zone2DebugEl.style.display = showDebug ? "flex" : "none";
    this.zone2McpEl.hidden = !showMcp;
    this.zone2McpEl.style.display = showMcp ? "flex" : "none";

    // Virtualize the file tree (visible on 2nd tab of Z1: "files") so > 50,000 files render in O(1) DOM nodes
    if (z2.fileTree.length === 0 && this.openWorkspace) {
      this.zone2FileTreeEl.innerHTML = "";
      const openButton = doc.createElement("button");
      openButton.type = "button";
      openButton.className = "coloride-open-workspace-btn";
      openButton.textContent = "Open folder";
      openButton.addEventListener("click", () => {
        openButton.disabled = true;
        openButton.textContent = "Opening…";
        void this.openWorkspace?.()
          .then((fileTree) => {
            if (fileTree) this.stores.setFileTree(fileTree);
          })
          .catch((error: unknown) => {
            openButton.textContent =
              error instanceof Error ? error.message : "Unable to open folder";
            openButton.title = openButton.textContent;
          })
          .finally(() => {
            openButton.disabled = false;
            if (openButton.textContent === "Opening…") openButton.textContent = "Open folder";
          });
      });
      this.zone2FileTreeEl.appendChild(openButton);
    } else {
      this.fileTreeVirtualizer.renderInto(
        this.zone2FileTreeEl,
        z2.fileTree,
        z2.fileTreeScrollTop,
        z2.fileTreeViewportHeight,
        z2.focusedFileIndex,
        (node) => {
          if (node.isDirectory) return;
          if (this.readWorkspaceFile) {
            void this.readWorkspaceFile(node.path)
              .then((content) => {
                this.stores.selectFileFromTree(node.path, content);
                this.requestNativeAnalysis(node.path);
              })
              .catch((error: unknown) => {
                this.zone2FileTreeEl.title =
                  error instanceof Error ? error.message : "Unable to read file";
              });
          } else {
            this.stores.selectFileFromTree(node.path);
          }
        },
      );
    }

    if (showSearch) {
      this.renderZone2SearchPanel(doc, z2.searchQuery, z2.searchResults);
    }
    if (showDebug) {
      this.renderZone2DebugPanel(doc, z2.astSymbols, z2.impactedTests);
    }
    if (showMcp) {
      this.renderZone2McpPanel(doc);
    }
  }

  private renderZone2SearchPanel(
    doc: Document,
    searchQuery: string,
    searchResults: readonly import("./stores.js").CockpitSearchResultItem[],
  ): void {
    this.zone2SearchEl.innerHTML = "";
    this.zone2SearchEl.setAttribute("aria-label", "Recherche globale FTS5 (BM25)");

    const input = doc.createElement("input");
    input.type = "search";
    input.className = "coloride-global-search-input";
    input.placeholder = "Rechercher (FTS5 BM25 + buffers non sauvegardés)…";
    input.value = searchQuery;
    input.setAttribute("aria-label", "Champ de recherche globale FTS5");
    input.addEventListener("change", () => {
      if (this.searchWorkspace) {
        const query = input.value;
        void this.searchWorkspace(query)
          .then((results) => this.stores.setGlobalSearchResults(query, results))
          .catch((error: unknown) => {
            input.title = error instanceof Error ? error.message : "Workspace search failed";
          });
      } else {
        this.stores.runGlobalSearch(input.value);
      }
    });

    const resultsList = doc.createElement("div");
    resultsList.className = "coloride-global-search-results";
    resultsList.setAttribute("role", "list");
    resultsList.dataset.resultCount = String(searchResults.length);

    for (const hit of searchResults) {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "coloride-search-result-item";
      btn.setAttribute("role", "listitem");
      btn.dataset.filePath = hit.filePath;
      btn.dataset.line = String(hit.line);
      btn.dataset.freshness = hit.freshness;
      btn.dataset.secretsRedacted = String(hit.secretsRedacted);
      const freshnessTag =
        hit.freshness === "LiveUnsavedBuffer" ? "● Mémoire (non sauvegardé)" : "Disque";
      btn.textContent = `${hit.filePath}:${hit.line} [${freshnessTag}] — ${hit.snippet}`;
      btn.addEventListener("click", () => {
        if (this.readWorkspaceFile) {
          void this.readWorkspaceFile(hit.filePath).then((content) => {
            this.stores.selectFileFromTree(hit.filePath, content);
          });
        } else {
          this.stores.selectFileFromTree(hit.filePath);
        }
      });
      resultsList.appendChild(btn);
    }

    this.zone2SearchEl.appendChild(input);
    this.zone2SearchEl.appendChild(resultsList);
  }

  private requestNativeAnalysis(documentId: string): void {
    if (!this.analyzeDocument) return;
    const snapshot = this.editorView.getStoreSnapshot();
    if (snapshot.documentId !== documentId) return;
    const requestId = ++this.analysisRequestSequence;
    void this.analyzeDocument(documentId, snapshot.sessionGeneration)
      .then((analysis) => {
        if (requestId !== this.analysisRequestSequence) return;
        if (this.editorView.getStoreSnapshot().documentId !== documentId) return;
        this.stores.setAstAnalysis(analysis.symbols, analysis.impactedTests);
      })
      .catch(() => {
        // A newer document switch or edit may invalidate this request; the next host snapshot retries.
      });
  }

  private renderZone2DebugPanel(
    doc: Document,
    astSymbols: readonly import("./stores.js").CockpitAstSymbolItem[],
    impactedTests: readonly import("./stores.js").CockpitImpactedTestItem[],
  ): void {
    this.zone2DebugEl.innerHTML = "";
    this.zone2DebugEl.setAttribute("aria-label", "Symboles AST Tree-sitter & Tests impactés");

    const symbolsList = doc.createElement("div");
    symbolsList.className = "coloride-ast-symbols-list";
    symbolsList.setAttribute("role", "list");
    symbolsList.dataset.symbolCount = String(astSymbols.length);

    for (const sym of astSymbols) {
      const row = doc.createElement("div");
      row.className = "coloride-ast-symbol-item";
      row.setAttribute("role", "listitem");
      row.dataset.symbolName = sym.name;
      row.dataset.symbolKind = sym.kind;
      row.dataset.confidence = sym.confidence;
      row.textContent = `${sym.kind} ${sym.name} (L${sym.line}) [${sym.confidence}]`;
      symbolsList.appendChild(row);
    }

    const impactedList = doc.createElement("div");
    impactedList.className = "coloride-impacted-tests-list";
    impactedList.setAttribute("role", "list");
    impactedList.dataset.impactedCount = String(impactedTests.length);

    for (const testItem of impactedTests) {
      const row = doc.createElement("div");
      row.className = "coloride-impacted-test-item";
      row.setAttribute("role", "listitem");
      row.dataset.testFilePath = testItem.testFilePath;
      row.dataset.coveredSymbol = testItem.coveredSymbol;
      row.dataset.confidence = testItem.confidence;
      row.textContent = `🧪 ${testItem.testFilePath} ← ${testItem.coveredSymbol} (${testItem.confidence})`;
      impactedList.appendChild(row);
    }

    this.zone2DebugEl.appendChild(symbolsList);
    this.zone2DebugEl.appendChild(impactedList);
  }

  private renderZone2McpPanel(doc: Document): void {
    this.zone2McpEl.innerHTML = "";
    this.zone2McpEl.setAttribute(
      "aria-label",
      "Connecteurs MCP en quarantaine & Assistant d'Onboarding 1-clic",
    );

    const obState = this.onboardingController.store.getState();

    const openWizardBtn = doc.createElement("button");
    openWizardBtn.type = "button";
    openWizardBtn.className = "coloride-open-onboarding-btn";
    openWizardBtn.textContent = obState.modalOpen
      ? "Fermer l'assistant d'Onboarding 1-clic"
      : "Ouvrir l'assistant d'Onboarding 1-clic (VS Code / Cursor / Claude)";
    openWizardBtn.addEventListener("click", () => {
      this.onboardingController.setModalOpen(!obState.modalOpen);
    });
    this.zone2McpEl.appendChild(openWizardBtn);

    const summary = doc.createElement("div");
    summary.className = "coloride-mcp-onboarding-summary";
    summary.dataset.keymapPreset = obState.activeKeymapPreset;
    summary.dataset.colorTheme = obState.colorTheme;
    summary.dataset.quarantinedCount = String(obState.quarantinedMcpServers.length);
    summary.textContent = `Keymap: ${obState.activeKeymapPreset} · Thème: ${obState.colorTheme} · MCP: ${obState.quarantinedMcpServers.length}`;
    this.zone2McpEl.appendChild(summary);
  }

  private renderZone3(): void {
    const doc = this.zone3El.ownerDocument;
    const z3 = this.stores.zone3.getState();

    // Outer Header above Z3: Chat tabs
    this.zone3HeaderEl.innerHTML = "";
    const tabBar = doc.createElement("div");
    tabBar.className = "coloride-chat-tab-bar";
    tabBar.setAttribute("data-tauri-drag-region", "");
    tabBar.setAttribute("role", "tablist");

    const navigation = this.stores.navigation.getState();
    const activeGroup = navigation.groups.find((group) => group.id === navigation.activeGroupId);
    for (const group of navigation.groups) {
      const tab = doc.createElement("button");
      tab.type = "button";
      tab.className = "coloride-chat-tab coloride-work-group-tab";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(group.id === navigation.activeGroupId));
      tab.textContent = group.title;
      tab.addEventListener("click", () => this.stores.selectWorkGroup(group.id));
      tabBar.appendChild(tab);
    }

    this.zone3HeaderEl.appendChild(tabBar);
    this.attachDynamicScrollShadows(this.zone3HeaderEl, tabBar);

    // Multi-Chat Grid cells (up to `gridMode` visible cells)
    this.zone3GridEl.innerHTML = "";
    this.zone3GridEl.dataset.gridMode = String(z3.gridMode);
    this.zone3GridEl.style.display = "grid";
    const columns = z3.gridMode === 1 ? 1 : z3.gridMode === 2 ? 2 : 2;
    this.zone3GridEl.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;

    const groupChats = z3.chats.filter((chat) => activeGroup?.chatIds.includes(chat.chatId));
    const visibleChats = groupChats.slice(0, z3.gridMode);
    const selectedChat = groupChats.find((chat) => chat.chatId === z3.activeChatId);
    if (selectedChat && !visibleChats.includes(selectedChat)) visibleChats[0] = selectedChat;
    if (visibleChats.length === 0) {
      const empty = doc.createElement("div");
      empty.className = "coloride-group-empty";
      empty.textContent = "This group is empty. Agent and terminal panels will appear here.";
      this.zone3GridEl.appendChild(empty);
    }
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
    const z4 = this.stores.zone4.getState();

    this.zone4El.dataset.syncedChatId = z4.syncedChatId;
    this.zone4El.dataset.activeDocumentId = z4.activeDocumentId;
    this.zone4El.dataset.activeInspectorTab = z4.activeInspectorTab;
    this.zone4El.dataset.unsavedChanges = String(z4.hasUnsavedChanges);
    this.zone4El.dataset.recoveredFromWal = String(z4.recoveredFromWal);

    this.zone4HeaderEl.replaceChildren();

    // CodeMirror 6 editor container is always shown
    this.zone4PreviewHostEl.style.display = "none";
    this.zone4EditorHostEl.style.display = "block";
  }

  private attachDynamicScrollShadows(headerEl: HTMLElement, scrollEl: HTMLElement): void {
    const doc = headerEl.ownerDocument;
    const scrollbarTrack = doc.createElement("div");
    scrollbarTrack.className = "coloride-header-thin-scrollbar";
    scrollbarTrack.setAttribute("aria-hidden", "true");

    const scrollbarThumb = doc.createElement("div");
    scrollbarThumb.className = "coloride-header-thin-scrollbar-thumb";
    scrollbarTrack.appendChild(scrollbarThumb);
    headerEl.appendChild(scrollbarTrack);

    const updateShadowsAndScrollbar = () => {
      const { scrollLeft, scrollWidth, clientWidth } = scrollEl;
      const maxScroll = Math.max(0, scrollWidth - clientWidth);
      const isScrollable = maxScroll > 2;
      const canScrollLeft = scrollLeft > 2;
      const canScrollRight = maxScroll - scrollLeft > 2;

      headerEl.dataset.scrollable = String(isScrollable);
      headerEl.dataset.scrollLeft = String(canScrollLeft);
      headerEl.dataset.scrollRight = String(canScrollRight);

      if (isScrollable && scrollWidth > 0) {
        const thumbRatio = Math.max(0.15, Math.min(1, clientWidth / scrollWidth));
        const thumbWidthPct = thumbRatio * 100;
        const scrollProgress = maxScroll > 0 ? Math.min(1, Math.max(0, scrollLeft / maxScroll)) : 0;
        const maxOffsetPct = 100 - thumbWidthPct;
        const leftPct = scrollProgress * maxOffsetPct;
        scrollbarThumb.style.width = `${thumbWidthPct.toFixed(2)}%`;
        scrollbarThumb.style.left = `${leftPct.toFixed(2)}%`;
      } else {
        scrollbarThumb.style.width = "0%";
        scrollbarThumb.style.left = "0%";
      }
    };

    scrollEl.addEventListener("scroll", updateShadowsAndScrollbar, { passive: true });

    let isDragging = false;
    let dragStartX = 0;
    let dragStartScrollLeft = 0;

    scrollbarTrack.addEventListener("pointerdown", (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const { scrollWidth, clientWidth } = scrollEl;
      const maxScroll = Math.max(0, scrollWidth - clientWidth);
      if (maxScroll <= 0) {
        return;
      }

      const trackRect = scrollbarTrack.getBoundingClientRect();
      const thumbRect = scrollbarThumb.getBoundingClientRect();
      const clickX = event.clientX;

      // If user clicked outside the thumb on the track, jump thumb center to click position first
      if (clickX < thumbRect.left || clickX > thumbRect.right) {
        const usableTrackWidth = Math.max(1, trackRect.width - thumbRect.width);
        const targetThumbLeft = Math.max(
          0,
          Math.min(usableTrackWidth, clickX - trackRect.left - thumbRect.width / 2),
        );
        scrollEl.scrollLeft = (targetThumbLeft / usableTrackWidth) * maxScroll;
        updateShadowsAndScrollbar();
      }

      isDragging = true;
      dragStartX = event.clientX;
      dragStartScrollLeft = scrollEl.scrollLeft;
      headerEl.dataset.draggingScroll = "true";
      scrollbarTrack.setPointerCapture?.(event.pointerId);
    });

    scrollbarTrack.addEventListener("pointermove", (event: PointerEvent) => {
      if (!isDragging) {
        return;
      }
      event.preventDefault();
      const { scrollWidth, clientWidth } = scrollEl;
      const maxScroll = Math.max(0, scrollWidth - clientWidth);
      const trackWidth = scrollbarTrack.getBoundingClientRect().width;
      const thumbWidth = scrollbarThumb.getBoundingClientRect().width;
      const usableTrackWidth = Math.max(1, trackWidth - thumbWidth);
      const deltaX = event.clientX - dragStartX;
      scrollEl.scrollLeft = Math.max(
        0,
        Math.min(maxScroll, dragStartScrollLeft + (deltaX / usableTrackWidth) * maxScroll),
      );
      updateShadowsAndScrollbar();
    });

    const stopDragging = (event: PointerEvent) => {
      if (!isDragging) {
        return;
      }
      isDragging = false;
      delete headerEl.dataset.draggingScroll;
      scrollbarTrack.releasePointerCapture?.(event.pointerId);
    };

    scrollbarTrack.addEventListener("pointerup", stopDragging);
    scrollbarTrack.addEventListener("pointercancel", stopDragging);

    const win = headerEl.ownerDocument.defaultView;
    if (win) {
      win.addEventListener("resize", updateShadowsAndScrollbar, { passive: true });
      if (typeof win.requestAnimationFrame === "function") {
        win.requestAnimationFrame(updateShadowsAndScrollbar);
      }
    }
    updateShadowsAndScrollbar();
  }

  private syncZone4UnsavedIndicatorInPlace(hasUnsavedChanges: boolean): void {
    this.zone4El.dataset.unsavedChanges = String(hasUnsavedChanges);
  }
}
