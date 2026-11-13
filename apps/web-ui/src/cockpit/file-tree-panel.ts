import {
  EXPLORER_ROW_HEIGHT_PX,
  type ExplorerTreeOptions,
  ExplorerTreeRenderer,
  visibleExplorerNodes,
} from "../explorer-tree.js";
import type { CockpitFileTreeNode } from "../stores/index.js";
import { type ThinScrollbar, attachThinScrollbar } from "../thin-scrollbar.js";
import { UI_STRINGS } from "../ui-strings.js";

const DEFAULT_VIEWPORT_HEIGHT_PX = 600;

export interface FileTreePanelOptions {
  /** Extra class on the root element, to place and style each instance. */
  readonly className: string;
  readonly withFilter: boolean;
  readonly onOpenFile: (node: CockpitFileTreeNode) => void;
  /** Replaces the "No project open" message, e.g. with an "Open folder" button. */
  readonly emptyAction?: { readonly label: string; readonly run: () => Promise<void> };
  /** Called (at most once per frame) after the user scrolls the tree. */
  readonly onScroll?: (scrollTopPx: number, viewportHeightPx: number) => void;
}

/** Files whose path matches `filter` plus the folders that lead to them. */
export function filterFileTree(
  nodes: readonly CockpitFileTreeNode[],
  filter: string,
): readonly CockpitFileTreeNode[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return nodes;
  const matching = nodes.filter(
    (node) => !node.isDirectory && node.path.toLowerCase().includes(needle),
  );
  const keep = new Set(matching.map((node) => node.path));
  for (const node of matching) {
    const parts = node.path.split("/");
    for (let i = 1; i < parts.length; i += 1) keep.add(parts.slice(0, i).join("/"));
  }
  return nodes.filter((node) => keep.has(node.path));
}

/**
 * The project file tree used everywhere it appears (sidebar and inspector): optional filter,
 * collapsible folders, sticky parent folders, virtualized rows and the thin scrollbar.
 * Each instance keeps its own scroll position, filter and collapsed folders.
 */
export class FileTreePanel {
  readonly element: HTMLElement;
  private readonly filterEl: HTMLInputElement | null = null;
  private readonly scrollEl: HTMLElement;
  private readonly treeEl: HTMLElement;
  private readonly stickyEl: HTMLElement;
  private readonly renderer = new ExplorerTreeRenderer();
  private readonly scrollbar: ThinScrollbar;
  private readonly collapsed = new Set<string>();
  private filter = "";
  private nodes: readonly CockpitFileTreeNode[] = [];
  private activePath = "";
  private scrollTopPx = 0;
  private viewportHeightPx = DEFAULT_VIEWPORT_HEIGHT_PX;
  private shown: {
    readonly nodes: readonly CockpitFileTreeNode[];
    readonly options: ExplorerTreeOptions;
  } | null = null;
  private scrollFrame = 0;

