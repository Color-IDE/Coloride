import type { OnboardingModalController } from "../onboarding/index.js";
import { WorkspaceSidebar } from "../sidebar/workspace-sidebar.js";
import type {
  CockpitAstSymbolItem,
  CockpitFileTreeNode,
  CockpitImpactedTestItem,
  CockpitSearchResultItem,
  CockpitStoreBundle,
} from "../stores/index.js";
import { UI_STRINGS, uiText } from "../ui-strings.js";

export interface SidebarPanelsOptions {
  readonly stores: CockpitStoreBundle;
  readonly onboarding: OnboardingModalController;
  readonly openWorkspace?: () => Promise<readonly CockpitFileTreeNode[] | null>;
  readonly switchWorkspace?: (path: string) => Promise<readonly CockpitFileTreeNode[] | null>;
  readonly searchWorkspace?: (query: string) => Promise<readonly CockpitSearchResultItem[]>;
  readonly openFile: (path: string, onError: (message: string) => void) => void;
}

/**
 * Zone 2: one panel per activity (sessions, files, search, debug, MCP). Every panel is built
 * once; updates only touch what changed, so focus (e.g. in the search box) survives them.
 */
export class SidebarPanels {
  readonly element: HTMLElement;
  private readonly projectControls: HTMLElement;
  private readonly sessions: HTMLElement;
  private readonly workspaceSidebar: WorkspaceSidebar;
  private readonly search: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly searchResults: HTMLElement;
  private shownResults: readonly CockpitSearchResultItem[] | null = null;
  private readonly debug: HTMLElement;
  private readonly symbolsList: HTMLElement;
  private readonly impactedList: HTMLElement;
  private shownSymbols: readonly CockpitAstSymbolItem[] | null = null;
  private shownImpacted: readonly CockpitImpactedTestItem[] | null = null;
  private readonly mcp: HTMLElement;
  private readonly wizardButton: HTMLButtonElement;
  private readonly mcpSummary: HTMLElement;

  constructor(
    doc: Document,
    private readonly options: SidebarPanelsOptions,
  ) {
    const { stores } = options;
    this.element = doc.createElement("aside");
    this.element.className =
      "coloride-zone-2-sidebar bg-sidebar border-y border-l border-r-0 border-white/8 rounded-tl-[16px] rounded-bl-[16px] p-2.5 h-full";
    this.element.setAttribute("aria-label", UI_STRINGS.shell.sidebar);
    this.element.style.minWidth = "0";
    this.element.style.overflow = "auto";

    this.projectControls = doc.createElement("div");
    this.projectControls.className = "sidebar-project-controls";
    this.sessions = doc.createElement("div");
    this.sessions.className = "sidebar-navigation";

    this.search = doc.createElement("div");
    this.search.className = "coloride-zone-2-search flex flex-col gap-2";
    this.search.setAttribute("aria-label", UI_STRINGS.search.panel);
    this.searchInput = doc.createElement("input");
    this.searchInput.type = "search";
    this.searchInput.className = "coloride-global-search-input";
    this.searchInput.placeholder = UI_STRINGS.search.placeholder;
    this.searchInput.setAttribute("aria-label", UI_STRINGS.search.input);
    this.searchInput.addEventListener("change", () => this.runSearch());
    this.searchResults = doc.createElement("div");
    this.searchResults.className = "coloride-global-search-results";
    this.searchResults.setAttribute("role", "list");
    this.search.append(this.searchInput, this.searchResults);

    this.debug = doc.createElement("div");
    this.debug.className = "coloride-zone-2-debug flex flex-col gap-2";
    this.debug.setAttribute("aria-label", UI_STRINGS.debug.panel);
    this.symbolsList = doc.createElement("div");
    this.symbolsList.className = "coloride-ast-symbols-list";
    this.symbolsList.setAttribute("role", "list");
    this.impactedList = doc.createElement("div");
    this.impactedList.className = "coloride-impacted-tests-list";
    this.impactedList.setAttribute("role", "list");
    this.debug.append(this.symbolsList, this.impactedList);

    this.mcp = doc.createElement("div");
    this.mcp.className = "coloride-zone-2-mcp flex flex-col gap-2";
    this.mcp.setAttribute("aria-label", UI_STRINGS.mcp.panel);
    this.wizardButton = doc.createElement("button");
    this.wizardButton.type = "button";
    this.wizardButton.className = "coloride-open-onboarding-btn";
    this.wizardButton.addEventListener("click", () => {
      options.onboarding.setModalOpen(!options.onboarding.store.getState().modalOpen);
    });
    this.mcpSummary = doc.createElement("div");
    this.mcpSummary.className = "coloride-mcp-onboarding-summary";
    this.mcp.append(this.wizardButton, this.mcpSummary);

    this.element.append(this.projectControls, this.sessions, this.search, this.debug, this.mcp);

    this.workspaceSidebar = new WorkspaceSidebar({
      controlsHost: this.projectControls,
      treeHost: this.sessions,
      stores,
      ...(options.openWorkspace ? { openWorkspace: options.openWorkspace } : {}),
      ...(options.switchWorkspace ? { switchWorkspace: options.switchWorkspace } : {}),
    });
  }

