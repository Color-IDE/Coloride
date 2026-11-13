import type { ColorideEditorView } from "@coloride/editor-cm6";
import type { CockpitStoreBundle } from "../stores.js";
import { type ThinScrollbar, attachThinScrollbar } from "../thin-scrollbar.js";
import { UI_STRINGS } from "../ui-strings.js";
import { EditorTabs } from "./editor-tabs.js";
import { FileTreePanel } from "./file-tree-panel.js";

export interface InspectorOptions {
  readonly stores: CockpitStoreBundle;
  readonly editorView: ColorideEditorView;
  readonly header: HTMLElement;
  readonly readWorkspaceFile?: (path: string) => Promise<string>;
  /** Re-runs native analysis once a file is shown. */
  readonly onFileShown: (path: string) => void;
  readonly onTreeScroll: (scrollTopPx: number, viewportHeightPx: number) => void;
}

/**
 * Zone 4: the code editor with its open-file tabs, and the project file tree beside it.
 * The CodeMirror 6 view is mounted once and only ever hidden, never unmounted.
 * Open tabs are remembered per project.
 */
export class Inspector {
  readonly element: HTMLElement;
  readonly editorHost: HTMLElement;
  readonly tree: FileTreePanel;
  private readonly previewHost: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly tabs: EditorTabs;
  private editorScrollbar: ThinScrollbar | null = null;
  /** Files opened in this project, in opening order. They accumulate until closed. */
  private openTabs: string[] = [];
  /** Set when no file is shown; cleared as soon as another file is opened. */
  private closedDocId: string | null = null;
  private projectPath: string;
  private readonly tabsByProject = new Map<string, { tabs: string[]; active: string | null }>();
  /** Files shown in the current project, whose in-memory buffer can be trusted. */
  private loadedPaths = new Set<string>();

  constructor(
    doc: Document,
    private readonly options: InspectorOptions,
  ) {
    const { stores } = options;
    this.projectPath = stores.navigation.getState().projectPath;

    this.element = doc.createElement("section");
    this.element.className =
      "coloride-zone-4-inspector bg-main border border-white/8 rounded-tr-[16px] rounded-br-[16px] flex flex-col h-full overflow-hidden";
    this.element.setAttribute("aria-label", UI_STRINGS.shell.inspector);
    this.element.style.minWidth = "0";
    this.element.style.overflow = "hidden";

    this.previewHost = doc.createElement("div");
    this.previewHost.className =
      "coloride-zone-4-preview-host flex-1 w-full h-full overflow-auto p-0 bg-main select-text";
    this.editorHost = doc.createElement("div");
    this.editorHost.className =
      "coloride-zone-4-editor-host flex-1 w-full h-full overflow-hidden p-0 bg-main select-text";
    this.editorHost.dataset.isolatedCm6Container = "true";
    this.empty = doc.createElement("p");
    this.empty.className = "coloride-zone-4-empty";
    this.empty.textContent = UI_STRINGS.editor.noFile;
    this.empty.hidden = true;

    const editorColumn = doc.createElement("div");
    editorColumn.className = "coloride-zone-4-editor-column";
    editorColumn.append(this.previewHost, this.editorHost, this.empty);

    this.tree = new FileTreePanel(doc, {
      className: "coloride-zone-4-tree-column",
      withFilter: true,
      onOpenFile: (node) => this.openFile(node.path, (message) => this.tree.reportError(message)),
      onScroll: options.onTreeScroll,
    });

    const body = doc.createElement("div");
    body.className = "coloride-zone-4-body";
    body.append(editorColumn, this.tree.element);
    this.element.append(body);

    this.tabs = new EditorTabs(doc, options.header, {
      open: (path) => this.openFile(path),
      close: (path) => this.closeTab(path),
    });
  }

  /** Mounts the singleton CodeMirror 6 view into its permanent container. */
  mountEditor(): void {
    this.options.editorView.mount(this.editorHost);
    this.editorScrollbar = attachThinScrollbar(
      this.editorHost,
      this.options.editorView.getEditorView().scrollDOM,
      "y",
    );
  }

  setOpen(open: boolean): void {
    // Collapsed (not unmounted): the CodeMirror 6 view must survive hiding the inspector.
    this.element.style.visibility = open ? "visible" : "hidden";
    this.element.toggleAttribute("inert", !open);
  }

