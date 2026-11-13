import type {
  ActivityBarSection,
  CockpitPersonaMode,
  CockpitStoreBundle,
  Zone1ActivityState,
} from "../stores/index.js";
import { ACTIVITY_BAR_SVG_ICONS, type StatefulActivityIcon } from "../theme/index.js";
import { UI_STRINGS, uiText } from "../ui-strings.js";

const ACTIVITY_ITEMS: readonly {
  readonly section: ActivityBarSection;
  readonly icon: StatefulActivityIcon;
  readonly shortcut: string;
  readonly dividerBefore?: boolean;
}[] = [
  { section: "sessions", icon: ACTIVITY_BAR_SVG_ICONS.sessions, shortcut: "Cmd/Ctrl+1" },
  { section: "files", icon: ACTIVITY_BAR_SVG_ICONS.files, shortcut: "Cmd/Ctrl+2" },
  { section: "search", icon: ACTIVITY_BAR_SVG_ICONS.search, shortcut: "Cmd/Ctrl+3" },
  { section: "debug", icon: ACTIVITY_BAR_SVG_ICONS.debug, shortcut: "Cmd/Ctrl+5" },
  {
    section: "git",
    icon: ACTIVITY_BAR_SVG_ICONS.git,
    shortcut: "Cmd/Ctrl+4",
    dividerBefore: true,
  },
  { section: "mcp", icon: ACTIVITY_BAR_SVG_ICONS.mcp, shortcut: "Cmd/Ctrl+6" },
];

const PERSONAS: readonly CockpitPersonaMode[] = [
  "Create",
  "Learn",
  "Develop",
  "Infrastructure",
  "Data",
];

/** Zone 1: activity buttons and persona selector. Built once, then updated in place. */
export class ActivityBar {
  readonly element: HTMLElement;
  private readonly buttons = new Map<ActivityBarSection, HTMLButtonElement>();
  private readonly persona: HTMLSelectElement;

  constructor(doc: Document, stores: CockpitStoreBundle) {
    this.element = doc.createElement("nav");
    this.element.className =
      "coloride-zone-1-activity-bar bg-nav-rail flex flex-col items-center pt-1.5 pb-2.5 px-1 gap-1.5";
    this.element.setAttribute("aria-label", UI_STRINGS.shell.activityBar);
    this.element.style.width = "48px";
    this.element.style.minWidth = "48px";

    for (const item of ACTIVITY_ITEMS) {
      if (item.dividerBefore) {
        const divider = doc.createElement("div");
        divider.className = "coloride-activity-divider";
        divider.setAttribute("role", "separator");
        divider.setAttribute("aria-orientation", "horizontal");
        this.element.append(divider);
      }
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "coloride-activity-btn flex items-center justify-center";
      button.dataset.section = item.section;
      button.setAttribute(
        "aria-label",
        uiText.activityButton(UI_STRINGS.activity[item.section], item.shortcut),
      );
      button.addEventListener("click", () => stores.setActivitySection(item.section));
      this.buttons.set(item.section, button);
      this.element.append(button);
    }

    this.persona = doc.createElement("select");
    this.persona.className = "coloride-persona-selector";
    this.persona.setAttribute("aria-label", UI_STRINGS.persona.label);
    for (const mode of PERSONAS) {
      const option = doc.createElement("option");
      option.value = mode;
      option.textContent = UI_STRINGS.persona[mode];
      this.persona.append(option);
    }
    this.persona.addEventListener("change", () => {
      stores.setPersona(this.persona.value as CockpitPersonaMode);
    });
    this.element.append(this.persona);
  }

  update(z1: Zone1ActivityState): void {
    for (const item of ACTIVITY_ITEMS) {
      const button = this.buttons.get(item.section);
      if (!button) continue;
      const active = z1.activeSection === item.section;
      button.setAttribute("aria-pressed", String(active));
      const icon = active ? "active" : "inactive";
      if (button.dataset.icon !== icon) {
        button.innerHTML = item.icon[icon];
        button.dataset.icon = icon;
      }
    }
    if (this.persona.value !== z1.activePersona) this.persona.value = z1.activePersona;
  }
}
