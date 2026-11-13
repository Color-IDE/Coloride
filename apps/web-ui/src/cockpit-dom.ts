import type { ColorideEditorView } from "@coloride/editor-cm6";
import { ActivityBar } from "./cockpit/activity-bar.js";
import { ChatGrid } from "./cockpit/chat-grid.js";
import { Inspector } from "./cockpit/inspector.js";
import { SidebarPanels } from "./cockpit/sidebar-panels.js";
import { TitleBar } from "./cockpit/title-bar.js";
import {
  TrustBanner,
  type WorkspaceTrustHost,
  type WorkspaceTrustReport,
} from "./cockpit/trust-banner.js";
import { askUnsavedPrompt } from "./cockpit/unsaved-dialog.js";
import { OnboardingModalController, createInitialOnboardingState } from "./onboarding/index.js";
import type {
  CockpitAstSymbolItem,
  CockpitFileTreeNode,
  CockpitImpactedTestItem,
  CockpitSearchResultItem,
  CockpitStoreBundle,
  Zone1ActivityState,
  Zone4InspectorState,
} from "./stores/index.js";
import { UI_STRINGS, uiText } from "./ui-strings.js";

export type {
  WorkspaceTrustHost,
  WorkspaceTrustReport,
  WorkspaceTrustState,
} from "./cockpit/trust-banner.js";

export interface CockpitDomControllerOptions {
  readonly rootContainer: HTMLElement;
  readonly stores: CockpitStoreBundle;
  readonly editorView: ColorideEditorView;
  readonly onboardingController?: OnboardingModalController;
  readonly openWorkspace?: () => Promise<readonly CockpitFileTreeNode[] | null>;
  readonly switchWorkspace?: (path: string) => Promise<readonly CockpitFileTreeNode[] | null>;
  readonly readWorkspaceFile?: (path: string) => Promise<string>;
  /**
   * Called with how many files have unsaved changes whenever that number changes, so the host
   * can hold back closing the window while it is above zero.
   */
  readonly onUnsavedCountChange?: (count: number) => void;
  /**
   * Workspace Trust decision kept by the host. Without it there is no host able to run anything
   * from the folder, so no restricted-mode notice is shown.
   */
  readonly workspaceTrust?: WorkspaceTrustHost;
  readonly searchWorkspace?: (query: string) => Promise<readonly CockpitSearchResultItem[]>;
  readonly analyzeDocument?: (
    documentId: string,
    sessionGeneration: number,
  ) => Promise<{
    readonly symbols: readonly CockpitAstSymbolItem[];
    readonly impactedTests: readonly CockpitImpactedTestItem[];
  }>;
}

/** Grid columns shared by the title bar and the shell, so headers stay above their zone. */
function cockpitGridColumns(z1: Zone1ActivityState): string {
  const sidebar = z1.sidebarOpen ? "clamp(200px, 19vw, 280px)" : "0px";
  const inspector = z1.inspectorOpen ? "clamp(300px, 45%, 640px)" : "0px";
  return `48px ${sidebar} minmax(0, 1fr) ${inspector}`;
}

/**
 * 4-Zone Multi-Chat Cockpit: builds the shell, mounts one component per zone and routes store
 * changes to them. The zones live in `./cockpit/`:
 * Zone 1 `ActivityBar`, Zone 2 `SidebarPanels`, Zone 3 `ChatGrid`, Zone 4 `Inspector`, plus the
 * `TitleBar` that holds the Zone 3 and Zone 4 headers.
 * The singleton `ColorideEditorView` is mounted once in Zone 4 and never re-mounted.
 */
export class CockpitDomController {
  private readonly stores: CockpitStoreBundle;
  private readonly editorView: ColorideEditorView;
  private readonly onboardingController: OnboardingModalController;
  private readonly ownsOnboardingController: boolean;
  private readonly analyzeDocument?: CockpitDomControllerOptions["analyzeDocument"];
  private readonly unsubscribers: Array<() => void> = [];
  private readonly shell: HTMLElement;
  private readonly titleBar: TitleBar;
  private readonly activityBar: ActivityBar;
  private readonly sidebar: SidebarPanels;
  private readonly chatGrid: ChatGrid;
  private readonly inspector: Inspector;
  private readonly trustBanner: TrustBanner | null;
  private zone4RenderCount = 0;
  private analysisRequestSequence = 0;
  private readonly onUnsavedCountChange: ((count: number) => void) | undefined;
  private lastUnsavedCount = 0;
  private closePrompt: Promise<boolean> | null = null;
  /** Project whose file the editor holds (document ids alone do not say which). */
  private editorProjectPath: string;

