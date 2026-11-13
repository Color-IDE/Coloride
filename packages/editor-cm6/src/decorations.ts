import {
  type EditorState,
  type Extension,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  gutter,
  gutterLineClass,
} from "@codemirror/view";
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

const STATIC_LINE_DECORATION_BY_STATE: Record<ColorideValidationState, Decoration> = {
  ValidatedGreen: Decoration.line({
    attributes: {
      class: "cm-coloride-line cm-coloride-state-ValidatedGreen",
      "data-coloride-state": "ValidatedGreen",
      "data-coloride-icon": COLORIDE_STATE_VISUAL_TOKENS.ValidatedGreen.icon,
      "data-coloride-bg": COLORIDE_STATE_VISUAL_TOKENS.ValidatedGreen.dark.background,
      "data-coloride-border": COLORIDE_STATE_VISUAL_TOKENS.ValidatedGreen.dark.border,
      "aria-label": `${COLORIDE_STATE_META.ValidatedGreen.labelFr} | ${COLORIDE_STATE_META.ValidatedGreen.labelEn}`,
    },
  }),
  ReviewYellow: Decoration.line({
    attributes: {
      class: "cm-coloride-line cm-coloride-state-ReviewYellow",
      "data-coloride-state": "ReviewYellow",
      "data-coloride-icon": COLORIDE_STATE_VISUAL_TOKENS.ReviewYellow.icon,
      "data-coloride-bg": COLORIDE_STATE_VISUAL_TOKENS.ReviewYellow.dark.background,
      "data-coloride-border": COLORIDE_STATE_VISUAL_TOKENS.ReviewYellow.dark.border,
      "aria-label": `${COLORIDE_STATE_META.ReviewYellow.labelFr} | ${COLORIDE_STATE_META.ReviewYellow.labelEn}`,
    },
  }),
  FailedRed: Decoration.line({
    attributes: {
      class: "cm-coloride-line cm-coloride-state-FailedRed",
      "data-coloride-state": "FailedRed",
      "data-coloride-icon": COLORIDE_STATE_VISUAL_TOKENS.FailedRed.icon,
      "data-coloride-bg": COLORIDE_STATE_VISUAL_TOKENS.FailedRed.dark.background,
      "data-coloride-border": COLORIDE_STATE_VISUAL_TOKENS.FailedRed.dark.border,
      "aria-label": `${COLORIDE_STATE_META.FailedRed.labelFr} | ${COLORIDE_STATE_META.FailedRed.labelEn}`,
    },
  }),
  StaleOrange: Decoration.line({
    attributes: {
      class: "cm-coloride-line cm-coloride-state-StaleOrange",
      "data-coloride-state": "StaleOrange",
      "data-coloride-icon": COLORIDE_STATE_VISUAL_TOKENS.StaleOrange.icon,
      "data-coloride-bg": COLORIDE_STATE_VISUAL_TOKENS.StaleOrange.dark.background,
      "data-coloride-border": COLORIDE_STATE_VISUAL_TOKENS.StaleOrange.dark.border,
      "aria-label": `${COLORIDE_STATE_META.StaleOrange.labelFr} | ${COLORIDE_STATE_META.StaleOrange.labelEn}`,
    },
  }),
  UnchangedBlue: Decoration.line({
    attributes: {
      class: "cm-coloride-line cm-coloride-state-UnchangedBlue",
      "data-coloride-state": "UnchangedBlue",
      "data-coloride-icon": COLORIDE_STATE_VISUAL_TOKENS.UnchangedBlue.icon,
      "data-coloride-bg": COLORIDE_STATE_VISUAL_TOKENS.UnchangedBlue.dark.background,
      "data-coloride-border": COLORIDE_STATE_VISUAL_TOKENS.UnchangedBlue.dark.border,
      "aria-label": `${COLORIDE_STATE_META.UnchangedBlue.labelFr} | ${COLORIDE_STATE_META.UnchangedBlue.labelEn}`,
    },
  }),
};

