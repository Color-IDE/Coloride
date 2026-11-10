// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  COLORIDE_STATE_VISUAL_TOKENS,
  ColorideEditorView,
  type EditorRangeDecoration,
  InMemoryBinaryHostBridge,
  colorideStateField,
  decodeEditorSnapshotBinary,
  decodeEditorTransactionBinary,
  describeDecorationAccessibleLabel,
  encodeEditorSnapshotBinary,
  encodeEditorTransactionBinary,
  highlightSnippetWithLezer,
  invalidateRangeOnLocalEdit,
} from "./index.js";

describe("@coloride/editor-cm6 — LOT-004 Blocking Suite", () => {
  it("synchronously invalidates ValidatedGreen (🟢) to StaleOrange (🟠) in < 1 ms on local edit and exposes color + icon + aria-label", () => {
    const lines = Array.from(
      { length: 30 },
      (_, i) => `export const line_${i + 1} = ${i + 1};`,
    ).join("\n");
    const bridge = new InMemoryBinaryHostBridge();
    const editor = new ColorideEditorView({
      initialDocumentId: "src/module.ts",
      initialContent: lines,
      ipcChannel: bridge,
      initialDecorations: [
        {
          fromLine: 10,
          toLine: 20,
          state: "ValidatedGreen",
          snapshotHash: "H1",
        },
        {
          fromLine: 22,
          toLine: 25,
          state: "ReviewYellow",
          snapshotHash: "H1",
        },
      ],
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    editor.mount(container);

    // Verify all 5 states expose distinct icon + color pair + accessible label
    const seenIcons = new Set<string>();
    for (const state of [
      "ValidatedGreen",
      "ReviewYellow",
      "FailedRed",
      "StaleOrange",
      "UnchangedBlue",
    ] as const) {
      const tokens = COLORIDE_STATE_VISUAL_TOKENS[state];
      expect(tokens.icon.length).toBeGreaterThan(0);
      expect(tokens.dark.background).toMatch(/^#[0-9a-f]{6}$/i);
      expect(tokens.dark.border).toMatch(/^#[0-9a-f]{6}$/i);
      expect(tokens.dark.text).toMatch(/^#[0-9a-f]{6}$/i);
      seenIcons.add(tokens.icon);
      const label = describeDecorationAccessibleLabel({
        fromLine: 10,
        toLine: 20,
        state,
        snapshotHash: "H1",
      });
      expect(label).toContain(tokens.icon);
    }
    expect(seenIcons.size).toBe(5);

    // Warm up V8 JIT on an untouched line (line 1) before measuring synchronous StateField transition (< 1 ms)
    editor.dispatchUserEdit(0, 0, "// warmup\n");
    editor.setValidationDecorations([
      {
        fromLine: 10,
        toLine: 20,
        state: "ValidatedGreen",
        snapshotHash: "H1",
      },
      {
        fromLine: 22,
        toLine: 25,
        state: "ReviewYellow",
        snapshotHash: "H1",
      },
    ]);

    // Insert a single space on line 15 inside the ValidatedGreen [10..20] range
    const line15 = editor.getEditorView().state.doc.line(15);
    const t0 = performance.now();
    const nextState = editor.getEditorView().state.update({
      changes: { from: line15.from, to: line15.from, insert: " " },
    }).state;
    const stateFieldElapsedMs = performance.now() - t0;
    expect(stateFieldElapsedMs).toBeLessThan(1);
    expect(nextState.field(colorideStateField).ranges[0]?.state).toBe("StaleOrange");

    editor.dispatchUserEdit(line15.from, line15.from, " ");

    const updatedDecorations = editor.getDecorations();
    expect(updatedDecorations[0]?.state).toBe("StaleOrange");
    expect(updatedDecorations[1]?.state).toBe("ReviewYellow");

    // Pure function helper also preserves the contract
    const pureUpdated = invalidateRangeOnLocalEdit(
      { fromLine: 10, toLine: 20, state: "ValidatedGreen", snapshotHash: "H1" },
      15,
    );
    expect(pureUpdated.state).toBe("StaleOrange");

    editor.destroy();
    container.remove();
  });

  it("defers save during IME composition and switches across 10 files in < 100 ms while dropping 50 ms delayed IPC events from file 1", async () => {
    const bridge = new InMemoryBinaryHostBridge();
    // Artificially delay IPC snapshots from file-1.ts by 50 ms
    bridge.setArtificialDelayMs("file-1.ts", 50);

    const editor = new ColorideEditorView({
      initialDocumentId: "file-1.ts",
      initialContent: "const greeting = '';",
      ipcChannel: bridge,
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    editor.mount(container);
    // Calling mount again with the same container must never remount CM6
    editor.mount(container);
    expect(editor.getStoreSnapshot().mountCount).toBe(1);

    // 1. Start IME composition inside file-1.ts ("日本語👩‍💻")
    const insertPos = "const greeting = '".length;
    editor.startImeComposition(insertPos);
    editor.updateImeComposition("にほん");
    expect(editor.getStoreSnapshot().imeComposing).toBe(true);

    let saveResolvedDuringIme = false;
    const pendingSavePromise = editor.requestSave().then((snap) => {
      saveResolvedDuringIme = true;
      return snap;
    });

    // Save must NOT complete while IME composition is still active
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(saveResolvedDuringIme).toBe(false);

    // Finish IME composition with committed Unicode + ZWJ emoji text
    editor.endImeComposition("日本語👩‍💻");
    const savedFile1Snap = await pendingSavePromise;
    expect(saveResolvedDuringIme).toBe(true);
    expect(editor.getDocumentText()).toBe("const greeting = '日本語👩‍💻';");
    expect(bridge.getSavedDiskText("file-1.ts", 1)).toBe("const greeting = '日本語👩‍💻';");
    expect(savedFile1Snap.document_id).toBe("file-1.ts");

    // Trigger another edit on file-1.ts whose IPC ACK will be delayed by 50 ms
    editor.dispatchUserEdit(0, 5, "let");

    // 2. Rapidly switch across 10 files in < 100 ms
    const switchStart = performance.now();
    for (let i = 2; i <= 10; i += 1) {
      const docId = `file-${i}.ts`;
      const content = `export const fileNumber = ${i}; // 👩‍💻 file ${i}\n`;
      const decs: EditorRangeDecoration[] = [
        {
          fromLine: 1,
          toLine: 1,
          state: "ValidatedGreen",
          snapshotHash: `hash-${i}`,
        },
      ];
      editor.switchDocument(docId, content, decs);
    }
    const switchElapsedMs = performance.now() - switchStart;
    expect(switchElapsedMs).toBeLessThan(100);

    // Verify EditorView was never unmounted/remounted
    expect(editor.getStoreSnapshot().mountCount).toBe(1);
    expect(editor.getStoreSnapshot().documentId).toBe("file-10.ts");

    // Wait 70 ms so the delayed 50 ms IPC event from file-1.ts arrives
    await new Promise((resolve) => setTimeout(resolve, 70));

    // Verify the delayed file-1.ts IPC event was dropped and never contaminated file-10.ts
    expect(editor.getStoreSnapshot().droppedStaleIpcPackets).toBeGreaterThanOrEqual(1);
    expect(editor.getDocumentText()).toBe("export const fileNumber = 10; // 👩‍💻 file 10\n");

    const file10SaveSnap = await editor.requestSave();
    expect(file10SaveSnap.document_id).toBe("file-10.ts");
    expect(bridge.getSavedDiskText("file-10.ts", editor.getStoreSnapshot().sessionGeneration)).toBe(
      "export const fileNumber = 10; // 👩‍💻 file 10\n",
    );

    editor.destroy();
    container.remove();
  });

  it("meets Lezer highlighting (< 2 ms), typing latency on 2,000-line TS file (p95 <= 16 ms), and 1 MB file open (p95 <= 150 ms) budgets", () => {
    // 1. Lezer syntax highlighting < 2 ms across supported languages
    const sampleTsx =
      "export function App({ title }: { title: string }) { return <div className='cockpit'>{title}</div>; }";
    // Warm up JIT once
    highlightSnippetWithLezer(sampleTsx, "tsx");

    const lezerStart = performance.now();
    const tokens = highlightSnippetWithLezer(sampleTsx, "tsx");
    const lezerElapsedMs = performance.now() - lezerStart;
    expect(tokens.length).toBeGreaterThan(5);
    expect(lezerElapsedMs).toBeLessThan(2);

    // 2. Continuous typing in a 2,000-line TypeScript file (p95 <= 16 ms)
    const twoThousandLines = Array.from(
      { length: 2000 },
      (_, idx) =>
        `export function computeMetric_${idx}(input: number): number { return input * ${idx}; }`,
    ).join("\n");

    const bridge = new InMemoryBinaryHostBridge();
    const editor = new ColorideEditorView({
      initialDocumentId: "src/large-metrics.ts",
      initialContent: twoThousandLines,
      ipcChannel: bridge,
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    editor.mount(container);

    const keystrokeSamplesMs: number[] = [];
    let cursor = editor.getDocumentText().length;
    for (let i = 0; i < 40; i += 1) {
      const ch = String.fromCharCode(97 + (i % 26));
      const t0 = performance.now();
      editor.dispatchUserEdit(cursor, cursor, ch);
      keystrokeSamplesMs.push(performance.now() - t0);
      cursor += 1;
    }
    keystrokeSamplesMs.sort((a, b) => a - b);
    const p95KeystrokeMs = keystrokeSamplesMs[Math.floor(keystrokeSamplesMs.length * 0.95)] ?? 0;
    expect(p95KeystrokeMs).toBeLessThanOrEqual(16);

    // 3. Open and render a 1 MB local file in p95 <= 150 ms
    const lineChunk =
      "export const row_東京_👩‍💻 = { id: 1024, status: 'ValidatedGreen', payload: 'Coloride CM6' };\n";
    const repeatCount = Math.ceil((1024 * 1024) / lineChunk.length);
    const oneMegabyteContent = lineChunk.repeat(repeatCount).slice(0, 1024 * 1024);

    const openSamplesMs: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      editor.switchDocument(`one-mb-${i}.ts`, oneMegabyteContent);
      openSamplesMs.push(performance.now() - t0);
    }
    openSamplesMs.sort((a, b) => a - b);
    const p95OpenMs = openSamplesMs[Math.floor(openSamplesMs.length * 0.95)] ?? 0;
    expect(p95OpenMs).toBeLessThanOrEqual(150);
    expect(editor.getDocumentText().length).toBe(oneMegabyteContent.length);

    editor.destroy();
    container.remove();
  });

  it("roundtrips binary EditorTransaction and EditorSnapshot payloads without JSON overhead", () => {
    const rawTx = {
      schema_version: 1,
      document_id: "src/app.tsx",
      session_generation: 7,
      base_revision: 41,
      op_id: "op-7-42",
      changes: [
        {
          range_utf16: { start: 12, end: 18 },
          range_utf8: { start: 12, end: 22 },
          inserted_text: "👩‍💻 東京",
        },
      ],
      selection: {
        anchor: 19,
        head: 19,
        cursor_line_col: { line: 2, col_utf16: 7 },
      },
      origin: { Agent: { task_id: "task-99" } } as const,
      ime_composing: false,
    };

    const encodedTx = encodeEditorTransactionBinary(rawTx);
    const decodedTx = decodeEditorTransactionBinary(encodedTx);
    expect(decodedTx).toEqual(rawTx);

    const rawSnap = {
      schema_version: 1,
      document_id: "src/app.tsx",
      session_generation: 7,
      interactive_revision: 42,
      journaled_revision: 42,
      disk_saved_revision: 40,
      content_blake3_hash: "blake3-deadbeef",
      has_unsaved_changes: true,
    };
    const encodedSnap = encodeEditorSnapshotBinary(rawSnap);
    const decodedSnap = decodeEditorSnapshotBinary(encodedSnap);
    expect(decodedSnap).toEqual(rawSnap);
  });
});
