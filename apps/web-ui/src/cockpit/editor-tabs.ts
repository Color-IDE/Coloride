import { reconcile } from "../dom-utils.js";
import { fileTreeIconColor, fileTreeIconSvg } from "../theme/file-tree-icons.js";
import { UI_STRINGS, uiText } from "../ui-strings.js";
import { attachHeaderScroll } from "./header-scroll.js";

const CLOSE_TAB_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

interface TabNodes {
  readonly el: HTMLElement;
  readonly dot: HTMLElement;
}

export interface EditorTabsHandlers {
  readonly open: (path: string) => void;
  readonly close: (path: string) => void;
}

/** The open-file tabs in the Zone 4 header. Keyed by path and updated in place. */
export class EditorTabs {
  private readonly track: HTMLElement;
  private readonly tabs = new Map<string, TabNodes>();
  private readonly releaseHeaderScroll: () => void;

  constructor(
    doc: Document,
    header: HTMLElement,
    private readonly handlers: EditorTabsHandlers,
  ) {
    this.track = doc.createElement("div");
    this.track.className = "coloride-inspector-tab-track";
    this.track.setAttribute("role", "tablist");
    this.track.setAttribute("aria-label", UI_STRINGS.shell.openFiles);
    header.replaceChildren(this.track);
    this.releaseHeaderScroll = attachHeaderScroll(header, this.track);
  }

  /** `activePath` is null when no file is shown (every tab closed, or a project switch). */
  update(
    paths: readonly string[],
    activePath: string | null,
    unsavedPaths: ReadonlySet<string>,
  ): void {
    const wanted = new Set(paths);
    for (const path of this.tabs.keys()) if (!wanted.has(path)) this.tabs.delete(path);
    let activeTab: HTMLElement | null = null;
    const ordered = paths.map((path) => {
      let tab = this.tabs.get(path);
      if (!tab) {
        tab = this.createTab(path);
        this.tabs.set(path, tab);
      }
      const active = path === activePath;
      tab.el.setAttribute("aria-selected", String(active));
      const unsaved = unsavedPaths.has(path);
      tab.dot.hidden = !unsaved;
      if (unsaved) tab.el.dataset.unsavedChanges = "true";
      else delete tab.el.dataset.unsavedChanges;
      if (active) activeTab = tab.el;
      return tab.el;
    });
    reconcile(this.track, ordered);
    (activeTab as HTMLElement | null)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  destroy(): void {
    this.releaseHeaderScroll();
  }

  private createTab(path: string): TabNodes {
    const doc = this.track.ownerDocument;
    const name = path.split("/").pop() || path;
    const el = doc.createElement("div");
    el.className = "coloride-inspector-tab";
    el.setAttribute("role", "tab");
    el.tabIndex = 0;
    el.title = path;
    el.dataset.path = path;

    const icon = doc.createElement("span");
    icon.className = `coloride-inspector-tab-icon ${fileTreeIconColor(name)}`;
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = fileTreeIconSvg(name);
    const label = doc.createElement("span");
    label.className = "coloride-tab-label";
    label.textContent = name;
    const dot = doc.createElement("span");
    dot.className = "coloride-inspector-unsaved-dot";
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", UI_STRINGS.editor.unsaved);
    dot.hidden = true;
    const close = doc.createElement("button");
    close.type = "button";
    close.className = "coloride-inspector-tab-close";
    close.setAttribute("aria-label", uiText.closeTab(name));
    close.innerHTML = CLOSE_TAB_ICON;
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      this.handlers.close(path);
    });
    el.append(icon, label, dot, close);

    el.addEventListener("click", () => this.handlers.open(path));
    el.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.target !== el) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.handlers.open(path);
      }
    });
    // Middle click closes, like most editors.
    el.addEventListener("auxclick", (event: MouseEvent) => {
      if (event.button !== 1) return;
      event.preventDefault();
      this.handlers.close(path);
    });
    return { el, dot };
  }
}
