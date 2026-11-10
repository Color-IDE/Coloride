import type { ColorideValidationState } from "@coloride/protocol-types";

export type CockpitGridMode = 1 | 2 | 4 | 8;

export type CockpitPersonaMode = "Create" | "Learn" | "Develop" | "Infrastructure" | "Data";

export interface CockpitChatTab {
  readonly chatId: string;
  readonly title: string;
  readonly modelName: string;
  readonly validationState: ColorideValidationState;
}

export interface CockpitShellState {
  readonly activePersona: CockpitPersonaMode;
  readonly gridMode: CockpitGridMode;
  readonly activeInspectorTab: "preview" | "code-diff";
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
