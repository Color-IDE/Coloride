import type { ColorideEditorView } from "@coloride/editor-cm6";
import type { CockpitStoreBundle } from "../stores/index.js";
import { fileTreeIconColor, fileTreeIconSvg } from "../theme/file-tree-icons.js";
import { type ThinScrollbar, attachThinScrollbar } from "../thin-scrollbar.js";
import { UI_STRINGS, uiText } from "../ui-strings.js";
import { FileTreePanel } from "./file-tree-panel.js";
import { type HeaderTabSpec, HeaderTabs } from "./header-tabs.js";
import { askUnsavedChoice } from "./unsaved-dialog.js";

export interface InspectorOptions {
  readonly stores: CockpitStoreBundle;
  readonly editorView: ColorideEditorView;
  readonly header: HTMLElement;
  readonly readWorkspaceFile?: (path: string) => Promise<string>;
  /** Saves the document currently shown in the editor. */
  readonly saveActiveDocument: () => Promise<void>;
  /** Re-runs native analysis once a file is shown. */
  readonly onFileShown: (path: string) => void;
  readonly onTreeScroll: (scrollTopPx: number, viewportHeightPx: number) => void;
}

/**
 * Zone 4: the code editor with its open-file tabs, and the project file tree beside it.
 * The CodeMirror 6 view is mounted once and only ever hidden, never unmounted.
 * Open tabs belong to a work group (a Zone 3 tab); each project and group remembers its own.
 */
export class Inspector {
  readonly element: HTMLElement;
  readonly editorHost: HTMLElement;
  readonly tree: FileTreePanel;
  private readonly previewHost: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly tabs: HeaderTabs;
  private editorScrollbar: ThinScrollbar | null = null;
  /** Files opened in this group, in opening order. They accumulate until closed. */
  private openTabs: string[] = [];
  /** Set when no file is shown; cleared as soon as another file is opened. */
  private closedDocId: string | null = null;
  private projectPath: string;
  private groupId: string;
  /** Open tabs and the shown file of every project/group that is not the active one. */
  private readonly tabsByScope = new Map<string, { tabs: string[]; active: string | null }>();
  /**
   * Unsaved edits of the projects that are not active, by project. Buffers are keyed by relative
   * path, so another project's file of the same name would overwrite them. Groups of the same
   * project share their buffers (it is the same file), so nothing is stashed between them.
   */
  private readonly unsavedByProject = new Map<string, Map<string, string>>();
  /** Files shown in the current project, whose in-memory buffer can be trusted. */
  private loadedPaths = new Set<string>();
  /** Bumped by every open and scope change: a disk read that finishes late is dropped. */
  private openRequest = 0;