  constructor(options: CockpitDomControllerOptions) {
    const { rootContainer, stores, editorView } = options;
    this.stores = stores;
    this.editorView = editorView;
    this.editorProjectPath = stores.navigation.getState().projectPath;
    this.analyzeDocument = options.analyzeDocument;
    this.onUnsavedCountChange = options.onUnsavedCountChange;
    this.ownsOnboardingController = !options.onboardingController;
    this.onboardingController =
      options.onboardingController ??
      new OnboardingModalController(editorView, {
        ...createInitialOnboardingState(),
        modalOpen: false,
      });

    // Seed initial editor content into the store's UnsavedBufferOverlay
    stores.updateInMemoryDocumentContent(
      editorView.getStoreSnapshot().documentId,
      editorView.getDocumentText(),
      false,
    );

    const doc = rootContainer.ownerDocument;
    rootContainer.replaceChildren();
    this.titleBar = new TitleBar(doc, rootContainer, stores);
    this.activityBar = new ActivityBar(doc, stores);
    this.inspector = new Inspector(doc, {
      stores,
      editorView,
      header: this.titleBar.zone4Header,
      saveActiveDocument: () => this.saveActiveDocument(),
      onFileShown: (path) => this.requestNativeAnalysis(path),
      onUnsavedChange: () => this.reportUnsaved(),
      onTreeScroll: (scrollTopPx, viewportHeightPx) =>
        this.storeFileTreeScroll(scrollTopPx, viewportHeightPx),
      ...(options.readWorkspaceFile ? { readWorkspaceFile: options.readWorkspaceFile } : {}),
      ...(options.openWorkspace ? { openWorkspace: options.openWorkspace } : {}),
    });
    this.sidebar = new SidebarPanels(doc, {
      stores,
      onboarding: this.onboardingController,
      openFile: (path, onError) => {
        // A file opened from the sidebar (search results) is shown in Zone 4, which starts closed.
        stores.toggleInspector(true);
        void this.inspector.openFile(path, onError);
      },
      ...(options.openWorkspace ? { openWorkspace: options.openWorkspace } : {}),
      ...(options.switchWorkspace ? { switchWorkspace: options.switchWorkspace } : {}),
      ...(options.searchWorkspace ? { searchWorkspace: options.searchWorkspace } : {}),
    });
    this.chatGrid = new ChatGrid(doc, stores, this.titleBar.zone3Header);

    this.shell = doc.createElement("div");
    this.shell.className = "coloride-cockpit-shell";
    this.shell.setAttribute("role", "application");
    this.shell.setAttribute("aria-label", UI_STRINGS.shell.cockpit);
    this.shell.style.display = "grid";
    this.shell.style.width = "100%";
    this.shell.style.height = "100vh";
    this.shell.style.overflow = "hidden";
    this.shell.append(
      this.activityBar.element,
      this.sidebar.element,
      this.chatGrid.element,
      this.inspector.element,
    );
    rootContainer.append(this.shell);
    this.trustBanner = options.workspaceTrust ? new TrustBanner(doc, options.workspaceTrust) : null;
    if (this.trustBanner) {
      this.shell.append(this.trustBanner.element);
      void this.trustBanner.refresh();
    }

    this.onboardingController.mountModal(this.shell);
    this.renderLayout();
    this.sidebar.update();
    this.chatGrid.update();
    this.inspector.update();
    this.titleBar.recordChatVisit(stores.zone3.getState().activeChatId);
    this.inspector.mountEditor();

    // On the document, not the shell: with nothing focused (after clicking the title bar or an
    // empty area) key events target `body`, which is outside the shell.
    const onKeydown = (event: KeyboardEvent) => this.handleShortcut(event);
    doc.addEventListener("keydown", onKeydown);
    this.unsubscribers.push(
      () => doc.removeEventListener("keydown", onKeydown),
      // Each folder has its own trust decision: ask again whenever another one is opened.
      stores.navigation.subscribeSelector(
        (state) => state.projectPath,
        () => void this.trustBanner?.refresh(),
      ),
      stores.navigation.subscribeSelector(
        (state) => [state.projectPath, state.activeGroupId] as const,
        ([projectPath, groupId]) => this.inspector.changeScope(projectPath, groupId),
        (a, b) => a[0] === b[0] && a[1] === b[1],
      ),
      // What Zone 3 shows: the active group's sessions and layout. The project matters too, since
      // every project has a group "Workspace" with the same id but its own sessions.
      stores.navigation.subscribeSelector(
        (state) =>
          [
            state.projectPath,
            state.activeGroupId,
            state.groups
              .map((group) => `${group.id}:${group.title}:${group.chatIds.join(",")}`)
              .join("|"),
            state.groups.find((group) => group.id === state.activeGroupId)?.layout,
            state.groups.find((group) => group.id === state.activeGroupId)?.maximizedChatId,
          ] as const,
        () => this.chatGrid.update(),
        (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4],
      ),
      stores.zone1.subscribe(() => {
        this.renderLayout();
        this.sidebar.update();
      }),
      stores.zone2.subscribe(() => {
        this.sidebar.update();
        this.inspector.updateTree();
      }),
      stores.zone3.subscribe((next, prev) => {
        this.chatGrid.update();
        if (next.activeChatId !== prev.activeChatId) {
          this.titleBar.recordChatVisit(next.activeChatId);
        } else if (next.chats !== prev.chats) {
          this.titleBar.refreshHistory();
        }
      }),
      stores.zone4.subscribe((next, prev) => {
        this.zone4RenderCount += 1;
        this.inspector.update();
        // Document ids are paths relative to the project, so the same id in another project is
        // another file: once one is shown there, the editor must load it too.
        const projectPath = stores.navigation.getState().projectPath;
        const otherProjectsFile =
          this.editorProjectPath !== projectPath && this.inspector.isShowingFile();
        if (next.activeDocumentId !== prev.activeDocumentId || otherProjectsFile) {
          this.editorProjectPath = projectPath;
          this.syncEditorDocument(next);
        }
      }),
      editorView.subscribe(() => {
        const snap = editorView.getStoreSnapshot();
        // Until host-core acknowledges the shown document (just after a switch), keep the flag the
        // buffer already had: a file reopened with unsaved edits must not look saved.
        const hasUnsaved = snap.lastAckSnapshot
          ? snap.lastAckSnapshot.has_unsaved_changes
          : stores.isDocumentUnsaved(snap.documentId);
        stores.updateInMemoryDocumentContent(
          snap.documentId,
          editorView.getDocumentText(),
          hasUnsaved,
        );
        this.inspector.setUnsaved(hasUnsaved);
        this.reportUnsaved();
        if (snap.lastIpcError) this.inspector.reportError(snap.lastIpcError);
        if (snap.lastAckSnapshot) this.requestNativeAnalysis(snap.documentId);
      }),
      this.onboardingController.store.subscribe(() => {
        if (stores.zone1.getState().activeSection === "mcp") this.sidebar.update();
      }),
    );
  }

