import {
  type EditorState,
  type Extension,
  RangeSet,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { EditorView, GutterMarker, type KeyBinding, gutter } from "@codemirror/view";

/** Replaces every breakpoint (1-based line numbers); used when another file is shown. */
export const setBreakpointsEffect = StateEffect.define<readonly number[]>();
const toggleBreakpointEffect = StateEffect.define<number>();

class BreakpointMarker extends GutterMarker {
  override toDOM(view: EditorView): Node {
    const dot = view.dom.ownerDocument.createElement("span");
    dot.className = "cm-coloride-breakpoint";
    dot.setAttribute("aria-label", "Breakpoint");
    return dot;
  }
}
const marker = new BreakpointMarker();

/** Breakpoints, at the start of their line; they move with the text like any position. */
export const breakpointsField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    let next = set.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setBreakpointsEffect)) {
        const doc = tr.state.doc;
        const starts = [...new Set(effect.value)]
          .filter((line) => line >= 1 && line <= doc.lines)
          .map((line) => doc.line(line).from)
          .sort((a, b) => a - b);
        next = RangeSet.of(starts.map((from) => marker.range(from)));
      } else if (effect.is(toggleBreakpointEffect)) {
        const from = effect.value;
        let present = false;
        next.between(from, from, () => {
          present = true;
        });
        next = present
          ? next.update({ filter: (start) => start !== from })
          : next.update({ add: [marker.range(from)] });
      }
    }
    return next;
  },
});

/** 1-based line numbers of the breakpoints, ascending (a line holds at most one). */
export function breakpointLines(state: EditorState): number[] {
  const lines = new Set<number>();
  const cursor = state.field(breakpointsField).iter();
  for (; cursor.value; cursor.next()) lines.add(state.doc.lineAt(cursor.from).number);
  return [...lines].sort((a, b) => a - b);
}

function toggleAt(view: EditorView, position: number): boolean {
  view.dispatch({ effects: toggleBreakpointEffect.of(view.state.doc.lineAt(position).from) });
  return true;
}

/** F9 on the current line. */
export const breakpointKeyBindings: readonly KeyBinding[] = [
  { key: "F9", run: (view) => toggleAt(view, view.state.selection.main.head) },
];

/** The breakpoint gutter: a click toggles the line's breakpoint. */
export function colorideBreakpoints(): Extension {
  return [
    breakpointsField,
    EditorView.baseTheme({
      ".cm-coloride-breakpoint-gutter .cm-gutterElement": { cursor: "pointer", width: "12px" },
      ".cm-coloride-breakpoint": {
        display: "inline-block",
        width: "8px",
        height: "8px",
        borderRadius: "50%",
        background: "#e51400",
      },
      ".cm-coloride-breakpoint-gutter .cm-gutterElement:hover .cm-coloride-breakpoint": {
        opacity: "0.8",
      },
    }),
    gutter({
      class: "cm-coloride-breakpoint-gutter",
      markers: (view) => view.state.field(breakpointsField),
      initialSpacer: () => marker,
      domEventHandlers: {
        mousedown: (view, line) => toggleAt(view, line.from),
      },
    }),
  ];
}
