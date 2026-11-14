import { AtomicStore } from "./atomic-store.js";
import { PANEL_DIMENSIONS, type PanelSide } from "./panel-geometry.js";
export type { PanelSide } from "./panel-geometry.js";

export const UI_PREFERENCES_KEY = "coloride.uiPreferences.v1";
export interface UiPreferencesState {
  readonly sidebarWidthPx: number | null;
  readonly inspectorWidthPx: number | null;
  readonly treeHidden: boolean;
}
type PreferencesStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const DEFAULTS: UiPreferencesState = {
  sidebarWidthPx: null,
  inspectorWidthPx: null,
  treeHidden: false,
};
const LEGACY_KEYS = {
  sidebarWidthPx: "coloride.sidebarWidthPx",
  inspectorWidthPx: "coloride.inspectorWidthPx",
  treeHidden: "coloride.treeHidden",
} as const;

/** Storage can be denied even when accessing the localStorage property itself. */
export function browserStorage(doc: Document): Storage | undefined {
  try {
    return doc.defaultView?.localStorage;
  } catch {
    return undefined;
  }
}
function width(value: unknown, panel: PanelSide): number | null {
  const { minPx, maxPx } = PANEL_DIMENSIONS[panel];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(minPx, Math.min(maxPx, Math.round(value)))
    : null;
}
function read(storage?: PreferencesStorage): UiPreferencesState {
  try {
    const raw = storage?.getItem(UI_PREFERENCES_KEY);
    const data = raw
      ? JSON.parse(raw)
      : {
          sidebarWidthPx: Number(storage?.getItem(LEGACY_KEYS.sidebarWidthPx)),
          inspectorWidthPx: Number(storage?.getItem(LEGACY_KEYS.inspectorWidthPx)),
          treeHidden: storage?.getItem(LEGACY_KEYS.treeHidden) === "true",
        };
    if (!data || typeof data !== "object" || Array.isArray(data)) return DEFAULTS;
    return {
      sidebarWidthPx: width(data.sidebarWidthPx, "sidebar"),
      inspectorWidthPx: width(data.inspectorWidthPx, "inspector"),
      treeHidden: data.treeHidden === true,
    };
  } catch {
    return DEFAULTS;
  }
}
/** One versioned, validated persistence boundary for viewer-only UI preferences. */
export class UiPreferences extends AtomicStore<UiPreferencesState> {
  constructor(private readonly storage?: PreferencesStorage) {
    super(read(storage));
    // Remove legacy keys only after the consolidated value is safely written.
    this.persist();
  }
  setPanelWidth(panel: PanelSide, value: number | null, remember = true): void {
    const key = panel === "sidebar" ? "sidebarWidthPx" : "inspectorWidthPx";
    const next = value === null ? null : width(value, panel);
    this.setState((previous) => (previous[key] === next ? previous : { ...previous, [key]: next }));
    if (remember) this.persist();
  }
  setTreeHidden(hidden: boolean): void {
    this.setState((previous) =>
      previous.treeHidden === hidden ? previous : { ...previous, treeHidden: hidden },
    );
    this.persist();
  }
  private persist(): void {
    try {
      this.storage?.setItem(UI_PREFERENCES_KEY, JSON.stringify(this.getState()));
      for (const key of Object.values(LEGACY_KEYS)) this.storage?.removeItem(key);
    } catch {
      /* Preferences remain usable in memory if storage is denied or full. */
    }
  }
}
