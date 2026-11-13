import { button } from "../dom-utils.js";
import { UI_STRINGS } from "../ui-strings.js";

export interface SidebarMenuAction {
  readonly label: string;
  readonly run: () => void;
  readonly disabled?: boolean;
}

export class SidebarMenu {
  private menu: HTMLElement | undefined;
  private anchor: HTMLButtonElement | undefined;
  private cleanup: (() => void) | undefined;

  constructor(private readonly host: HTMLElement) {}

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
    for (const action of actions) {
      const item = button(doc, "sidebar-menu-item");
      item.textContent = action.label;
      item.setAttribute("role", "menuitem");
      item.tabIndex = -1;
      item.disabled = action.disabled ?? false;
      item.addEventListener("click", () => {
        this.close();
        action.run();
      });
      menu.appendChild(item);
    }
    this.host.appendChild(menu);
    const hostRect = this.host.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    menu.style.top = `${anchorRect.bottom - hostRect.top + this.host.scrollTop + 2}px`;
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
    };
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!menu.contains(target) && !anchor.contains(target)) this.close(false);
    };
    doc.addEventListener("pointerdown", outside);
    menu.addEventListener("keydown", keydown);
    this.cleanup = () => {
      doc.removeEventListener("pointerdown", outside);
      menu.removeEventListener("keydown", keydown);
    };
    enabled()[0]?.focus();
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