  getOnboardingController(): OnboardingModalController {
    return this.onboardingController;
  }

  /** Trust decision last reported by the host; null when the cockpit has no trust host. */
  getWorkspaceTrust(): WorkspaceTrustReport | null {
    return this.trustBanner?.getReport() ?? null;
  }

  /** Re-reads the trust decision from the host (after it changed outside the banner). */
  async refreshWorkspaceTrust(): Promise<void> {
    await this.trustBanner?.refresh();
  }

  async saveActiveDocument(): Promise<void> {
    // With no file shown the editor may still hold another group's or project's document.
    if (!this.inspector.isShowingFile()) return;
    const snap = await this.editorView.requestSave();
    this.stores.markDocumentSaved(snap.document_id);
    this.inspector.setUnsaved(false);
    this.reportUnsaved();
  }

  /** Files with unsaved changes: the open project's buffers and the ones kept aside for others. */
  unsavedCount(): number {
    return this.stores.getUnsavedDocumentIds().length + this.inspector.stashedUnsavedCount();
  }

  private reportUnsaved(): void {
    const count = this.unsavedCount();
    if (count === this.lastUnsavedCount) return;
    this.lastUnsavedCount = count;
    this.onUnsavedCountChange?.(count);
  }

  /**
   * Decides whether the window may close: true when nothing is unsaved, or once the user chose
   * to save (everything that can be saved from here) or not to. Asked while another prompt is
   * still open, it shares that prompt's answer.
   */
  confirmClose(): Promise<boolean> {
    this.closePrompt ??= this.askBeforeClosing().finally(() => {
      this.closePrompt = null;
    });
    return this.closePrompt;
  }

