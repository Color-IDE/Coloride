import {
  type EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, GutterMarker, gutter } from "@codemirror/view";
import { COLORIDE_STATE_META, type ColorideValidationState } from "@coloride/protocol-types";

export interface EditorRangeDecoration {
  readonly fromLine: number;
  readonly toLine: number;
  readonly state: ColorideValidationState;
  readonly snapshotHash: string;
}

export interface ColorideStateVisualTokens {
  readonly state: ColorideValidationState;
  readonly icon: "✓" | "!" | "✕" | "⟳" | "•";
  readonly labelFr: string;
  readonly labelEn: string;
  readonly labelEs: string;
  readonly dark: {
    readonly background: string;
    readonly border: string;
    readonly text: string;
  };
  readonly light: {
    readonly background: string;
    readonly border: string;
    readonly text: string;
  };
}

export const COLORIDE_STATE_VISUAL_TOKENS: Record<
  ColorideValidationState,
  ColorideStateVisualTokens
> = {
  ValidatedGreen: {
    ...COLORIDE_STATE_META.ValidatedGreen,
    dark: { background: "#052e16", border: "#22c55e", text: "#86efac" },
    light: { background: "#dcfce7", border: "#16a34a", text: "#14532d" },
  },
  ReviewYellow: {
    ...COLORIDE_STATE_META.ReviewYellow,
    dark: { background: "#422006", border: "#eab308", text: "#fde047" },
    light: { background: "#fef9c3", border: "#ca8a04", text: "#713f12" },
  },
  FailedRed: {
    ...COLORIDE_STATE_META.FailedRed,
    dark: { background: "#450a0a", border: "#ef4444", text: "#fca5a5" },
    light: { background: "#fee2e2", border: "#dc2626", text: "#7f1d1d" },
  },
  StaleOrange: {
    ...COLORIDE_STATE_META.StaleOrange,
    dark: { background: "#431407", border: "#f97316", text: "#fdba74" },
    light: { background: "#ffedd5", border: "#ea580c", text: "#7c2d12" },
  },
  UnchangedBlue: {
    ...COLORIDE_STATE_META.UnchangedBlue,
    dark: { background: "#0f172a", border: "#3b82f6", text: "#93c5fd" },
    light: { background: "#dbeafe", border: "#2563eb", text: "#1e3a8a" },
  },
};

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
  return `${meta.labelFr} | ${meta.labelEn} (L${decoration.fromLine}-L${decoration.toLine})`;
}

export interface ColorideDecorationFieldValue {
  readonly ranges: readonly EditorRangeDecoration[];
  readonly lineDecorations: DecorationSet;
}

export const setColorideDecorationsEffect = StateEffect.define<readonly EditorRangeDecoration[]>();

export const suppressLocalInvalidationAnnotation = StateEffect.define<boolean>();

function clampLine(doc: Text, lineNumber1Based: number): number {
  if (lineNumber1Based < 1) {
    return 1;
  }
  if (lineNumber1Based > doc.lines) {
    return doc.lines;
  }
  return lineNumber1Based;
}

function buildLineDecorationSet(
  doc: Text,
  ranges: readonly EditorRangeDecoration[],
): DecorationSet {
  const lineMap = new Map<number, EditorRangeDecoration>();
  for (const range of ranges) {
    const startLine = clampLine(doc, range.fromLine);
    const endLine = clampLine(doc, Math.max(range.fromLine, range.toLine));
    for (let lineNo = startLine; lineNo <= endLine; lineNo += 1) {
      lineMap.set(lineNo, range);
    }
  }

  const sortedLines = Array.from(lineMap.keys()).sort((a, b) => a - b);
  const builder = new RangeSetBuilder<Decoration>();
  for (const lineNo of sortedLines) {
    const dec = lineMap.get(lineNo);
    if (!dec) {
      continue;
    }
    const tokens = COLORIDE_STATE_VISUAL_TOKENS[dec.state];
    const ariaLabel = describeDecorationAccessibleLabel(dec);
    const lineInfo = doc.line(lineNo);
    builder.add(
      lineInfo.from,
      lineInfo.from,
      Decoration.line({
        attributes: {
          class: `cm-coloride-line cm-coloride-state-${dec.state}`,
          "data-coloride-state": dec.state,
          "data-coloride-icon": tokens.icon,
          "data-coloride-bg": tokens.dark.background,
          "data-coloride-border": tokens.dark.border,
          "aria-label": ariaLabel,
        },
      }),
    );
  }
  return builder.finish();
}

class ColorideGutterMarker extends GutterMarker {
  constructor(readonly decoration: EditorRangeDecoration) {
    super();
  }

  override eq(other: GutterMarker): boolean {
    return (
      other instanceof ColorideGutterMarker &&
      other.decoration.state === this.decoration.state &&
      other.decoration.fromLine === this.decoration.fromLine &&
      other.decoration.toLine === this.decoration.toLine &&
      other.decoration.snapshotHash === this.decoration.snapshotHash
    );
  }