  /** Syncs tabs and visibility with Zone 4 state. */
  update(): void {
    const z4 = this.options.stores.zone4.getState();
    this.element.dataset.syncedChatId = z4.syncedChatId;
    this.element.dataset.activeDocumentId = z4.activeDocumentId;
    this.element.dataset.activeInspectorTab = z4.activeInspectorTab;
    this.element.dataset.unsavedChanges = String(z4.hasUnsavedChanges);
    this.element.dataset.recoveredFromWal = String(z4.recoveredFromWal);

    if (z4.activeDocumentId !== this.closedDocId) {
      this.closedDocId = null;
      this.loadedPaths.add(z4.activeDocumentId);
      if (!this.openTabs.includes(z4.activeDocumentId)) {
        this.openTabs = [...this.openTabs, z4.activeDocumentId];
      }
    }
    const noFile = this.closedDocId !== null;
    this.tabs.update(this.openTabs, noFile ? null : z4.activeDocumentId, z4.hasUnsavedChanges);

    const wasHidden = this.editorHost.style.display === "none";
    this.previewHost.style.display = "none";
    this.editorHost.style.display = noFile ? "none" : "block";
    this.empty.hidden = !noFile;
    if (!noFile && wasHidden) this.options.editorView.getEditorView().requestMeasure();
    this.updateTree();
  }

  updateTree(): void {
    const { stores } = this.options;
    this.tree.update(stores.zone2.getState().fileTree, stores.zone4.getState().activeDocumentId);
  }

  setUnsaved(hasUnsavedChanges: boolean): void {
    this.element.dataset.unsavedChanges = String(hasUnsavedChanges);
  }

  reportError(message: string): void {
    this.options.header.title = message;
  }

  /** Swaps the open tabs (and resets the tree view) when the active project changes. */
  changeProject(projectPath: string): void {
    if (projectPath === this.projectPath) return;
    const activeId = this.options.stores.zone4.getState().activeDocumentId;
    this.tabsByProject.set(this.projectPath, {
      tabs: this.openTabs,
      active: this.closedDocId === null ? activeId : null,
    });
    const saved = this.tabsByProject.get(projectPath);
    this.projectPath = projectPath;
    this.openTabs = saved?.tabs ?? [];
    this.loadedPaths = new Set();
    // The editor still holds the previous project's file: show the empty state until a file of
    // this project is opened (or the one it had open is restored below).
    this.closedDocId = activeId;
    this.tree.reset();
    this.update();
    if (saved?.active) this.openFile(saved.active);
  }

  /**
   * Shows a file and keeps it as a tab. A file already shown in this project keeps its
   * in-memory content (including unsaved edits); otherwise it is read from disk first.
   */
  openFile(path: string, onError: (message: string) => void = (m) => this.reportError(m)): void {
    const { stores, readWorkspaceFile } = this.options;
    const show = (content?: string) => {
      this.closedDocId = null;
      this.loadedPaths.add(path);
      if (!this.openTabs.includes(path)) this.openTabs = [...this.openTabs, path];
      stores.selectFileFromTree(path, content);
      this.update();
      this.options.onFileShown(path);
    };
    // Buffers are keyed by relative path, so another project's file of the same name must not
    // be mistaken for this one: only reuse a buffer already shown in the current project.
    const trusted = this.loadedPaths.has(path) && stores.getDocumentContent(path) !== undefined;
    if (trusted || !readWorkspaceFile) {
      show();
      return;
    }
    void readWorkspaceFile(path)
      .then((content) => show(content))
      .catch((error: unknown) => {
        onError(error instanceof Error ? error.message : UI_STRINGS.files.readFailed);
      });
  }

  destroy(): void {
    this.tabs.destroy();
    this.tree.destroy();
    this.editorScrollbar?.destroy();
  }

  private closeTab(path: string): void {
    const index = this.openTabs.indexOf(path);
    if (index < 0) return;
    this.openTabs = this.openTabs.filter((item) => item !== path);
    const activeId = this.options.stores.zone4.getState().activeDocumentId;
    if (path !== activeId || this.closedDocId !== null) {
      this.update();
      return;
    }
    const next = this.openTabs[index] ?? this.openTabs[index - 1];
    if (next) {
      this.openFile(next);
    } else {
      this.closedDocId = path;
      this.update();
    }
  }
}
