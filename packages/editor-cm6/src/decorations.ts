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
  type LayerMarker,
  RectangleMarker,
  type ViewUpdate,
  gutter,
  gutterLineClass,
  layer,
} from "@codemirror/view";
import { COLORIDE_STATE_META, type ColorideValidationState } from "@coloride/protocol-types";
import { indentGuideColumns } from "./indent-guide-columns.js";

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

const selectedGutterMarker = new (class extends GutterMarker {
  override elementClass = "coloride-selected-line-gutter";
})();

export function highlightSelectedLineGutter(): Extension {
  return gutterLineClass.compute(["selection"], (state) => {
    const builder = new RangeSetBuilder<GutterMarker>();
    const seen = new Set<number>();

    for (const range of state.selection.ranges) {
      const fromLine = state.doc.lineAt(range.from).number;
      const toPos = range.empty ? range.from : Math.max(range.from, range.to - 1);
      const toLine = state.doc.lineAt(toPos).number;

      for (let n = fromLine; n <= toLine; n += 1) {
        if (seen.has(n)) continue;
        seen.add(n);
        builder.add(state.doc.line(n).from, state.doc.line(n).from, selectedGutterMarker);
      }
    }

    return builder.finish();
  });
}

const columnsCache = new WeakMap<Text, { tabSize: number; columns: number[][] }>();

function guideColumns(doc: Text, tabSize: number): number[][] {
  const cached = columnsCache.get(doc);
  if (cached?.tabSize === tabSize) return cached.columns;
  const columns = indentGuideColumns(doc.toString().split("\n"), tabSize);
  columnsCache.set(doc, { tabSize, columns });
  return columns;
}

export function scopeGuides(): Extension {
  return layer({
    above: true,
    class: "cm-scopeGuideLayer",
    update(update: ViewUpdate) {
      return (
        update.docChanged || update.viewportChanged || update.geometryChanged || update.selectionSet
      );
    },
    markers(view) {
      const tabSize = view.state.tabSize;
      const charW = view.defaultCharacterWidth;
      if (tabSize < 1 || charW < 1) return [];

      const rect = view.scrollDOM.getBoundingClientRect();
      const base = {
        left: rect.left - view.scrollDOM.scrollLeft * view.scaleX,
        top: rect.top - view.scrollDOM.scrollTop * view.scaleY,
      };
      const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
      const columns = guideColumns(view.state.doc, tabSize);
      const activeCol = columns[cursorLine - 1]?.at(-1) ?? -1;
      const cursorCoords = view.coordsAtPos(view.state.doc.line(cursorLine).from);
      const cursorY = cursorCoords
        ? (cursorCoords.top + cursorCoords.bottom) / 2 - base.top
        : Number.NEGATIVE_INFINITY;

      type Run = { col: number; left: number; top: number; bottom: number; active: boolean };
      const open = new Map<number, Run>();
      const done: Run[] = [];

      const flushUnused = (keep: Set<number>) => {
        for (const [col, run] of open) {
          if (keep.has(col)) continue;
          done.push(run);
          open.delete(col);
        }
      };

      for (const { from, to } of view.visibleRanges) {
        let pos = from;
        while (pos <= to) {
          const line = view.state.doc.lineAt(pos);
          const block = view.lineBlockAt(line.from);
          if (block.from !== line.from) {
            pos = line.to + 1;
            continue;
          }
          const lineColumns = columns[line.number - 1] ?? [];
          const start = view.coordsAtPos(line.from, 1) ?? view.coordsAtPos(line.from, -1);
          const keep = new Set<number>();

          if (start && lineColumns.length) {
            const v = rowVertical(view, line.from, start.top, start.bottom);
            const top = v.top - base.top;
            const bottom = v.bottom - base.top;
            const lineLeft = start.left - base.left;

            for (const col of lineColumns) {
              keep.add(col);
              const left = lineLeft + col * charW + (col === 0 ? 1 : 0);
              const run = open.get(col);
              if (run && Math.abs(run.left - left) < 1 && top <= run.bottom + 2) {
                run.bottom = Math.max(run.bottom, bottom);
                run.active =
                  run.active || (col === activeCol && cursorY >= top && cursorY < bottom);
              } else {
                if (run) done.push(run);
                open.set(col, {
                  col,
                  left,
                  top,
                  bottom,
                  active: col === activeCol && cursorY >= top && cursorY < bottom,
                });
              }
            }
          }

          flushUnused(keep);
          pos = line.to + 1;
        }
      }
      for (const run of open.values()) done.push(run);

      return done.map(
        (run) =>
          new RectangleMarker(
            run.active ? "cm-scopeGuide cm-scopeGuide-active" : "cm-scopeGuide",
            run.left,
            run.top,
            1,
            Math.max(1, run.bottom - run.top),
          ),
      );
    },
  });
}