  private async askBeforeClosing(): Promise<boolean> {
    const total = this.unsavedCount();
    if (total === 0) return true;
    const choice = await askUnsavedPrompt(this.shell, {
      message: uiText.unsavedCloseAll(total),
      saveLabel: UI_STRINGS.editor.saveAll,
    });
    if (choice === "cancel") return false;
    if (choice === "discard") return true;
    try {
      await this.inspector.saveAllUnsaved();
    } catch (error: unknown) {
      this.inspector.reportError(
        error instanceof Error ? error.message : UI_STRINGS.editor.saveFailed,
      );
      return false;
    }
    // What is left (other projects' edits) cannot be saved from here: let the user decide.
    const remaining = this.unsavedCount();
    if (remaining === 0) return true;
    const rest = await askUnsavedPrompt(this.shell, {
      message: uiText.unsavedElsewhere(remaining),
      saveLabel: null,
      discardLabel: UI_STRINGS.editor.closeWithoutSaving,
    });
    return rest === "discard";
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
      shell: this.shell,
      zone1: this.activityBar.element,
      zone2: this.sidebar.element,
      zone3: this.chatGrid.element,
      zone4: this.inspector.element,
      zone4EditorHost: this.inspector.editorHost,
    };
  }

  getZone4RenderCount(): number {
    return this.zone4RenderCount;
  }

  /** Scrolls the sidebar file tree (programmatic; also records the position for the session). */
  scrollFileTree(scrollTopPx: number, viewportHeightPx = 600): void {
    this.storeFileTreeScroll(scrollTopPx, viewportHeightPx);
    this.inspector.tree.scrollTo(scrollTopPx, viewportHeightPx);
  }

  destroy(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    this.trustBanner?.destroy();
    this.chatGrid.destroy();
    this.inspector.destroy();
    this.sidebar.destroy();
    if (this.ownsOnboardingController) this.onboardingController.destroy();
  }

  private renderLayout(): void {
    const z1 = this.stores.zone1.getState();
    const columns = cockpitGridColumns(z1);
    this.shell.dataset.uiZoomPercent = String(z1.uiZoomPercent);
    this.shell.dataset.activePersona = z1.activePersona;
    this.shell.dataset.sidebarOpen = String(z1.sidebarOpen);
    this.shell.dataset.inspectorOpen = String(z1.inspectorOpen);
    this.shell.style.fontSize = `${(z1.uiZoomPercent / 100).toFixed(2)}rem`;
    this.shell.style.gridTemplateColumns = columns;
    this.titleBar.update(z1, columns);
    this.activityBar.update(z1);
    this.inspector.setOpen(z1.inspectorOpen);
  }

  private storeFileTreeScroll(scrollTopPx: number, viewportHeightPx: number): void {
    this.stores.zone2.setState((prev) => ({
      ...prev,
      fileTreeScrollTop: scrollTopPx,
      fileTreeViewportHeight: viewportHeightPx,
    }));
  }

  private syncEditorDocument(z4: Zone4InspectorState): void {
    const storedContent = this.stores.getDocumentContent(z4.activeDocumentId);
    const targetChat = this.stores.zone3
      .getState()
      .chats.find((chat) => chat.chatId === z4.syncedChatId);
    const content =
      storedContent ?? targetChat?.targetDocumentContent ?? this.editorView.getDocumentText();
    this.editorView.switchDocument(z4.activeDocumentId, content, [
      {
        fromLine: 1,
        toLine: 1,
        state: z4.activeValidationState,
        snapshotHash: `sync-${z4.syncedChatId}`,
      },
    ]);
  }

  private handleShortcut(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void this.saveActiveDocument().catch((error: unknown) => {
        this.inspector.reportError(
          error instanceof Error ? error.message : UI_STRINGS.editor.saveFailed,
        );
      });
      return;
    }
    if (this.stores.handleActivityBarShortcut(event.key, event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      return;
    }
    if (event.altKey && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      // Alt+Arrow also moves the caret by word in the editor and in text fields (macOS): there it
      // belongs to the text, never to the session switcher.
      if (event.defaultPrevented || isTextEditingTarget(event.target)) return;
      const { chats, activeChatId } = this.stores.zone3.getState();
      const index = chats.findIndex((chat) => chat.chatId === activeChatId);
      if (index < 0 || chats.length < 2) return;
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const next = chats[(index + delta + chats.length) % chats.length];
      if (next) {
        this.stores.selectChat(next.chatId);
        event.preventDefault();
      }
    }
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
}

/** Whether keys typed at `target` edit text: a field, or the code editor's content. */
function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable || target.closest("input, textarea, [contenteditable='true']") !== null
  );
}
