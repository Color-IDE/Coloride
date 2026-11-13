import type { EditorView } from "@codemirror/view";

/**
 * Vertical extent of the visual row holding `pos`. Uses the full line block for ordinary lines and
 * falls back to a row centred on the glyph box for wrapped or oversized blocks. Shared by the
 * selection and scope-guide layers so both line up exactly.
 */
export function rowVertical(
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