function buildLineDecorationSet(
  doc: Text,
  ranges: readonly EditorRangeDecoration[],
): DecorationSet {
  if (ranges.length === 0) {
    return Decoration.none;
  }

  const sortedRanges =
    ranges.length <= 1
      ? ranges
      : [...ranges].sort((a, b) => a.fromLine - b.fromLine || a.toLine - b.toLine);

  const builder = new RangeSetBuilder<Decoration>();
  let lastAddedLine = 0;

  for (const dec of sortedRanges) {
    const startLine = Math.max(lastAddedLine + 1, clampLine(doc, dec.fromLine));
    const endLine = clampLine(doc, Math.max(dec.fromLine, dec.toLine));
    if (startLine > endLine) {
      continue;
    }
    const lineDec = STATIC_LINE_DECORATION_BY_STATE[dec.state];

    for (let lineNo = startLine; lineNo <= endLine; lineNo += 1) {
      const lineInfo = doc.line(lineNo);
      builder.add(lineInfo.from, lineInfo.from, lineDec);
      lastAddedLine = lineNo;
    }
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
  class: "cm-coloride-validation-gutter cm-gutter-coloride-change",
  renderEmptyElements: false,
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

const gutterWashMarkerByState: Record<ColorideValidationState, GutterMarker> = {
  ValidatedGreen: new (class extends GutterMarker {
    override elementClass = "coloride-hunk-gutter-ValidatedGreen";
  })(),
  ReviewYellow: new (class extends GutterMarker {
    override elementClass = "coloride-hunk-gutter-ReviewYellow";
  })(),
  FailedRed: new (class extends GutterMarker {
    override elementClass = "coloride-hunk-gutter-FailedRed";
  })(),
  StaleOrange: new (class extends GutterMarker {
    override elementClass = "coloride-hunk-gutter-StaleOrange";
  })(),
  UnchangedBlue: new (class extends GutterMarker {
    override elementClass = "coloride-hunk-gutter-UnchangedBlue";
  })(),
};

/**
 * Wash line-number and fold-gutter cells with the exact same 5-state Coloride background
 * (like `Rectury-Package`'s `coloride-hunk-gutter-*` and `coloride-fold-wash-*`) so there is
 * zero gap between the 3px state bar, line numbers, fold chevron, and code line.
 */
export function colorideGutterStateWash(): Extension {
  return gutterLineClass.compute([colorideStateField], (state) => {
    const fieldVal = state.field(colorideStateField, false);
    if (!fieldVal || fieldVal.ranges.length === 0) {
      return RangeSet.empty;
    }
    const sorted =
      fieldVal.ranges.length <= 1
        ? fieldVal.ranges
        : [...fieldVal.ranges].sort((a, b) => a.fromLine - b.fromLine || a.toLine - b.toLine);

    const builder = new RangeSetBuilder<GutterMarker>();
    let lastLine = 0;
    for (const dec of sorted) {
      const startLine = Math.max(lastLine + 1, clampLine(state.doc, dec.fromLine));
      const endLine = clampLine(state.doc, Math.max(dec.fromLine, dec.toLine));
      const marker = gutterWashMarkerByState[dec.state];
      for (let lineNo = startLine; lineNo <= endLine; lineNo += 1) {
        const lineFrom = state.doc.line(lineNo).from;
        builder.add(lineFrom, lineFrom, marker);
        lastLine = lineNo;
      }
    }
    return builder.finish();
  });
}

export const colorideThemeExtension = EditorView.baseTheme({
  ".cm-coloride-validation-gutter": {
    width: "3px",
    minWidth: "3px",
    userSelect: "none",
  },
  ".cm-coloride-validation-gutter .cm-gutterElement": {
    padding: "0",
  },
  ".cm-coloride-gutter-badge": {
    display: "block",
    width: "3px",
    height: "100%",
    minHeight: "1.5em",
    fontSize: "0",
    lineHeight: "0",
    color: "transparent",
    overflow: "hidden",
  },
  // 3px left bar in all 5 Coloride states
  ".cm-coloride-gutter-ValidatedGreen": {
    backgroundColor: "#22c55e",
  },
  ".cm-coloride-gutter-ReviewYellow": {
    backgroundColor: "#eab308",
  },
  ".cm-coloride-gutter-FailedRed": {
    backgroundColor: "#ef4444",
  },
  ".cm-coloride-gutter-StaleOrange": {
    backgroundColor: "#f97316",
  },
  ".cm-coloride-gutter-UnchangedBlue": {
    backgroundColor: "#3b82f6",
  },
  // Full-width line wash + gutter wash (line numbers & fold gutter) for all 5 Coloride states
  // Uses !important so `.cm-has-selection .cm-activeLine` never strips the Coloride state background
  ".cm-coloride-state-ValidatedGreen, &.cm-has-selection .cm-activeLine.cm-coloride-state-ValidatedGreen, .cm-activeLine.cm-coloride-state-ValidatedGreen, .cm-gutterElement.coloride-hunk-gutter-ValidatedGreen, &.cm-has-selection .cm-gutterElement.coloride-hunk-gutter-ValidatedGreen.cm-activeLineGutter, .cm-gutterElement.coloride-hunk-gutter-ValidatedGreen.cm-activeLineGutter":
    {
      backgroundColor: "rgba(34, 197, 94, 0.11) !important",
    },
  ".cm-lineNumbers .cm-gutterElement.coloride-hunk-gutter-ValidatedGreen, .cm-lineNumbers .cm-gutterElement.coloride-hunk-gutter-ValidatedGreen.cm-activeLineGutter":
    {
      color: "#86efac",
    },
  ".cm-coloride-state-ReviewYellow, &.cm-has-selection .cm-activeLine.cm-coloride-state-ReviewYellow, .cm-activeLine.cm-coloride-state-ReviewYellow, .cm-gutterElement.coloride-hunk-gutter-ReviewYellow, &.cm-has-selection .cm-gutterElement.coloride-hunk-gutter-ReviewYellow.cm-activeLineGutter, .cm-gutterElement.coloride-hunk-gutter-ReviewYellow.cm-activeLineGutter":
    {
      backgroundColor: "rgba(234, 179, 8, 0.11) !important",
    },
  ".cm-lineNumbers .cm-gutterElement.coloride-hunk-gutter-ReviewYellow, .cm-lineNumbers .cm-gutterElement.coloride-hunk-gutter-ReviewYellow.cm-activeLineGutter":
    {
      color: "#fde047",
    },
  ".cm-coloride-state-FailedRed, &.cm-has-selection .cm-activeLine.cm-coloride-state-FailedRed, .cm-activeLine.cm-coloride-state-FailedRed, .cm-gutterElement.coloride-hunk-gutter-FailedRed, &.cm-has-selection .cm-gutterElement.coloride-hunk-gutter-FailedRed.cm-activeLineGutter, .cm-gutterElement.coloride-hunk-gutter-FailedRed.cm-activeLineGutter":
    {
      backgroundColor: "rgba(239, 68, 68, 0.12) !important",
    },
  ".cm-lineNumbers .cm-gutterElement.coloride-hunk-gutter-FailedRed, .cm-lineNumbers .cm-gutterElement.coloride-hunk-gutter-FailedRed.cm-activeLineGutter":
    {
      color: "#fca5a5",
    },
  ".cm-coloride-state-StaleOrange, &.cm-has-selection .cm-activeLine.cm-coloride-state-StaleOrange, .cm-activeLine.cm-coloride-state-StaleOrange, .cm-gutterElement.coloride-hunk-gutter-StaleOrange, &.cm-has-selection .cm-gutterElement.coloride-hunk-gutter-StaleOrange.cm-activeLineGutter, .cm-gutterElement.coloride-hunk-gutter-StaleOrange.cm-activeLineGutter":
    {
      backgroundColor: "rgba(249, 115, 22, 0.11) !important",
    },
  ".cm-lineNumbers .cm-gutterElement.coloride-hunk-gutter-StaleOrange, .cm-lineNumbers .cm-gutterElement.coloride-hunk-gutter-StaleOrange.cm-activeLineGutter":
    {
      color: "#fdba74",
    },
  ".cm-coloride-state-UnchangedBlue, &.cm-has-selection .cm-activeLine.cm-coloride-state-UnchangedBlue, .cm-activeLine.cm-coloride-state-UnchangedBlue, .cm-gutterElement.coloride-hunk-gutter-UnchangedBlue, &.cm-has-selection .cm-gutterElement.coloride-hunk-gutter-UnchangedBlue.cm-activeLineGutter, .cm-gutterElement.coloride-hunk-gutter-UnchangedBlue.cm-activeLineGutter":
    {
      backgroundColor: "rgba(59, 130, 246, 0.10) !important",
    },
  ".cm-lineNumbers .cm-gutterElement.coloride-hunk-gutter-UnchangedBlue, .cm-lineNumbers .cm-gutterElement.coloride-hunk-gutter-UnchangedBlue.cm-activeLineGutter":
    {
      color: "#93c5fd",
    },
});

export function colorideStateDecorations() {
  return [
    colorideStateField,
    colorideStateGutter,
    colorideGutterStateWash(),
    colorideThemeExtension,
  ];
}
