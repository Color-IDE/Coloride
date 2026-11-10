import type {
  CockpitChatTab,
  CockpitGridMode,
  CockpitPersonaMode,
  InspectorTab,
} from "./stores.js";

export * from "./stores.js";
export * from "./stream-renderer.js";
export * from "./virtualizer.js";
export * from "./cockpit-dom.js";

export interface CockpitShellState {
  readonly activePersona: CockpitPersonaMode;
  readonly gridMode: CockpitGridMode;
  readonly activeInspectorTab: InspectorTab;
  readonly chats: readonly CockpitChatTab[];
}

export function createInitialCockpitShellState(): CockpitShellState {
  return {
    activePersona: "Develop",
    gridMode: 1,
    activeInspectorTab: "code-diff",
    chats: [],
  };
}