  update(): void {
    const { stores } = this.options;
    const z1 = stores.zone1.getState();
    const z2 = stores.zone2.getState();
    this.element.dataset.sidebarOpen = String(z1.sidebarOpen);
    this.element.dataset.fileTreeAccessible = String(z1.fileTreeAccessible);
    this.element.dataset.activeSection = z1.activeSection;
    this.element.toggleAttribute("inert", !z1.sidebarOpen);

    const section = z1.activeSection;
    this.show(this.projectControls, section === "sessions", "flex");
    this.show(this.sessions, section === "sessions", "block");
    this.show(this.search, section === "search", "flex");
    this.show(this.debug, section === "debug", "flex");
    this.show(this.mcp, section === "mcp", "flex");

    if (section === "search") this.updateSearch(z2.searchQuery, z2.searchResults);
    if (section === "debug") this.updateDebug(z2.astSymbols, z2.impactedTests);
    if (section === "mcp") this.updateMcp();
  }

  destroy(): void {
    this.workspaceSidebar.destroy();
  }

  private show(el: HTMLElement, visible: boolean, display: string): void {
    el.hidden = !visible;
    el.style.display = visible ? display : "none";
  }

  private runSearch(): void {
    const { stores, searchWorkspace } = this.options;
    const query = this.searchInput.value;
    if (!searchWorkspace) {
      stores.runGlobalSearch(query);
      return;
    }
    void searchWorkspace(query)
      .then((results) => stores.setGlobalSearchResults(query, results))
      .catch((error: unknown) => {
        this.searchInput.title = error instanceof Error ? error.message : UI_STRINGS.search.failed;
      });
  }

  private updateSearch(query: string, results: readonly CockpitSearchResultItem[]): void {
    // Never overwrite what the user is typing.
    if (this.searchInput.ownerDocument.activeElement !== this.searchInput) {
      this.searchInput.value = query;
    }
    if (results === this.shownResults) return;
    this.shownResults = results;
    const doc = this.searchResults.ownerDocument;
    this.searchResults.dataset.resultCount = String(results.length);
    this.searchResults.replaceChildren(
      ...results.map((hit) => {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "coloride-search-result-item";
        button.setAttribute("role", "listitem");
        button.dataset.filePath = hit.filePath;
        button.dataset.line = String(hit.line);
        button.dataset.freshness = hit.freshness;
        button.dataset.secretsRedacted = String(hit.secretsRedacted);
        const freshness =
          hit.freshness === "LiveUnsavedBuffer"
            ? UI_STRINGS.search.unsavedBuffer
            : UI_STRINGS.search.disk;
        button.textContent = uiText.searchHit(hit.filePath, hit.line, freshness, hit.snippet);
        button.addEventListener("click", () =>
          this.options.openFile(hit.filePath, (message) => {
            button.title = message;
          }),
        );
        return button;
      }),
    );
  }

  /** The Debug section, where the debugger panel is placed above the AST lists. */
  get debugSection(): HTMLElement {
    return this.debug;
  }

  private updateDebug(
    symbols: readonly CockpitAstSymbolItem[],
    impacted: readonly CockpitImpactedTestItem[],
  ): void {
    const doc = this.debug.ownerDocument;
    if (symbols !== this.shownSymbols) {
      this.shownSymbols = symbols;
      this.symbolsList.dataset.symbolCount = String(symbols.length);
      this.symbolsList.replaceChildren(
        ...symbols.map((symbol) => {
          const row = doc.createElement("div");
          row.className = "coloride-ast-symbol-item";
          row.setAttribute("role", "listitem");
          row.dataset.symbolName = symbol.name;
          row.dataset.symbolKind = symbol.kind;
          row.dataset.confidence = symbol.confidence;
          row.textContent = `${symbol.kind} ${symbol.name} (L${symbol.line}) [${symbol.confidence}]`;
          return row;
        }),
      );
    }
    if (impacted !== this.shownImpacted) {
      this.shownImpacted = impacted;
      this.impactedList.dataset.impactedCount = String(impacted.length);
      this.impactedList.replaceChildren(
        ...impacted.map((test) => {
          const row = doc.createElement("div");
          row.className = "coloride-impacted-test-item";
          row.setAttribute("role", "listitem");
          row.dataset.testFilePath = test.testFilePath;
          row.dataset.coveredSymbol = test.coveredSymbol;
          row.dataset.confidence = test.confidence;
          row.textContent = `🧪 ${test.testFilePath} ← ${test.coveredSymbol} (${test.confidence})`;
          return row;
        }),
      );
    }
  }

  private updateMcp(): void {
    const state = this.options.onboarding.store.getState();
    this.wizardButton.textContent = state.modalOpen
      ? UI_STRINGS.mcp.closeWizard
      : UI_STRINGS.mcp.openWizard;
    this.mcpSummary.dataset.keymapPreset = state.activeKeymapPreset;
    this.mcpSummary.dataset.colorTheme = state.colorTheme;
    this.mcpSummary.dataset.quarantinedCount = String(state.quarantinedMcpServers.length);
    this.mcpSummary.textContent = uiText.mcpSummary(
      state.activeKeymapPreset,
      state.colorTheme,
      state.quarantinedMcpServers.length,
    );
  }
}
