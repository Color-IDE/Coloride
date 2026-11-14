import { UI_STRINGS } from "../../ui/ui-strings.js";
import { CODEX_ICON, TERMINAL_ICON } from "./panel-icons.js";

const CHEVRON_RIGHT =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6l-6 6"/></svg>';

export interface NewPanelMenuActions {
  /** A plain shell panel; absent when the host offers no terminal. */
  readonly openTerminal?: () => void;
  readonly openAgentInterface: () => void;
}

/**
 * The menu of the "+" button of Zone 3: a terminal, or an agent (Codex) that opens as an
 * interface or, later, as a terminal. The agent entry opens a second level to its right.
 */
export class NewPanelMenu {
  private menu: HTMLElement | null = null;
  private submenu: HTMLElement | null = null;
  private anchor: HTMLElement | null = null;
  private cleanup: (() => void) | null = null;

  constructor(private readonly doc: Document) {}

  isOpen(): boolean {
    return this.menu !== null;
  }

  toggle(anchor: HTMLElement, actions: NewPanelMenuActions): void {
    if (this.anchor === anchor) {
      this.close();
      return;
    }
    this.close(false);
    this.open(anchor, actions);
  }

  private item(
    label: string,
    run: (() => void) | null,
    hint?: string,
    icon?: string,
  ): HTMLButtonElement {
    const item = this.doc.createElement("button");
    item.type = "button";
    item.className = "coloride-new-panel-item";
    item.setAttribute("role", "menuitem");
    const text = this.doc.createElement("span");
    text.className = "coloride-new-panel-label";
    if (icon) {
      const glyph = this.doc.createElement("span");
      glyph.className = "coloride-new-panel-icon";
      glyph.innerHTML = icon;
      text.append(glyph);
    }
    text.append(label);
    item.append(text);
    if (hint) {
      const tag = this.doc.createElement("span");
      tag.className = "coloride-new-panel-hint";
      tag.textContent = hint;
      item.append(tag);
    }
    if (run) {
      item.addEventListener("click", () => {
        this.close();
        run();
      });
    } else {
      item.disabled = true;
    }
    return item;
  }

  private panel(label: string): HTMLElement {
    const panel = this.doc.createElement("div");
    panel.className = "coloride-new-panel-menu";
    panel.setAttribute("role", "menu");
    panel.setAttribute("aria-label", label);
    return panel;
  }

  private open(anchor: HTMLElement, actions: NewPanelMenuActions): void {
    const menu = this.panel(UI_STRINGS.chat.newMenu);
    if (actions.openTerminal) {
      menu.append(
        this.item(UI_STRINGS.chat.newTerminal, actions.openTerminal, undefined, TERMINAL_ICON),
      );
    }
    const agent = this.item(UI_STRINGS.chat.newAgent, null, undefined, CODEX_ICON);
    agent.disabled = false;
    agent.classList.add("has-submenu");
    agent.setAttribute("aria-haspopup", "menu");
    agent.setAttribute("aria-expanded", "false");
    const chevron = this.doc.createElement("span");
    chevron.className = "coloride-new-panel-chevron";
    chevron.innerHTML = CHEVRON_RIGHT;
    agent.append(chevron);
    const showSubmenu = () => {
      if (this.submenu) return;
      const sub = this.panel(UI_STRINGS.chat.newAgent);
      sub.classList.add("coloride-new-panel-submenu");
      sub.append(
        this.item(UI_STRINGS.chat.asInterface, actions.openAgentInterface),
        // An agent in a terminal must run inside the sandbox runner, which does not exist yet.
        this.item(UI_STRINGS.chat.asTerminal, null, UI_STRINGS.chat.soon),
      );
      for (const button of sub.querySelectorAll<HTMLButtonElement>("button:disabled")) {
        button.title = UI_STRINGS.chat.terminalNeedsIsolation;
      }
      this.doc.body.append(sub);
      const rect = agent.getBoundingClientRect();
      sub.style.left = `${rect.right + 4}px`;
      sub.style.top = `${rect.top - 4}px`;
      this.submenu = sub;
      agent.setAttribute("aria-expanded", "true");
      sub.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    };
    const hideSubmenu = () => {
      this.submenu?.remove();
      this.submenu = null;
      agent.setAttribute("aria-expanded", "false");
    };
    agent.addEventListener("click", showSubmenu);
    agent.addEventListener("pointerenter", showSubmenu);
    menu.append(agent);
    // Hovering another entry of the first level closes the second one.
    for (const other of menu.querySelectorAll<HTMLElement>(".coloride-new-panel-item")) {
      if (other !== agent) other.addEventListener("pointerenter", hideSubmenu);
    }

    this.doc.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left, this.doc.documentElement.clientWidth - 200))}px`;
    menu.style.top = `${rect.bottom + 6}px`;
    this.menu = menu;
    this.anchor = anchor;
    anchor.setAttribute("aria-expanded", "true");

    const keydown = (event: KeyboardEvent) => {
      const scope = this.submenu?.contains(this.doc.activeElement) ? this.submenu : menu;
      if (event.key === "Escape") {
        event.preventDefault();
        if (scope === this.submenu) {
          hideSubmenu();
          agent.focus();
        } else this.close();
      } else if (event.key === "ArrowRight" && this.doc.activeElement === agent) {
        event.preventDefault();
        showSubmenu();
      } else if (event.key === "ArrowLeft" && scope === this.submenu) {
        event.preventDefault();
        hideSubmenu();
        agent.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = Array.from(
          scope.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
        );
        const index = items.indexOf(this.doc.activeElement as HTMLButtonElement);
        const step = event.key === "ArrowDown" ? 1 : -1;
        items[(index + step + items.length) % items.length]?.focus();
      }
    };
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (menu.contains(target) || this.submenu?.contains(target) || anchor.contains(target))
        return;
      this.close(false);
    };
    this.doc.addEventListener("pointerdown", outside);
    this.doc.addEventListener("keydown", keydown);
    this.cleanup = () => {
      this.doc.removeEventListener("pointerdown", outside);
      this.doc.removeEventListener("keydown", keydown);
    };
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }

  close(restoreFocus = true): void {
    const anchor = this.anchor;
    this.cleanup?.();
    this.cleanup = null;
    this.submenu?.remove();
    this.submenu = null;
    this.menu?.remove();
    this.menu = null;
    this.anchor = null;
    anchor?.setAttribute("aria-expanded", "false");
    if (restoreFocus && anchor?.isConnected) anchor.focus();
  }
}
