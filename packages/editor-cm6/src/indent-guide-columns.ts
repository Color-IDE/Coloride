/**
 * Computes the indentation columns rendered by CodeMirror scope guides.
 * Blank lines retain the preceding scope until a non-blank line closes or changes it.
 */
export function indentGuideColumns(lines: readonly string[], tabSize: number): number[][] {
  const result: number[][] = lines.map(() => []);
  let previousLine = -1;
  const width = Math.max(1, tabSize);

  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i] ?? "";
    let indent = 0;
    for (const char of text) {
      if (char === " ") indent += 1;
      else if (char === "\t") indent += width - (indent % width);
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
