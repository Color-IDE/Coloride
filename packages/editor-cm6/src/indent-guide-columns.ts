/**
 * Computes the indentation columns rendered by CodeMirror scope guides: one every `guideWidth`
 * columns of a line's indentation (a tab counts `tabSize` columns).
 * Blank lines retain the preceding scope until a non-blank line closes or changes it.
 */
export function indentGuideColumns(
  lines: readonly string[],
  guideWidth: number,
  tabSize = guideWidth,
): number[][] {
  const result: number[][] = lines.map(() => []);
  let previousLine = -1;
  const width = Math.max(1, guideWidth);
  const tab = Math.max(1, tabSize);

  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i] ?? "";
    let indent = 0;
    for (const char of text) {
      if (char === " ") indent += 1;
      else if (char === "\t") indent += tab - (indent % tab);
      else break;
    }

    const isBlankLine = text.trim().length === 0;
    if (isBlankLine && indent === 0) {
      if (previousLine >= 0) result[i] = [...(result[previousLine] ?? [])];
      continue;
    }

    const columns: number[] = [];
    for (let col = 0; col + width <= indent; col += width) columns.push(col);
    result[i] = columns;

    if (!isBlankLine) {
      if (previousLine >= 0) {
        const prevCols = result[previousLine] ?? [];
        const shared = prevCols.filter((col) => columns.includes(col));
        for (let blank = previousLine + 1; blank < i; blank += 1) {
          if ((result[blank] ?? []).length === 0) result[blank] = shared;
        }
      }
      previousLine = i;
    }
  }
  return result;
}

/** Indent size assumed when a file shows no regular indentation (as the usual editors do). */
export const DEFAULT_GUIDE_INDENT = 4;

/**
 * The indentation step of a file, found the way editors do: how much the indentation of one
 * non-blank line differs from the previous one, counting each step from 2 to 8 spaces. The most
 * frequent step wins (the smaller one on a tie); with no steps at all, `fallback`.
 * Lines indented with tabs are ignored: their step is the editor's tab size.
 */
export function detectIndentSize(
  lines: readonly string[],
  fallback = DEFAULT_GUIDE_INDENT,
): number {
  const counts = new Array<number>(9).fill(0);
  let previous = 0;
  for (const text of lines) {
    if (text.trim().length === 0) continue;
    if (text.startsWith("\t")) {
      previous = 0;
      continue;
    }
    let indent = 0;
    while (text[indent] === " ") indent += 1;
    const step = Math.abs(indent - previous);
    if (step >= 2 && step <= 8) counts[step] = (counts[step] ?? 0) + 1;
    previous = indent;
  }
  let best = 0;
  let size = fallback;
  for (let step = 2; step <= 8; step += 1) {
    if ((counts[step] ?? 0) > best) {
      best = counts[step] ?? 0;
      size = step;
    }
  }
  return size;
}
