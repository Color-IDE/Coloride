export type ColorideValidationState =
  | "ValidatedGreen"
  | "ReviewYellow"
  | "FailedRed"
  | "StaleOrange"
  | "UnchangedBlue";

export interface ValidationBadgeMeta {
  readonly state: ColorideValidationState;
  readonly icon: "✓" | "!" | "✕" | "⟳" | "•";
  readonly labelFr: string;
  readonly labelEs: string;
}

export const COLORIDE_STATE_META: Record<ColorideValidationState, ValidationBadgeMeta> = {
  ValidatedGreen: {
    state: "ValidatedGreen",
    icon: "✓",
    labelFr: "✓ Validé",
    labelEs: "✓ Validado",
  },
  ReviewYellow: {
    state: "ReviewYellow",
    icon: "!",
    labelFr: "! À examiner",
    labelEs: "! Revisar",
  },
  FailedRed: {
    state: "FailedRed",
    icon: "✕",
    labelFr: "✕ Échec",
    labelEs: "✕ Fallo",
  },
  StaleOrange: {
    state: "StaleOrange",
    icon: "⟳",
    labelFr: "⟳ Validation périmée",
    labelEs: "⟳ Caducado",
  },
  UnchangedBlue: {
    state: "UnchangedBlue",
    icon: "•",
    labelFr: "• Source inchangée",
    labelEs: "• Sin cambios",
  },
};