  constructor(
    doc: Document,
    private readonly options: InspectorOptions,
  ) {
    const { stores } = options;
    const navigation = stores.navigation.getState();
    this.projectPath = navigation.projectPath;
    this.groupId = navigation.activeGroupId;

    this.element = doc.createElement("section");
    this.element.className =
      "coloride-zone-4-inspector bg-main border border-white/8 rounded-tr-[16px] rounded-br-[16px] flex flex-col h-full overflow-hidden";
    this.element.setAttribute("aria-label", UI_STRINGS.shell.inspector);
    this.element.style.minWidth = "0";
    this.element.style.overflow = "hidden";
    this.element.style.position = "relative";

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
      onOpenFile: (node) =>
        void this.openFile(node.path, (message) => this.tree.reportError(message)),
      onScroll: options.onTreeScroll,
    });

    const body = doc.createElement("div");
    body.className = "coloride-zone-4-body";
    body.append(editorColumn, this.tree.element);
    this.element.append(body);

    this.tabs = new HeaderTabs(doc, options.header, {
      ariaLabel: UI_STRINGS.shell.openFiles,
      dataKey: "path",
      closeLabel: uiText.closeTab,
      unsavedLabel: UI_STRINGS.editor.unsaved,
      onSelect: (path) => void this.openFile(path),
      onClose: (path) => this.requestCloseTab(path),
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
    if (z4.activeDocumentId !== this.closedDocId) {
      this.closedDocId = null;
      this.loadedPaths.add(z4.activeDocumentId);
      if (!this.openTabs.includes(z4.activeDocumentId)) {
        this.openTabs = [...this.openTabs, z4.activeDocumentId];
      }
    }
    const noFile = this.closedDocId !== null;
    // With no file shown (empty group, last tab closed) nothing of the previous file may linger.
    this.element.dataset.syncedChatId = z4.syncedChatId;
    this.element.dataset.activeDocumentId = noFile ? "" : z4.activeDocumentId;
    this.element.dataset.activeInspectorTab = z4.activeInspectorTab;
    this.element.dataset.unsavedChanges = String(!noFile && z4.hasUnsavedChanges);
    this.element.dataset.recoveredFromWal = String(z4.recoveredFromWal);
    this.renderTabs(noFile ? null : z4.activeDocumentId);

    const wasHidden = this.editorHost.style.display === "none";
    this.previewHost.style.display = "none";
    this.editorHost.style.display = noFile ? "none" : "block";
    this.empty.hidden = !noFile;
    if (!noFile && wasHidden) this.options.editorView.getEditorView().requestMeasure();
    this.updateTree();
  }

  updateTree(): void {
    const { stores } = this.options;
    // No selected row while no file is shown.
    const active = this.closedDocId === null ? stores.zone4.getState().activeDocumentId : "";
    this.tree.update(stores.zone2.getState().fileTree, active);
  }

  /** Called after every edit/save: refreshes the unsaved dot of the tabs. */
  setUnsaved(hasUnsavedChanges: boolean): void {
    this.element.dataset.unsavedChanges = String(hasUnsavedChanges && this.closedDocId === null);
    this.renderTabs(
      this.closedDocId !== null ? null : this.options.stores.zone4.getState().activeDocumentId,
    );
  }

  /** Whether a file is shown in the editor (false for an empty group or after the last tab). */
  isShowingFile(): boolean {
    return this.closedDocId === null;
  }

  reportError(message: string): void {
    this.options.header.title = message;
  }

  private scopeKey(projectPath = this.projectPath, groupId = this.groupId): string {
    return `${projectPath}\u0000${groupId}`;
  }

  /**
   * Swaps the open tabs when the active project or work group changes. A project change also
   * resets the tree view and keeps the leaving project's unsaved edits aside.
   */
  changeScope(projectPath: string, groupId: string): void {
    if (projectPath === this.projectPath && groupId === this.groupId) return;
    const { stores } = this.options;
    const activeId = stores.zone4.getState().activeDocumentId;
    this.tabsByScope.set(this.scopeKey(), {
      tabs: this.openTabs,
      active: this.closedDocId === null ? activeId : null,
    });

    const projectChanged = projectPath !== this.projectPath;
    if (projectChanged) {
      const unsaved = new Map<string, string>();
      const prefix = `${this.projectPath}\u0000`;
      for (const [key, scope] of this.tabsByScope) {
        if (!key.startsWith(prefix)) continue;
        for (const path of scope.tabs) {
          const content = stores.getDocumentContent(path);
          if (content !== undefined && stores.isDocumentUnsaved(path)) unsaved.set(path, content);
        }
      }
      this.unsavedByProject.set(this.projectPath, unsaved);
    }

    this.projectPath = projectPath;
    this.groupId = groupId;
    this.openRequest += 1;
    const saved = this.tabsByScope.get(this.scopeKey());
    this.openTabs = saved?.tabs ?? [];
    if (projectChanged) {
      this.loadedPaths = new Set();
      // Put back the edits this project had when it was left, so returning never reloads from disk.
      for (const [path, content] of this.unsavedByProject.get(projectPath) ?? []) {
        stores.updateInMemoryDocumentContent(path, content, true);
        this.loadedPaths.add(path);
      }
      this.tree.reset();
    }
    // The editor still holds the previous file: show the empty state until a file of this group is
    // shown (the one it had open is restored below).
    this.closedDocId = activeId;
    this.update();
    if (saved?.active) void this.openFile(saved.active);
  }

  /**
   * Shows a file and keeps it as a tab. A file already shown in this project keeps its
   * in-memory content (including unsaved edits); otherwise it is read from disk first.
   * Resolves to whether the file ended up shown: a read that fails, or that a later open or a
   * project/group change overtook, shows nothing.
   */
  openFile(
    path: string,
    onError: (message: string) => void = (m) => this.reportError(m),
  ): Promise<boolean> {
    const { stores, readWorkspaceFile } = this.options;
    this.openRequest += 1;
    const request = this.openRequest;
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
      return Promise.resolve(true);
    }
    return readWorkspaceFile(path).then(
      (content) => {
        if (request !== this.openRequest) return false;
        show(content);
        return true;
      },
      (error: unknown) => {
        if (request === this.openRequest) {
          onError(error instanceof Error ? error.message : UI_STRINGS.files.readFailed);
        }
        return false;
      },
    );
  }

  destroy(): void {
    this.tabs.destroy();
    this.tree.destroy();
    this.editorScrollbar?.destroy();
  }

  private renderTabs(activePath: string | null): void {
    const { stores } = this.options;
    this.tabs.update(
      this.openTabs.map((path): HeaderTabSpec => {
        const name = path.split("/").pop() || path;
        return {
          key: path,
          label: name,
          title: path,
          icon: { svg: fileTreeIconSvg(name), className: fileTreeIconColor(name) },
          selected: path === activePath,
          unsaved: stores.isDocumentUnsaved(path),
        };
      }),
    );
  }

  /** Closes a tab; one with unsaved changes first asks whether to save, discard or keep it. */
  private requestCloseTab(path: string): void {
    const { stores } = this.options;
    if (!stores.isDocumentUnsaved(path)) {
      this.closeTab(path);
      return;
    }
    const name = path.split("/").pop() || path;
    void askUnsavedChoice(this.element, name).then(async (choice) => {
      if (choice === "cancel") return;
      if (choice === "save") {
        try {
          // Only the shown document can be saved: bring the tab forward, and wait until it is.
          if (stores.zone4.getState().activeDocumentId !== path || this.closedDocId !== null) {
            if (!(await this.openFile(path))) return;
          }
          await this.options.saveActiveDocument();
        } catch (error: unknown) {
          this.reportError(error instanceof Error ? error.message : UI_STRINGS.editor.saveFailed);
          return; // keep the tab open: nothing is lost
        }
      } else {
        stores.discardDocumentBuffer(path);
        this.loadedPaths.delete(path);
      }
      this.closeTab(path);
    });
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
      void this.openFile(next);
    } else {
      this.closedDocId = path;
      this.update();
    }
  }
}