type RawSelectionRect = { left: number; top: number; right: number; bottom: number };
type SelectionPoint = { x: number; y: number };

const SELECTION_CORNER_RADIUS = 3;

function selectionLayerBase(view: EditorView) {
  const rect = view.scrollDOM.getBoundingClientRect();
  return {
    left: rect.left - view.scrollDOM.scrollLeft * view.scaleX,
    top: rect.top - view.scrollDOM.scrollTop * view.scaleY,
  };
}

function maxCharWidth(view: EditorView): number {
  return view.defaultCharacterWidth * Math.max(2, view.state.tabSize) + 2;
}

function saneWidth(view: EditorView, width: number): boolean {
  return width > 0 && width <= maxCharWidth(view);
}

function boxAt(
  view: EditorView,
  pos: number,
): { left: number; right: number; top: number; bottom: number } | null {
  const here = view.coordsAtPos(pos, 1);
  if (!here) return null;
  const line = view.state.doc.lineAt(pos);
  let right = here.left + view.defaultCharacterWidth;
  if (pos < line.to) {
    const next = view.coordsAtPos(pos + 1, 1);
    if (next && Math.abs(next.top - here.top) <= 2 && saneWidth(view, next.left - here.left)) {
      right = next.left;
    } else if (saneWidth(view, here.right - here.left)) {
      right = here.right;
    }
  } else if (saneWidth(view, here.right - here.left)) {
    right = here.right;
  }
  return { left: here.left, right, top: here.top, bottom: here.bottom };
}

function rowVertical(
  view: EditorView,
  pos: number,
  glyphTop: number,
  glyphBottom: number,
): { top: number; bottom: number } {
  const block = view.lineBlockAt(pos);
  const top = view.documentTop + block.top;
  const bottom = top + block.height;
  const mid = (glyphTop + glyphBottom) / 2;
  if (
    block.height <= view.defaultLineHeight * 1.45 &&
    Math.abs(mid - (top + bottom) / 2) < view.defaultLineHeight
  ) {
    return { top, bottom };
  }
  const h = Math.max(1, view.defaultLineHeight);
  return { top: mid - h / 2, bottom: mid + h / 2 };
}

function piecesForSegment(view: EditorView, from: number, to: number): RawSelectionRect[] {
  const out: RawSelectionRect[] = [];
  let pos = from;
  let guard = 0;
  while (pos < to && guard < 2000) {
    guard += 1;
    const start = boxAt(view, pos);
    if (!start) {
      pos += 1;
      continue;
    }

    const y = (start.top + start.bottom) / 2;
    const contentRight = view.contentDOM.getBoundingClientRect().right - 1;
    const atRight = view.posAtCoords({ x: contentRight, y });
    let rowTo = to;
    if (atRight != null && atRight > pos && atRight < to) {
      rowTo = atRight;
    }

    const end = boxAt(view, Math.max(pos, rowTo - 1));
    if (!end) {
      pos = rowTo > pos ? rowTo : pos + 1;
      continue;
    }

    if (Math.abs(start.top - end.top) > 2) {
      const v = rowVertical(view, pos, start.top, start.bottom);
      out.push({ left: start.left, right: start.right, top: v.top, bottom: v.bottom });
      pos += 1;
      continue;
    }

    const v = rowVertical(
      view,
      pos,
      Math.min(start.top, end.top),
      Math.max(start.bottom, end.bottom),
    );
    out.push({
      left: Math.min(start.left, end.left),
      right: Math.max(start.right, end.right),
      top: v.top,
      bottom: v.bottom,
    });
    pos = rowTo > pos ? rowTo : pos + 1;
  }
  return out;
}

function emptyLineIncluded(
  from: number,
  to: number,
  lineFrom: number,
  lineTo: number,
  docLen: number,
): boolean {
  if (lineTo > lineFrom) return false;
  if (from <= lineFrom && to > lineFrom) return true;
  return lineTo === docLen && from < lineFrom && to >= lineFrom;
}

function emptyLineNotch(view: EditorView, lineFrom: number): RawSelectionRect | null {
  const start = view.coordsAtPos(lineFrom, 1);
  if (!start) return null;
  const v = rowVertical(view, lineFrom, start.top, start.bottom);
  const width = Math.max(4, view.defaultCharacterWidth * 0.55);
  return { left: start.left, right: start.left + width, top: v.top, bottom: v.bottom };
}

