import type { Extension, Text } from "@codemirror/state";
import { RectangleMarker, type ViewUpdate, layer } from "@codemirror/view";
import { indentGuideColumns } from "./indent-guide-columns.js";
import { rowVertical } from "./line-geometry.js";

/** Indentation scope guides drawn as a CodeMirror layer; the active scope is highlighted. */

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