  constructor(
    doc: Document,
    private readonly options: FileTreePanelOptions,
  ) {
    this.element = doc.createElement("div");
    this.element.className = `coloride-file-tree-panel ${options.className}`;
    this.element.setAttribute("aria-label", UI_STRINGS.files.tree);

    if (options.withFilter) {
      const filterEl = doc.createElement("input");
      filterEl.type = "search";
      filterEl.className = "coloride-file-tree-filter";
      filterEl.placeholder = UI_STRINGS.files.filter;
      filterEl.setAttribute("aria-label", UI_STRINGS.files.filterLabel);
      filterEl.addEventListener("input", () => {
        this.filter = filterEl.value;
        this.setScrollTop(0);
        this.render();
      });
      filterEl.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key !== "Escape" || !filterEl.value) return;
        event.stopPropagation();
        filterEl.value = "";
        filterEl.dispatchEvent(new Event("input"));
      });
      this.filterEl = filterEl;
      this.element.append(filterEl);
    }

    const viewport = doc.createElement("div");
    viewport.className = "coloride-file-tree-viewport";
    this.scrollEl = doc.createElement("div");
    this.scrollEl.className = "coloride-file-tree-scroll";
    this.treeEl = doc.createElement("div");
    this.treeEl.className = "coloride-file-tree";
    this.scrollEl.append(this.treeEl);
    this.stickyEl = doc.createElement("div");
    this.stickyEl.className = "coloride-file-tree-sticky";
    this.stickyEl.hidden = true;
    viewport.append(this.scrollEl, this.stickyEl);
    this.element.append(viewport);
    this.scrollbar = attachThinScrollbar(viewport, this.scrollEl, "y");

    this.scrollEl.addEventListener("scroll", () => {
      this.scrollTopPx = this.scrollEl.scrollTop;
      this.renderSticky();
      if (this.scrollFrame) return;
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = 0;
        this.viewportHeightPx = this.scrollEl.clientHeight || this.viewportHeightPx;
        this.render();
        this.options.onScroll?.(this.scrollTopPx, this.viewportHeightPx);
      });
    });
    this.render();
  }

  update(nodes: readonly CockpitFileTreeNode[], activePath: string): void {
    this.nodes = nodes;
    this.activePath = activePath;
    this.render();
  }

  /** Programmatic scroll (also used by tests, where there is no layout). */
  scrollTo(scrollTopPx: number, viewportHeightPx = this.viewportHeightPx): void {
    this.viewportHeightPx = viewportHeightPx;
    this.setScrollTop(scrollTopPx);
    this.render();
  }

  /** Forgets the filter, collapsed folders and scroll position (e.g. on a project switch). */
  reset(): void {
    this.collapsed.clear();
    this.filter = "";
    if (this.filterEl) this.filterEl.value = "";
    this.setScrollTop(0);
    this.render();
  }

  reportError(message: string): void {
    this.element.title = message;
  }

  destroy(): void {
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
    this.scrollbar.destroy();
  }

  private setScrollTop(scrollTopPx: number): void {
    this.scrollTopPx = scrollTopPx;
    this.scrollEl.scrollTop = scrollTopPx;
  }

  private showMessage(text: string): void {
    const doc = this.treeEl.ownerDocument;
    const action = this.options.emptyAction;
    if (this.nodes.length === 0 && action) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "coloride-open-workspace-btn";
      button.textContent = action.label;
      button.addEventListener("click", () => {
        button.disabled = true;
        button.textContent = UI_STRINGS.files.opening;
        void action
          .run()
          .catch((error: unknown) => {
            button.textContent =
              error instanceof Error ? error.message : UI_STRINGS.files.openFailed;
            button.title = button.textContent;
          })
          .finally(() => {
            button.disabled = false;
            if (button.textContent === UI_STRINGS.files.opening) button.textContent = action.label;
          });
      });
      this.treeEl.replaceChildren(button);
    } else {
      const empty = doc.createElement("p");
      empty.className = "coloride-file-tree-empty";
      empty.textContent = text;
      this.treeEl.replaceChildren(empty);
    }
    this.shown = null;
    this.stickyEl.hidden = true;
  }

  private render(): void {
    if (this.nodes.length === 0) {
      this.showMessage(UI_STRINGS.files.noProject);
      return;
    }
    const filtering = this.filter.trim() !== "";
    const matched = filterFileTree(this.nodes, this.filter);
    if (matched.length === 0) {
      this.showMessage(UI_STRINGS.files.noMatch);
      return;
    }
    // While filtering, every folder on the way to a match stays open.
    const nodes = filtering ? matched : visibleExplorerNodes(matched, this.collapsed);
    const options: ExplorerTreeOptions = {
      activePath: this.activePath,
      collapsed: filtering ? new Set<string>() : this.collapsed,
      onOpenFile: (node) => this.options.onOpenFile(node),
      onToggleDirectory: (node) => {
        if (!this.collapsed.delete(node.path)) this.collapsed.add(node.path);
        this.render();
      },
    };
    this.renderer.renderInto(this.treeEl, nodes, this.scrollTopPx, this.viewportHeightPx, options);
    this.shown = { nodes, options };
    this.renderSticky();
  }

  /** Pins the parent folders of the first visible row; driven by the real scroll position. */
  private renderSticky(): void {
    if (!this.shown) {
      this.stickyEl.hidden = true;
      return;
    }
    this.renderer.renderSticky(
      this.stickyEl,
      this.shown.nodes,
      this.scrollTopPx,
      this.shown.options,
      (index, level) => {
        // Put the folder right below the rows still pinned above it.
        this.setScrollTop(Math.max(0, (index - level) * EXPLORER_ROW_HEIGHT_PX));
        this.render();
      },
    );
  }
}
