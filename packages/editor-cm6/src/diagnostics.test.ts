// @vitest-environment happy-dom
import type { DiagnosticEntry, DocumentDiagnostics } from "@coloride/protocol-types";
import { describe, expect, it } from "vitest";
import { ColorideEditorView, InMemoryBinaryHostBridge } from "./index.js";

const DOCUMENT_ID = "src/main.ts";
/** "𝄞" is two UTF-16 units: offsets after it only work if nothing counts code points. */
const LINES = ['const clef = "𝄞";', "const total = count + 1;", "export { total };"];

/** An editor brought to revision 4 by four real edits, as after a few keystrokes. */
function editorAtRevision4() {
  const editor = new ColorideEditorView({
    initialDocumentId: DOCUMENT_ID,
    initialContent: "",
    ipcChannel: new InMemoryBinaryHostBridge(),
  });
  editor.mount(document.createElement("div"));
  editor.dispatchUserEdit(0, 0, `${LINES[0]}\n`);
  editor.dispatchUserEdit(editor.getDocumentText().length, editor.getDocumentText().length, "\n");
  editor.dispatchUserEdit(
    editor.getDocumentText().length - 1,
    editor.getDocumentText().length - 1,
    LINES[1] as string,
  );
  editor.dispatchUserEdit(
    editor.getDocumentText().length,
    editor.getDocumentText().length,
    LINES[2] as string,
  );
  expect(editor.getDocumentText()).toBe(LINES.join("\n"));
  expect(editor.getStoreSnapshot().revision).toBe(4);
  return editor;
}

/** A batch as host-core builds it: offsets into the text of `baseRevision`. */
function batchFor(
  text: string,
  token: string,
  baseRevision: number,
  overrides: Partial<DocumentDiagnostics> = {},
): DocumentDiagnostics {
  const start = text.indexOf(token);
  if (start < 0) throw new Error(`"${token}" not in text`);
  const item: DiagnosticEntry = {
    file_path: DOCUMENT_ID,
    span_utf16: { start, end: start + token.length },
    line_col: { line: text.slice(0, start).split("\n").length - 1, col_utf16: 0 },
    source: "Vtsls",
    severity: "Error",
    code: "2304",
    message: `Cannot find name '${token}'.`,
  };
  return {
    schema_version: 1,
    document_id: DOCUMENT_ID,
    session_generation: 1,
    base_revision: baseRevision,
    content_blake3_hash: "hash",
    source: "Vtsls",
    items: [item],
    ...overrides,
  };
}

/** The text under each squiggle actually drawn in the editor DOM. */
function underlined(editor: ColorideEditorView): string[] {
  return Array.from(
    editor.getEditorView().contentDOM.querySelectorAll(".cm-coloride-diagnostic"),
    (mark) => mark.textContent ?? "",
  );
}