function piecesForTextRange(view: EditorView, from: number, to: number): RawSelectionRect[] {
  if (from >= to) return [];
  const startLine = view.state.doc.lineAt(from);
  const endLine = view.state.doc.lineAt(to);
  const docLen = view.state.doc.length;
  const out: RawSelectionRect[] = [];

  for (let n = startLine.number; n <= endLine.number; n += 1) {
    const line = view.state.doc.line(n);
    const segFrom = Math.max(from, line.from);
    const segTo = Math.min(to, line.to);
    if (segTo > segFrom) {
      out.push(...piecesForSegment(view, segFrom, segTo));
      continue;
    }
    if (emptyLineIncluded(from, to, line.from, line.to, docLen)) {
      const notch = emptyLineNotch(view, line.from);
      if (notch) out.push(notch);
    }
  }
  return out;
}

function mergeSameRow(rects: RawSelectionRect[]): RawSelectionRect[] {
  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
  const out: RawSelectionRect[] = [];
  for (const r of sorted) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.top - r.top) <= 2 && r.left <= prev.right + 2) {
      prev.left = Math.min(prev.left, r.left);
      prev.right = Math.max(prev.right, r.right);
      prev.top = Math.min(prev.top, r.top);
      prev.bottom = Math.max(prev.bottom, r.bottom);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

function stitchVertical(rects: RawSelectionRect[]): RawSelectionRect[] {
  const sorted = [...rects].sort((a, b) => a.top - b.top);
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a && b && b.top <= a.bottom + 4 && b.top >= a.bottom - 4) {
      const mid = (a.bottom + b.top) / 2;
      a.bottom = mid;
      b.top = mid;
    }
  }
  return sorted;
}

function rowsConnect(a: RawSelectionRect, b: RawSelectionRect): boolean {
  const verticallyAdjacent = b.top <= a.bottom + 1 && b.top >= a.bottom - 1;
  const horizontalOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0;
  return verticallyAdjacent && horizontalOverlap;
}

function connectedRows(rows: RawSelectionRect[]): RawSelectionRect[][] {
  const groups: RawSelectionRect[][] = [];
  for (const row of rows) {
    const group = groups[groups.length - 1];
    const lastInGroup = group?.[group.length - 1];
    if (group && lastInGroup && rowsConnect(lastInGroup, row)) group.push(row);
    else groups.push([row]);
  }
  return groups;
}

function samePoint(a: SelectionPoint, b: SelectionPoint): boolean {
  return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
}

function compactPolygon(points: SelectionPoint[]): SelectionPoint[] {
  const deduped = points.filter((point, index) => {
    const prev = points[index - 1];
    return index === 0 || !prev || !samePoint(point, prev);
  });
  const first = deduped[0];
  const last = deduped[deduped.length - 1];
  if (deduped.length > 1 && first && last && samePoint(first, last)) {
    deduped.pop();
  }

  return deduped.filter((point, index, all) => {
    const previous = all[(index + all.length - 1) % all.length];
    const next = all[(index + 1) % all.length];
    if (!previous || !next) return true;
    const cross =
      (point.x - previous.x) * (next.y - point.y) - (point.y - previous.y) * (next.x - point.x);
    return Math.abs(cross) > 0.01;
  });
}

function distance(a: SelectionPoint, b: SelectionPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function toward(from: SelectionPoint, to: SelectionPoint, amount: number): SelectionPoint {
  const length = distance(from, to);
  if (length < 0.01) return from;
  return {
    x: from.x + ((to.x - from.x) * amount) / length,
    y: from.y + ((to.y - from.y) * amount) / length,
  };
}

function roundedSelectionPath(rows: RawSelectionRect[], width: number, height: number): string {
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) return `M 0 0 H ${width} V ${height} H 0 Z`;

  const points: SelectionPoint[] = [
    { x: first.left, y: first.top },
    { x: first.right, y: first.top },
  ];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) continue;
    points.push({ x: row.right, y: row.bottom });
    const nextRow = rows[index + 1];
    if (nextRow) points.push({ x: nextRow.right, y: row.bottom });
  }

  points.push({ x: last.left, y: last.bottom });
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row) continue;
    points.push({ x: row.left, y: row.top });
    const prevRow = rows[index - 1];
    if (prevRow) points.push({ x: prevRow.left, y: row.top });
  }

  const polygon = compactPolygon(points).map((point) => ({ x: point.x, y: point.y }));
  if (polygon.length < 3) return `M 0 0 H ${width} V ${height} H 0 Z`;

  const corners = polygon.map((point, index) => {
    const previous = polygon[(index + polygon.length - 1) % polygon.length] ?? point;
    const next = polygon[(index + 1) % polygon.length] ?? point;
    const radius = Math.min(
      SELECTION_CORNER_RADIUS,
      distance(previous, point) / 2,
      distance(point, next) / 2,
    );
    return { point, before: toward(point, previous, radius), after: toward(point, next, radius) };
  });

  const firstCorner = corners[0];
  if (!firstCorner) return `M 0 0 H ${width} V ${height} H 0 Z`;
  let path = `M ${firstCorner.after.x} ${firstCorner.after.y}`;
  for (let index = 1; index < corners.length; index += 1) {
    const corner = corners[index];
    if (!corner) continue;
    path += ` L ${corner.before.x} ${corner.before.y} Q ${corner.point.x} ${corner.point.y} ${corner.after.x} ${corner.after.y}`;
  }
  path += ` L ${firstCorner.before.x} ${firstCorner.before.y} Q ${firstCorner.point.x} ${firstCorner.point.y} ${firstCorner.after.x} ${firstCorner.after.y} Z`;
  return path;
}

