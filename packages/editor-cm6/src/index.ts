// Coloride CodeMirror 6 Editor State & Decorations
import { COLORIDE_STATE_META, type ColorideValidationState } from "@coloride/protocol-types";

export interface EditorRangeDecoration {
  readonly fromLine: number;
  readonly toLine: number;
  readonly state: ColorideValidationState;
  readonly snapshotHash: string;
}

export function invalidateRangeOnLocalEdit(
  decoration: EditorRangeDecoration,
  editedLine: number,
): EditorRangeDecoration {
  if (
    decoration.state === "ValidatedGreen" &&
    editedLine >= decoration.fromLine &&
    editedLine <= decoration.toLine
  ) {
    return {
      ...decoration,
      state: "StaleOrange",
    };
  }
  return decoration;
}

export function describeDecorationAccessibleLabel(decoration: EditorRangeDecoration): string {
  const meta = COLORIDE_STATE_META[decoration.state];
  return `${meta.labelFr} (L${decoration.fromLine}-L${decoration.toLine})`;
}