  override toDOM(): HTMLElement {
    const tokens = COLORIDE_STATE_VISUAL_TOKENS[this.decoration.state];
    const span = document.createElement("span");
    span.className = `cm-coloride-gutter-badge cm-coloride-gutter-${this.decoration.state}`;
    span.textContent = tokens.icon;
    span.setAttribute("role", "status");
    span.setAttribute("data-coloride-state", this.decoration.state);
    span.setAttribute("data-coloride-icon", tokens.icon);
    span.setAttribute("aria-label", describeDecorationAccessibleLabel(this.decoration));
    span.style.backgroundColor = tokens.dark.background;
    span.style.borderLeft = `2px solid ${tokens.dark.border}`;
    span.style.color = tokens.dark.text;
    return span;
  }
}

export const colorideStateField = StateField.define<ColorideDecorationFieldValue>({
  create(state: EditorState): ColorideDecorationFieldValue {
    return {
      ranges: [],
      lineDecorations: buildLineDecorationSet(state.doc, []),
    };
  },
  update(value, tr): ColorideDecorationFieldValue {
    for (const effect of tr.effects) {
      if (effect.is(setColorideDecorationsEffect)) {
        const nextRanges = effect.value;
        return {
          ranges: nextRanges,
          lineDecorations: buildLineDecorationSet(tr.state.doc, nextRanges),
        };
      }
    }

    if (!tr.docChanged || value.ranges.length === 0) {
      return value;
    }

    const suppressInvalidation = tr.effects.some(
      (e) => e.is(suppressLocalInvalidationAnnotation) && e.value,
    );

    const updatedRanges: EditorRangeDecoration[] = value.ranges.map((range) => {
      const oldStartLineNo = clampLine(tr.startState.doc, range.fromLine);
      const oldEndLineNo = clampLine(tr.startState.doc, Math.max(range.fromLine, range.toLine));
      const oldRangeFrom = tr.startState.doc.line(oldStartLineNo).from;
      const oldRangeTo = tr.startState.doc.line(oldEndLineNo).to;

      let touched = false;
      tr.changes.iterChangedRanges((fromA, toA) => {
        if (fromA <= oldRangeTo && toA >= oldRangeFrom) {
          touched = true;
        }
      });

      const mappedFromPos = tr.changes.mapPos(oldRangeFrom, -1);
      const mappedToPos = tr.changes.mapPos(oldRangeTo, 1);
      const nextFromLine = tr.state.doc.lineAt(Math.min(mappedFromPos, tr.state.doc.length)).number;
      const nextToLine = tr.state.doc.lineAt(Math.min(mappedToPos, tr.state.doc.length)).number;

      const nextState: ColorideValidationState =
        touched && !suppressInvalidation && range.state === "ValidatedGreen"
          ? "StaleOrange"
          : range.state;

      return {
        fromLine: nextFromLine,
        toLine: Math.max(nextFromLine, nextToLine),
        state: nextState,
        snapshotHash: range.snapshotHash,
      };
    });

    return {
      ranges: updatedRanges,
      lineDecorations: buildLineDecorationSet(tr.state.doc, updatedRanges),
    };
  },
  provide: (field) => EditorView.decorations.from(field, (val) => val.lineDecorations),
});

export const colorideStateGutter = gutter({
  class: "cm-coloride-validation-gutter",
  lineMarker(view, line) {
    const fieldVal = view.state.field(colorideStateField, false);
    if (!fieldVal) {
      return null;
    }
    const lineNumber = view.state.doc.lineAt(line.from).number;
    for (const dec of fieldVal.ranges) {
      if (lineNumber >= dec.fromLine && lineNumber <= dec.toLine) {
        return new ColorideGutterMarker(dec);
      }
    }
    return null;
  },
  lineMarkerChange(update) {
    return (
      update.docChanged ||
      update.transactions.some((tr) => tr.effects.some((e) => e.is(setColorideDecorationsEffect)))
    );
  },
});

export const colorideThemeExtension = EditorView.baseTheme({
  ".cm-coloride-validation-gutter": {
    width: "24px",
    textAlign: "center",
    userSelect: "none",
  },
  ".cm-coloride-gutter-badge": {
    display: "inline-block",
    width: "18px",
    fontSize: "11px",
    fontWeight: "700",
    lineHeight: "18px",
    borderRadius: "2px",
  },
  ".cm-coloride-state-ValidatedGreen": {
    backgroundColor: "rgba(5, 46, 22, 0.35)",
  },
  ".cm-coloride-state-ReviewYellow": {
    backgroundColor: "rgba(66, 32, 6, 0.35)",
  },
  ".cm-coloride-state-FailedRed": {
    backgroundColor: "rgba(69, 10, 10, 0.35)",
  },
  ".cm-coloride-state-StaleOrange": {
    backgroundColor: "rgba(67, 20, 7, 0.35)",
  },
  ".cm-coloride-state-UnchangedBlue": {
    backgroundColor: "rgba(15, 23, 42, 0.25)",
  },
});

export function colorideStateDecorations() {
  return [colorideStateField, colorideStateGutter, colorideThemeExtension];
}
