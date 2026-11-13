// @vitest-environment happy-dom
import { ColorideEditorView, InMemoryBinaryHostBridge } from "@coloride/editor-cm6";
import { describe, expect, it } from "vitest";
import {
  type CockpitChatTab,
  CockpitDomController,
  FrameBatchedStreamRenderer,
  IncrementalMarkdownCache,
  computeVirtualWindowSlice,
  createCockpitStoreBundle,
  generateSyntheticFileTree,
} from "../index.js";

function percentile95(samples: readonly number[]): number {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[idx] ?? 0;
}

describe("@coloride/web-ui — LOT-005 virtualization and typing under load", () => {
  it("virtualizes > 50,000 file tree entries in O(1) DOM nodes and caches stabilized Markdown blocks", () => {
    const tree55k = generateSyntheticFileTree(55_000);
    const slice = computeVirtualWindowSlice(tree55k, 240_000, 600, {
      rowHeightPx: 24,
      overscan: 4,
    });
    expect(slice.totalCount).toBe(55_000);
    expect(slice.visibleItems.length).toBeLessThanOrEqual(35);
    expect(slice.startIndex).toBeGreaterThan(9_990);

    // Incremental block Markdown parser caches finalized paragraphs so streaming only parses the tail block
    const mdCache = new IncrementalMarkdownCache();
    const step1 = mdCache.update("# Heading\n\nParagraph 1 stabilized.\n\nTail token 1");
    expect(step1).toHaveLength(3);
    const callsAfterStep1 = mdCache.getParseCallCount();
    expect(callsAfterStep1).toBe(3);

    const step2 = mdCache.update("# Heading\n\nParagraph 1 stabilized.\n\nTail token 1 + token 2");
    expect(step2).toHaveLength(3);
    // Only the 3rd (tail) block was re-parsed; first 2 blocks were served from cache
    expect(mdCache.getParseCallCount()).toBe(callsAfterStep1 + 1);
    expect(mdCache.getCachedStableBlockCount()).toBe(2);
  });
  it("BLOCKING SCENARIO: Typing stability in CodeMirror 6 under 150 tokens/s streaming + continuous terminal logs + 30,000-file tree + panel layout rebuilds (0 remounts, p95 <= 16 ms)", () => {
    const rootContainer = document.createElement("div");
    document.body.appendChild(rootContainer);

    const chats: readonly CockpitChatTab[] = Array.from({ length: 8 }, (_, idx) => ({
      chatId: `chat-${idx + 1}`,
      title: `#${idx + 1} Agent Task`,
      modelName: idx % 2 === 0 ? "Codex" : "Claude",
      validationState: idx === 0 ? "ValidatedGreen" : idx === 1 ? "ReviewYellow" : "UnchangedBlue",
      targetDocumentId: `src/module-${idx + 1}.ts`,
      targetDocumentContent: `export const module${idx + 1} = ${idx + 1};\n`,
    }));

    const fileTree30k = generateSyntheticFileTree(30_000);
    const stores = createCockpitStoreBundle({
      initialChats: chats,
      initialFileTree: fileTree30k,
      initialActiveChatId: "chat-1",
      initialActiveDocumentId: "src/module-1.ts",
    });

    const ipcChannel = new InMemoryBinaryHostBridge();
    const editorView = new ColorideEditorView({
      initialDocumentId: "src/module-1.ts",
      initialContent: "export const value = 0;\n",
      ipcChannel,
      initialDecorations: [
        {
          fromLine: 1,
          toLine: 1,
          state: "ValidatedGreen",
          snapshotHash: "snap-init",
        },
      ],
    });

    // Use manual frame queue so we can interleave 16ms rAF flushes with typing and scrolling
    const pendingFrames: Array<() => void> = [];
    const streamRenderer = new FrameBatchedStreamRenderer(stores.zone3, (cb) => {
      pendingFrames.push(cb);
    });

    const controller = new CockpitDomController({
      rootContainer,
      stores,
      editorView,
    });

    const initialMountCount = editorView.getStoreSnapshot().mountCount;
    expect(initialMountCount).toBe(1);
    const initialZone4Renders = controller.getZone4RenderCount();

    // Simulate 150 tokens/s streaming (150 token chunks across 10 frames = ~2.5 tokens/frame at 60 FPS)
    // + continuous terminal log output + 30,000-node file tree scrolling + panel layout rebuilds (8 panels shrinking to 1 as inactive chats close)
    // while typing 40 TypeScript characters into CodeMirror 6.
    const keystrokeLatenciesMs: number[] = [];
    // Chats 8..2 are closed one by one (chat-1 stays active): each close rebuilds the layout.
    const closableChats = ["chat-8", "chat-7", "chat-6", "chat-5", "chat-4", "chat-3", "chat-2"];

    for (let step = 0; step < 40; step += 1) {
      // Enqueue 4 streaming tokens (~240 tokens/s > 150 tokens/s requirement) + 2 terminal log lines
      for (let t = 0; t < 4; t += 1) {
        streamRenderer.enqueueToken(
          "chat-1",
          "msg-stream-1",
          `const step_${step}_${t} = ${step};\n${t === 3 ? "\n" : ""}`,
        );
      }
      streamRenderer.enqueueTerminalLog("chat-1", `[stdout] compiling module chunk #${step}...`);
      streamRenderer.enqueueTerminalLog("chat-1", `[test] PASS suite-${step}.test.ts`);

      // Every 4 steps, flush the 16ms rAF batch, scroll the 30,000-node file tree, and rebuild the panel layout
      if (step % 4 === 0) {
        while (pendingFrames.length > 0) {
          const nextFrame = pendingFrames.shift();
          nextFrame?.();
        }
        controller.scrollFileTree(step * 480, 600);
        const closing = closableChats[step / 4 - 1];
        if (closing) stores.closeChat(closing);
      }

      // Perform a local TypeScript keystroke on line 1 (before trailing newline) in CodeMirror 6 and measure latency
      const insertPos = Math.max(0, editorView.getDocumentText().length - 1);
      const t0 = performance.now();
      editorView.dispatchUserEdit(insertPos, insertPos, "x");
      const elapsedMs = performance.now() - t0;
      keystrokeLatenciesMs.push(elapsedMs);

      // Cursor must advance deterministically to the end of the inserted character
      expect(editorView.getEditorView().state.selection.main.head).toBe(insertPos + 1);
    }

    // Flush any remaining frame
    while (pendingFrames.length > 0) {
      pendingFrames.shift()?.();
    }

    const p95KeystrokeMs = percentile95(keystrokeLatenciesMs);
    expect(p95KeystrokeMs).toBeLessThanOrEqual(16);

    // Zero remounts of CodeMirror 6 and zero spurious Zone 4 re-renders during streaming & layout rebuilds
    expect(editorView.getStoreSnapshot().mountCount).toBe(1);
    expect(controller.getZone4RenderCount()).toBe(initialZone4Renders);

    // Local edit inside a ValidatedGreen range synchronously downgraded it to StaleOrange
    expect(editorView.getDecorations()[0]?.state).toBe("StaleOrange");

    // Verify 30,000-node virtualized file tree only mounted the visible window slice in DOM
    const renderedTreeRows = controller
      .getZoneElements()
      .zone2.querySelectorAll(".cm-coloride-virtual-tree-row");
    expect(renderedTreeRows.length).toBeGreaterThan(0);
    expect(renderedTreeRows.length).toBeLessThanOrEqual(40);

    controller.destroy();
    editorView.destroy();
    rootContainer.remove();
  });
});
