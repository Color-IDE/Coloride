import type { CockpitChatTab, CockpitPersonaMode, InspectorTab } from "./stores.js";

export * from "./stores.js";
export * from "./stream-renderer.js";
export * from "./virtualizer.js";
export * from "./cockpit-dom.js";
export * from "./onboarding/index.js";
export * from "./theme/index.js";

export interface CockpitShellState {
  readonly activePersona: CockpitPersonaMode;
  readonly activeInspectorTab: InspectorTab;
  readonly chats: readonly CockpitChatTab[];
}

export function createInitialCockpitShellState(): CockpitShellState {
  return {
    activePersona: "Develop",
    activeInspectorTab: "code-diff",
    chats: [],
  };
}