describe("LOT-010 — Stale Diagnostic Rejection (Blocking)", () => {
  it("a diagnostic for R4 arriving after the line was edited in R5 is discarded, never applied to shifted offsets", () => {
    const editor = editorAtRevision4();
    const textAtR4 = editor.getDocumentText();
    // The language server computes this for R4, and is slow to answer...
    const delayed = batchFor(textAtR4, "count", 4);

    // ...meanwhile the user edits that very line: R5. `count` is no longer where it was.
    const lineStart = textAtR4.indexOf("const total");
    editor.dispatchUserEdit(lineStart, lineStart + "const".length, "let");
    expect(editor.getStoreSnapshot().revision).toBe(5);

    const result = editor.applyDocumentDiagnostics(delayed);

    expect(result).toEqual({ applied: 0, discarded: 1 });
    expect(editor.getDiagnostics()).toEqual([]);
    expect(underlined(editor)).toEqual([]);
    expect(editor.getStoreSnapshot().discardedStaleDiagnostics).toBe(1);
    // Had the R4 offsets been applied to the R5 text, this is what would have been underlined:
    const { start, end } = delayed.items[0]?.span_utf16 ?? { start: 0, end: 0 };
    expect(editor.getDocumentText().slice(start, end)).not.toBe("count");
  });

  it("is discarded as well when the edit only touches another part of the same line", () => {
    const editor = editorAtRevision4();
    const delayed = batchFor(editor.getDocumentText(), "count", 4);
    // Appending at the end of the line does not move `count`, but the line was edited.
    const lineEnd = editor.getDocumentText().indexOf(";\nexport") + 1;
    editor.dispatchUserEdit(lineEnd, lineEnd, " // todo");

    expect(editor.applyDocumentDiagnostics(delayed)).toEqual({ applied: 0, discarded: 1 });
    expect(underlined(editor)).toEqual([]);
  });

  it("a late diagnostic whose line was not edited is moved by exactly the edits around it", () => {
    const editor = editorAtRevision4();
    const delayed = batchFor(editor.getDocumentText(), "count", 4);
    // R5: a line is added above (Enter at the end of line 1, then text). R6: one below.
    const firstLineEnd = (LINES[0] as string).length;
    editor.dispatchUserEdit(firstLineEnd, firstLineEnd, "\n// 𝄞 note");
    const end = editor.getDocumentText().length;
    editor.dispatchUserEdit(end, end, "\n// end");
    expect(editor.getStoreSnapshot().revision).toBe(6);

    expect(editor.applyDocumentDiagnostics(delayed)).toEqual({ applied: 1, discarded: 0 });
    const [shown] = editor.getDiagnostics();
    expect(editor.getDocumentText().slice(shown?.from, shown?.to)).toBe("count");
    expect(underlined(editor)).toEqual(["count"]);
    expect(shown?.from).toBe((delayed.items[0]?.span_utf16.start ?? 0) + "\n// 𝄞 note".length);
  });

  it("in a batch, only the diagnostics on edited lines are dropped", () => {
    const editor = editorAtRevision4();
    const text = editor.getDocumentText();
    const onLine2 = batchFor(text, "count", 4);
    const onLine3 = batchFor(text, "total }", 4);
    const batch = { ...onLine2, items: [...onLine2.items, ...onLine3.items] };
    const lineStart = text.indexOf("const total");
    editor.dispatchUserEdit(lineStart, lineStart, "/* x */ ");

    expect(editor.applyDocumentDiagnostics(batch)).toEqual({ applied: 1, discarded: 1 });
    expect(underlined(editor)).toEqual(["total }"]);
  });

  it("applies diagnostics for the current revision as they are", () => {
    const editor = editorAtRevision4();
    const result = editor.applyDocumentDiagnostics(batchFor(editor.getDocumentText(), "count", 4));
    expect(result).toEqual({ applied: 1, discarded: 0 });
    expect(underlined(editor)).toEqual(["count"]);
  });

  it("refuses a batch for another document, an earlier opening, or an unknown revision", () => {
    const editor = editorAtRevision4();
    const text = editor.getDocumentText();
    expect(
      editor.applyDocumentDiagnostics(batchFor(text, "count", 4, { document_id: "src/other.ts" })),
    ).toMatchObject({ applied: 0, rejected: "stale-session" });
    expect(
      editor.applyDocumentDiagnostics(batchFor(text, "count", 4, { session_generation: 0 })),
    ).toMatchObject({ applied: 0, rejected: "stale-session" });
    // A revision the editor has not reached: the batch cannot describe this text.
    expect(editor.applyDocumentDiagnostics(batchFor(text, "count", 9))).toMatchObject({
      applied: 0,
      rejected: "unknown-revision",
    });
    expect(underlined(editor)).toEqual([]);

    // After switching file, a batch for the previous file's session is refused too.
    editor.switchDocument("src/other.ts", "const count = 1;\n");
    expect(editor.applyDocumentDiagnostics(batchFor(text, "count", 4))).toMatchObject({
      rejected: "stale-session",
    });
    expect(underlined(editor)).toEqual([]);
  });

  it("refuses a batch from a revision too old to map from", () => {
    const editor = editorAtRevision4();
    const delayed = batchFor(editor.getDocumentText(), "count", 4);
    for (let i = 0; i < 600; i += 1) {
      const end = editor.getDocumentText().length;
      editor.dispatchUserEdit(end, end, "x");
    }
    expect(editor.applyDocumentDiagnostics(delayed)).toMatchObject({
      applied: 0,
      rejected: "unknown-revision",
    });
  });

  it("a shown diagnostic follows the text and disappears the moment its line is edited", () => {
    const editor = editorAtRevision4();
    editor.applyDocumentDiagnostics(batchFor(editor.getDocumentText(), "count", 4));
    editor.dispatchUserEdit(0, 0, "// header\n".replace("\n", ""));
    // The edit was on line 1: still shown, still under `count`.
    expect(underlined(editor)).toEqual(["count"]);

    const position = editor.getDocumentText().indexOf("count");
    editor.dispatchUserEdit(position, position + 1, "C");
    expect(underlined(editor)).toEqual([]);
    expect(editor.getDiagnostics()).toEqual([]);
  });

  it("a new batch replaces the same tool's diagnostics and leaves the other tool's alone", () => {
    const editor = editorAtRevision4();
    const text = editor.getDocumentText();
    editor.applyDocumentDiagnostics(batchFor(text, "count", 4));
    const biome = batchFor(text, "const total", 4, { source: "Biome" });
    editor.applyDocumentDiagnostics({
      ...biome,
      items: biome.items.map((item) => ({ ...item, source: "Biome", severity: "Warning" })),
    });
    expect(underlined(editor).sort()).toEqual(["const total", "count"]);

    // vtsls now reports nothing: only its squiggle goes away.
    editor.applyDocumentDiagnostics({ ...batchFor(text, "count", 4), items: [] });
    expect(underlined(editor)).toEqual(["const total"]);
  });
});
