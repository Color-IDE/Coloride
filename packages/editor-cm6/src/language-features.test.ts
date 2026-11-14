// @vitest-environment happy-dom
import { CompletionContext } from "@codemirror/autocomplete";
import type {
  LanguageFeatureRequest,
  LanguageFeatureResponse,
  LanguageFeatureResult,
  LanguageLocation,
} from "@coloride/protocol-types";
import { describe, expect, it } from "vitest";
import { ColorideEditorView, InMemoryBinaryHostBridge } from "./index.js";

const TEXT = 'const   clef = "𝄞";\nconst counter = clef;\n';

/** A host whose answers are released by the test, to put edits in between. */
function setup() {
  const editor = new ColorideEditorView({
    initialDocumentId: "src/main.ts",
    initialContent: TEXT,
    ipcChannel: new InMemoryBinaryHostBridge(),
  });
  editor.mount(document.createElement("div"));
  const pending: Array<{
    request: LanguageFeatureRequest;
    answer: (result: LanguageFeatureResult) => void;
  }> = [];
  const navigated: LanguageLocation[] = [];
  editor.setLanguageFeatureProvider(
    (request) =>
      new Promise<LanguageFeatureResponse>((resolve) => {
        pending.push({
          request,
          answer: (result) =>
            resolve({
              schema_version: 1,
              document_id: request.document_id,
              session_generation: request.session_generation,
              base_revision: request.revision,
              content_blake3_hash: "h",
              result,
            }),
        });
      }),
    (location) => navigated.push(location),
  );
  const next = () => {
    const item = pending.shift();
    if (!item) throw new Error("no request sent");
    return item;
  };
  return { editor, next, navigated, features: editor.getLanguageFeatures() };
}

const span = (start: number, end: number) => ({ start, end });

describe("LOT-010 — language features bound to their revision", () => {
  it("formatting computed for the current revision is applied as one undoable transaction", async () => {
    const { editor, next, features } = setup();
    const done = features.formatDocument();
    const { request, answer } = next();
    expect(request).toMatchObject({
      document_id: "src/main.ts",
      revision: 0,
      feature: "Formatting",
    });
    // "const   clef" → "const clef": offsets in the revision-0 text.
    answer({ Edits: { edits: [{ span_utf16: span(5, 8), new_text: " " }] } });
    expect(await done).toBe(true);
    expect(editor.getDocumentText()).toBe('const clef = "𝄞";\nconst counter = clef;\n');
    expect(editor.getStoreSnapshot().revision).toBe(1);
  });

  it("formatting that arrives after the user typed is dropped, never applied to shifted offsets", async () => {
    const { editor, next, features } = setup();
    const done = features.formatDocument();
    const { answer } = next();
    editor.dispatchUserEdit(0, 0, "// typed\n");
    answer({ Edits: { edits: [{ span_utf16: span(5, 8), new_text: " " }] } });
    expect(await done).toBe(false);
    expect(editor.getDocumentText()).toBe(`// typed\n${TEXT}`);
    expect(editor.getStoreSnapshot().discardedStaleLanguageAnswers).toBe(1);
  });

  it("a rename edits this document and hands back the other files", async () => {
    const { editor, next, features } = setup();
    const position = TEXT.indexOf("clef");
    editor.getEditorView().dispatch({ selection: { anchor: position } });
    const done = features.renameSymbol("key");
    const { request, answer } = next();
    expect(request.feature).toEqual({ Rename: { new_name: "key" } });
    expect(request.position_utf16).toBe(position);
    const second = TEXT.lastIndexOf("clef");
    const otherFiles = [{ file_path: "src/b.ts", inside_workspace: true, edits: [] }];
    answer({
      Rename: {
        edits: [
          { span_utf16: span(position, position + 4), new_text: "key" },
          { span_utf16: span(second, second + 4), new_text: "key" },
        ],
        other_files: otherFiles,
      },
    });
    expect(await done).toEqual(otherFiles);
    expect(editor.getDocumentText()).toBe('const   key = "𝄞";\nconst counter = key;\n');
  });

  it("go to definition moves in this file, and asks to navigate for another one", async () => {
    const { editor, next, features, navigated } = setup();
    const local = TEXT.indexOf("clef");
    let done = features.goToDefinition();
    next().answer({
      Locations: {
        locations: [
          {
            file_path: "src/main.ts",
            inside_workspace: true,
            start: { line: 0, col_utf16: local },
            end: { line: 0, col_utf16: local + 4 },
            span_utf16: span(local, local + 4),
          },
        ],
      },
    });
    await done;
    const selection = editor.getEditorView().state.selection.main;
    expect([selection.from, selection.to]).toEqual([local, local + 4]);

    const elsewhere: LanguageLocation = {
      file_path: "src/util.ts",
      inside_workspace: true,
      start: { line: 3, col_utf16: 2 },
      end: { line: 3, col_utf16: 8 },
      span_utf16: null,
    };
    done = features.goToDefinition();
    next().answer({ Locations: { locations: [elsewhere] } });
    await done;
    expect(navigated).toEqual([elsewhere]);
  });

  it("completions come from the server for the current revision, and are dropped once stale", async () => {
    const { editor, next, features } = setup();
    const end = editor.getDocumentText().length;
    editor.dispatchUserEdit(end, end, "cou");
    const context = () => new CompletionContext(editor.getEditorView().state, end + 3, true);
    const items = {
      Completions: {
        is_incomplete: false,
        items: [
          {
            label: "counter",
            kind: "variable",
            detail: "const counter: string",
            sort_text: "0",
            filter_text: "counter",
            insert_text: "counter",
            replace_span_utf16: null,
          },
        ],
      },
    };
    let result = features.completionSource(context());
    next().answer(items);
    expect(await result).toMatchObject({
      from: end,
      options: [{ label: "counter", type: "variable", detail: "const counter: string" }],
    });

    result = features.completionSource(context());
    const { answer } = next();
    editor.dispatchUserEdit(end + 3, end + 3, "n");
    answer(items);
    expect(await result).toBeNull();
  });

  it("without a provider nothing is asked and the keys fall through", async () => {
    const { editor, features } = setup();
    editor.setLanguageFeatureProvider(null);
    expect(await features.formatDocument()).toBe(false);
    expect(
      features.keyBindings().every((binding) => binding.run?.(editor.getEditorView()) === false),
    ).toBe(true);
  });
});