class SelectionPathMarker implements LayerMarker {
  constructor(
    readonly left: number,
    readonly top: number,
    readonly width: number,
    readonly height: number,
    readonly pathData: string,
  ) {}

  eq(other: LayerMarker): boolean {
    return (
      other instanceof SelectionPathMarker &&
      other.left === this.left &&
      other.top === this.top &&
      other.width === this.width &&
      other.height === this.height &&
      other.pathData === this.pathData
    );
  }

  draw(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-selectionPath";
    wrapper.setAttribute("aria-hidden", "true");
    wrapper.style.cssText = `position:absolute;left:${this.left}px;top:${this.top}px;width:${this.width}px;height:${this.height}px;overflow:visible;pointer-events:none`;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${this.width} ${this.height}`);
    svg.setAttribute("width", `${this.width}`);
    svg.setAttribute("height", `${this.height}`);
    svg.style.cssText = "display:block;overflow:visible";
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.classList.add("cm-selectionPath-fill");
    path.setAttribute("d", this.pathData);
    svg.append(path);
    wrapper.append(svg);
    return wrapper;
  }
}

function markersForRange(view: EditorView, from: number, to: number): SelectionPathMarker[] {
  const base = selectionLayerBase(view);
  const rects = stitchVertical(mergeSameRow(piecesForTextRange(view, from, to))).filter(
    (r) => r.right - r.left >= 0.5 && r.bottom - r.top >= 0.5,
  );

  return connectedRows(rects).map((rows) => {
    const left = Math.min(...rows.map((row) => row.left));
    const top = Math.min(...rows.map((row) => row.top));
    const right = Math.max(...rows.map((row) => row.right));
    const bottom = Math.max(...rows.map((row) => row.bottom));
    const localRows = rows.map((row) => ({
      left: row.left - left,
      top: row.top - top,
      right: row.right - left,
      bottom: row.bottom - top,
    }));
    return new SelectionPathMarker(
      left - base.left,
      top - base.top,
      right - left,
      bottom - top,
      roundedSelectionPath(localRows, right - left, bottom - top),
    );
  });
}

/**
 * Exact `textOnlySelection()` from `Rectury-Package`:
 * Draws rounded SVG silhouette selection only over actual characters (never stretching to the empty right margin)
 * and toggles `.cm-has-selection` on the editor root when a non-empty selection is active.
 */
export function textOnlySelection(): Extension {
  return [
    EditorView.editorAttributes.compute(["selection"], (state) => {
      const hasSelection = state.selection.ranges.some((r) => !r.empty);
      return hasSelection ? { class: "cm-has-selection" } : {};
    }),
    layer({
      above: false,
      class: "cm-textSelectionLayer",
      markers(view) {
        const markers: SelectionPathMarker[] = [];
        for (const range of view.state.selection.ranges) {
          if (range.empty) continue;
          markers.push(...markersForRange(view, range.from, range.to));
        }
        return markers;
      },
      update(update) {
        return (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          update.geometryChanged
        );
      },
    }),
    EditorView.theme({
      ".cm-selectionLayer .cm-selectionBackground": {
        display: "none !important",
        width: "0 !important",
        opacity: "0 !important",
      },
    }),
  ];
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
    highlightSelectedLineGutter(),
    scopeGuides(),
    textOnlySelection(),
    colorideThemeExtension,
  ];
}
