import { reconcile } from "../../ui/dom-utils.js";
import { attachHeaderScroll } from "./header-scroll.js";

const CLOSE_TAB_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

export interface HeaderTabIcon {
  /** SVG markup (file types). */
  readonly svg?: string;
  /** Plain text glyph (validation state). */
  readonly text?: string;
  /** Extra class on the icon, e.g. the file type color. */
  readonly className?: string;
}

export interface HeaderTabSpec {
  readonly key: string;
  readonly label: string;
  readonly title?: string;
  readonly icon?: HeaderTabIcon;
  readonly selected: boolean;
  readonly unsaved?: boolean;
  /** False disables the close button (the tab can still be selected). Default true. */
  readonly closable?: boolean;
  /** Extra `data-*` attributes, e.g. `{ validationState: "ReviewYellow" }`. */
  readonly data?: Readonly<Record<string, string>>;
}

export interface HeaderTabsOptions {
  readonly ariaLabel: string;
  /** Name of the `data-*` attribute carrying the tab key (`path`, `chatId`…). */
  readonly dataKey: string;
  readonly closeLabel: (label: string) => string;
  readonly unsavedLabel: string;
  readonly onSelect: (key: string) => void;
  readonly onClose: (key: string) => void;
  /**
   * Controls placed right after the strip (e.g. a "+" button). They sit outside the scrolling
   * area, so tabs never slide under them; the stylesheet keeps them next to the last tab.
   */
  readonly trailing?: readonly HTMLElement[];
}

interface TabNodes {
  readonly el: HTMLElement;
  readonly icon: HTMLElement;
  readonly label: HTMLElement;
  readonly dot: HTMLElement;
  readonly close: HTMLButtonElement;
  iconKey: string;
}

/**
 * The tab strip of a Zone 3 / Zone 4 header (open files, open sessions): icon, name, unsaved dot
 * and close button, with edge shadows and a thin scrollbar. Keyed by tab key and updated in place.
 */
export class HeaderTabs {
  private readonly track: HTMLElement;
  private readonly tabs = new Map<string, TabNodes>();
  private readonly releaseHeaderScroll: () => void;

  constructor(
    doc: Document,
    header: HTMLElement,
    private readonly options: HeaderTabsOptions,
  ) {
    this.track = doc.createElement("div");
    this.track.className = "coloride-header-tab-track";
    this.track.setAttribute("role", "tablist");
    // The strip can fill the whole header; Tauri drags the window only from an element that carries
    // the attribute itself, so the empty part of the strip must. Tabs and buttons are children and
    // stay clickable.
    this.track.setAttribute("data-tauri-drag-region", "");
    this.track.setAttribute("aria-label", options.ariaLabel);
    header.replaceChildren(this.track, ...(options.trailing ?? []));
    this.releaseHeaderScroll = attachHeaderScroll(header, this.track);
  }

  update(specs: readonly HeaderTabSpec[]): void {
    const wanted = new Set(specs.map((spec) => spec.key));
    for (const key of this.tabs.keys()) if (!wanted.has(key)) this.tabs.delete(key);
    let selectedTab: HTMLElement | null = null;
    const ordered = specs.map((spec) => {
      let tab = this.tabs.get(spec.key);
      if (!tab) {
        tab = this.createTab(spec.key);
        this.tabs.set(spec.key, tab);
      }
      this.render(tab, spec);
      if (spec.selected) selectedTab = tab.el;
      return tab.el;
    });
    reconcile(this.track, ordered);
    (selectedTab as HTMLElement | null)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  destroy(): void {
    this.releaseHeaderScroll();
  }

  private render(tab: TabNodes, spec: HeaderTabSpec): void {
    const { el } = tab;
    el.title = spec.title ?? spec.label;
    el.setAttribute("aria-selected", String(spec.selected));
    for (const [name, value] of Object.entries(spec.data ?? {})) el.dataset[name] = value;

    if (tab.label.textContent !== spec.label) tab.label.textContent = spec.label;

    tab.close.setAttribute("aria-label", this.options.closeLabel(spec.label));
    tab.close.disabled = spec.closable === false;

    const iconKey = `${spec.icon?.className ?? ""}|${spec.icon?.svg ?? ""}|${spec.icon?.text ?? ""}`;
    if (tab.iconKey !== iconKey) {
      tab.iconKey = iconKey;
      tab.icon.className = `coloride-header-tab-icon ${spec.icon?.className ?? ""}`.trim();
      if (spec.icon?.svg) tab.icon.innerHTML = spec.icon.svg;
      else tab.icon.textContent = spec.icon?.text ?? "";
    }

    tab.dot.hidden = !spec.unsaved;
    if (spec.unsaved) el.dataset.unsavedChanges = "true";
    else delete el.dataset.unsavedChanges;
  }

  private createTab(key: string): TabNodes {
    const doc = this.track.ownerDocument;
    const { onSelect, onClose, dataKey, unsavedLabel } = this.options;
    const el = doc.createElement("div");
    el.className = "coloride-header-tab";
    el.setAttribute("role", "tab");
    el.tabIndex = 0;
    el.dataset[dataKey] = key;

    const icon = doc.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    const label = doc.createElement("span");
    label.className = "coloride-header-tab-label";
    const dot = doc.createElement("span");
    dot.className = "coloride-header-tab-dot";
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", unsavedLabel);
    dot.hidden = true;
    const close = doc.createElement("button");
    close.type = "button";
    close.className = "coloride-header-tab-close";
    close.innerHTML = CLOSE_TAB_ICON;
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!close.disabled) onClose(key);
    });
    el.append(icon, label, dot, close);

    el.addEventListener("click", () => onSelect(key));
    el.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.target !== el) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelect(key);
      }
    });
    // Middle click closes, like most editors.
    el.addEventListener("auxclick", (event: MouseEvent) => {
      if (event.button !== 1) return;
      event.preventDefault();
      if (!close.disabled) onClose(key);
    });
    return { el, icon, label, dot, close, iconKey: "\u0000" };
  }
}
