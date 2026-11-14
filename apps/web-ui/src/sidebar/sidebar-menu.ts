import { button } from "../ui/dom-utils.js";
import { UI_STRINGS } from "../ui/ui-strings.js";
import { type MenuBounds, placeMenu } from "./menu-placement.js";

export interface SidebarMenuAction {
  readonly label: string;
  readonly run: () => void;
  readonly disabled?: boolean;
  /** Why the entry is disabled; shown as its tooltip. */
  readonly reason?: string;
  /** A destructive entry: drawn in red. */
  readonly danger?: boolean;
  /** Draws a line above this entry, to group the entries that belong together. */
  readonly separatorBefore?: boolean;
  /** An icon (14 px SVG markup) shown before the label. */
  readonly icon?: string;
  /** A shortcut or other short note, shown at the end of the row. */
  readonly hint?: string;
}

/** Room the menu may use: the visible part of the sidebar, within the window. */
function visibleBounds(host: HTMLElement): MenuBounds {
  const doc = host.ownerDocument;
  const view = host.closest<HTMLElement>(".coloride-zone-2-viewport") ?? host;
  const rect = view.getBoundingClientRect();
  const windowHeight = doc.defaultView?.innerHeight ?? doc.documentElement.clientHeight;
  const top = Math.max(0, rect.top);
  const bottom = rect.height > 0 ? Math.min(windowHeight, rect.bottom) : windowHeight;
  return { top, bottom };
}

export class SidebarMenu {
  private menu: HTMLElement | undefined;
  private anchor: HTMLButtonElement | undefined;
  private cleanup: (() => void) | undefined;

  constructor(private readonly host: HTMLElement) {}

  isOpen(): boolean {
    return this.menu !== undefined;
  }

  open(anchor: HTMLButtonElement, actions: readonly SidebarMenuAction[]): void {
    const same = this.anchor === anchor;
    this.close(false);
    if (same) return;
    const doc = this.host.ownerDocument;
    const menu = doc.createElement("div");
    menu.className = "sidebar-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute(
      "aria-label",
      anchor.getAttribute("aria-label") ?? UI_STRINGS.sidebar.options,
    );
    this.anchor = anchor;
    this.menu = menu;
    anchor.setAttribute("aria-expanded", "true");
    const hasIcons = actions.some((action) => action.icon);
    for (const action of actions) {
      if (action.separatorBefore) {
        const line = doc.createElement("div");
        line.className = "sidebar-menu-separator";
        line.setAttribute("role", "separator");
        menu.appendChild(line);
      }
      const item = button(doc, "sidebar-menu-item");
      if (action.danger) item.classList.add("sidebar-menu-item--danger");
      const main = doc.createElement("span");
      main.className = "sidebar-menu-label";
      // Entries without an icon keep the same gap when the others have one, so labels line up.
      if (hasIcons) {
        const icon = doc.createElement("span");
        icon.className = "sidebar-menu-icon";
        icon.setAttribute("aria-hidden", "true");
        if (action.icon) icon.innerHTML = action.icon;
        main.appendChild(icon);
      }
      main.append(action.label);
      item.appendChild(main);
      if (action.hint) {
        const hint = doc.createElement("span");
        hint.className = "sidebar-menu-hint";
        hint.textContent = action.hint;
        item.appendChild(hint);
      }
      item.setAttribute("role", "menuitem");
      item.tabIndex = -1;
      item.disabled = action.disabled ?? false;
      if (item.disabled && action.reason) item.title = action.reason;
      item.addEventListener("click", () => {
        this.close();
        action.run();
      });
      menu.appendChild(item);
    }
    this.host.appendChild(menu);
    this.place(menu, anchor);

    const enabled = () =>
      Array.from(menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const items = enabled();
        const index = items.indexOf(doc.activeElement as HTMLButtonElement);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      } else if (event.key === "Tab") this.close(false);
      else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        // Typing a letter jumps to the next entry that starts with it.
        const items = enabled();
        const start = items.indexOf(doc.activeElement as HTMLButtonElement) + 1;
        const letter = event.key.toLowerCase();
        const ordered = [...items.slice(start), ...items.slice(0, start)];
        const match = ordered.find((item) =>
          item.textContent?.trim().toLowerCase().startsWith(letter),
        );
        if (match) {
          event.preventDefault();
          match.focus();
        }
      }
    };
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!menu.contains(target) && !anchor.contains(target)) this.close(false);
    };
    // Scrolling the sidebar or resizing the window moves the anchor away from the menu.
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && menu.contains(event.target)) return;
      this.close(false);
    };
    const view = doc.defaultView;
    doc.addEventListener("pointerdown", outside);
    doc.addEventListener("scroll", dismiss, true);
    view?.addEventListener("resize", dismiss);
    view?.addEventListener("blur", dismiss);
    menu.addEventListener("keydown", keydown);
    this.cleanup = () => {
      doc.removeEventListener("pointerdown", outside);
      doc.removeEventListener("scroll", dismiss, true);
      view?.removeEventListener("resize", dismiss);
      view?.removeEventListener("blur", dismiss);
      menu.removeEventListener("keydown", keydown);
    };
    enabled()[0]?.focus();
  }

  /** Puts the menu under its button, or above it when it does not fit below. */
  private place(menu: HTMLElement, anchor: HTMLElement): void {
    const hostRect = this.host.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const height = menu.offsetHeight || menu.getBoundingClientRect().height;
    const placement = placeMenu({
      anchor: { top: anchorRect.top, bottom: anchorRect.bottom },
      height,
      bounds: visibleBounds(this.host),
    });
    menu.dataset.placement = placement.side;
    if (placement.maxHeight !== undefined) {
      menu.style.maxHeight = `${placement.maxHeight}px`;
      menu.style.overflowY = "auto";
    }
    const shown =
      placement.maxHeight !== undefined ? Math.min(height, placement.maxHeight) : height;
    const scrolled = this.host.scrollTop;
    menu.style.top =
      placement.side === "below"
        ? `${anchorRect.bottom - hostRect.top + scrolled + 2}px`
        : `${anchorRect.top - hostRect.top + scrolled - shown - 2}px`;
  }

  closeIfDetached(): void {
    if (this.anchor && !this.anchor.isConnected) this.close(false);
  }

  close(restoreFocus = true): void {
    const anchor = this.anchor;
    this.cleanup?.();
    this.cleanup = undefined;
    this.menu?.remove();
    this.menu = undefined;
    this.anchor = undefined;
    anchor?.setAttribute("aria-expanded", "false");
    if (restoreFocus && anchor?.isConnected) anchor.focus();
  }
}
