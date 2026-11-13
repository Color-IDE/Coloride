import { attribute, button, label, visibility } from "../dom-utils.js";
import { UI_STRINGS } from "../ui-strings.js";
import { CHEVRON_ICON, MORE_ICON, PLUS_ICON } from "./icons.js";

export interface SidebarRowOptions {
  readonly kind: "folder" | "group" | "session";
  readonly onSelect: () => void;
  readonly onToggle?: () => void;
  readonly onMore: (anchor: HTMLButtonElement) => void;
  /** Adds a "+" next to the options button (shown on hover). */
  readonly onAdd?: () => void;
  /** Accessible name prefix and tooltip of the "+" (a new session unless told otherwise). */
  readonly addLabel?: { readonly aria: string; readonly title: string };
  readonly icon?: string;
}

/** A session's number ("#16") and its name, when the title starts with one. */
export function splitSessionNumber(title: string): { number: string | null; name: string } {
  const match = /^(#\d+)\s+(.+)$/.exec(title);
  return match
    ? { number: match[1] ?? null, name: match[2] ?? title }
    : { number: null, name: title };
}

/** All row controls are siblings: options never activate selection or expansion. */
export class SidebarRow {
  readonly el: HTMLDivElement;
  readonly select: HTMLButtonElement;
  readonly more: HTMLButtonElement;
  readonly add: HTMLButtonElement | undefined;
  readonly toggle: HTMLButtonElement | undefined;
  private readonly title: HTMLSpanElement;
  /** The session number, on the right of the row (session rows only). */
  private readonly badge: HTMLSpanElement | undefined;
  private readonly arrow: HTMLSpanElement;
  private renameInput: HTMLInputElement | undefined;
  private readonly addLabel: { readonly aria: string; readonly title: string };

  constructor(doc: Document, options: SidebarRowOptions) {
    this.addLabel = options.addLabel ?? {
      aria: UI_STRINGS.chat.newSessionIn,
      title: UI_STRINGS.chat.newSession,
    };
    this.el = doc.createElement("div");
    this.el.className = `sidebar-row sidebar-row--${options.kind}`;
    this.select = button(doc, "sidebar-row-select");
    this.title = doc.createElement("span");
    this.title.className = "sidebar-row-title";
    this.select.appendChild(this.title);
    if (options.kind === "session") {
      this.badge = doc.createElement("span");
      this.badge.className = "sidebar-row-badge";
      this.badge.setAttribute("aria-hidden", "true");
      this.select.appendChild(this.badge);
    }
    this.select.addEventListener("click", options.onSelect);
    this.arrow = doc.createElement("span");
    this.arrow.className = "sidebar-chevron";
    this.arrow.innerHTML = CHEVRON_ICON;
    if (options.kind === "group") {
      this.toggle = button(doc, "sidebar-icon-button sidebar-group-toggle");
      const icon = doc.createElement("span");
      icon.className = "sidebar-group-icon";
      icon.innerHTML = options.icon ?? "";
      icon.setAttribute("aria-hidden", "true");
      this.toggle.append(icon, this.arrow);
      this.toggle.addEventListener("click", options.onToggle ?? options.onSelect);
      this.el.appendChild(this.toggle);
    } else if (options.kind === "folder") {
      this.select.appendChild(this.arrow);
      this.el.addEventListener("click", (event) => {
        if (event.target === this.el) this.select.click();
      });
    }
    this.more = button(doc, "sidebar-icon-button sidebar-more");
    this.more.innerHTML = MORE_ICON;
    this.more.setAttribute("aria-haspopup", "menu");
    this.more.setAttribute("aria-expanded", "false");
    this.more.addEventListener("click", () => options.onMore(this.more));
    if (options.onAdd) {
      this.add = button(doc, "sidebar-icon-button sidebar-add");
      this.add.innerHTML = PLUS_ICON;
      this.add.addEventListener("click", options.onAdd);
      this.el.append(this.select, this.add, this.more);
    } else {
      this.el.append(this.select, this.more);
    }
  }

  /** A small icon before the title of a session row (a terminal's, for instance); null removes it. */
  setIcon(svg: string | null): void {
    let icon = this.select.querySelector<HTMLElement>(".sidebar-row-icon");
    if (svg === null) {
      icon?.remove();
      return;
    }
    if (!icon) {
      icon = this.el.ownerDocument.createElement("span");
      icon.className = "sidebar-row-icon";
      icon.setAttribute("aria-hidden", "true");
      this.select.insertBefore(icon, this.select.firstChild);
    }
    if (icon.dataset.svg !== svg) {
      icon.dataset.svg = svg;
      icon.innerHTML = svg;
    }
  }

  update(title: string, selected: boolean, expanded?: boolean): void {
    // A session titled "#16 New session" shows its name, with the number on the right.
    const shown = this.badge ? splitSessionNumber(title) : { number: null, name: title };
    label(this.title, shown.name);
    if (this.badge) {
      label(this.badge, shown.number ?? "");
      this.badge.hidden = shown.number === null;
    }
    attribute(this.select, "title", title);
    attribute(this.more, "aria-label", `Options for ${title}`);
    if (this.add) {
      attribute(this.add, "aria-label", `${this.addLabel.aria} ${title}`);
      attribute(this.add, "title", this.addLabel.title);
    }
    attribute(this.el, "data-selected", String(selected));
    if (expanded !== undefined) {
      attribute(this.toggle ?? this.select, "aria-expanded", String(expanded));
      attribute(this.arrow, "data-expanded", String(expanded));
      if (this.toggle)
        attribute(
          this.toggle,
          "aria-label",
          `${expanded ? UI_STRINGS.sidebar.collapse : UI_STRINGS.sidebar.expand} ${title}`,
        );
    } else {
      attribute(this.select, "aria-pressed", String(selected));
    }
  }

  rename(value: string, commit: (value: string) => void): void {
    if (this.renameInput) {
      this.renameInput.focus();
      return;
    }
    const input = this.el.ownerDocument.createElement("input");
    this.renameInput = input;
    input.className = "sidebar-rename-input";
    input.value = value;
    input.maxLength = 80;
    input.setAttribute("aria-label", UI_STRINGS.sidebar.name);
    const finish = (save: boolean) => {
      if (this.renameInput !== input) return;
      this.renameInput = undefined;
      input.remove();
      visibility(this.select, true);
      if (save && input.value.trim()) commit(input.value.trim());
      this.select.focus();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        finish(event.key === "Enter");
      }
    });
    input.addEventListener("blur", () => finish(false));
    visibility(this.select, false);
    this.el.insertBefore(input, this.add ?? this.more);
    input.focus();
    input.select();
  }
}
