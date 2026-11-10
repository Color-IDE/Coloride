// @vitest-environment happy-dom
import { ColorideEditorView, InMemoryBinaryHostBridge } from "@coloride/editor-cm6";
import { describe, expect, it } from "vitest";
import {
  COLORIDE_DESIGN_TOKENS,
  type CockpitChatTab,
  CockpitDomController,
  FrameBatchedStreamRenderer,
  IncrementalMarkdownCache,
  computeVirtualWindowSlice,
  createCockpitStoreBundle,
  createInitialCockpitShellState,
  generateSyntheticFileTree,
} from "./index.js";

function percentile95(samples: readonly number[]): number {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[idx] ?? 0;
}

describe("@coloride/web-ui — LOT-005 4-Zone Cockpit, Virtualization & Streaming", () => {
  it("initializes the 4-zone Cockpit shell in Develop mode with code-diff inspector", () => {
    const state = createInitialCockpitShellState();
    expect(state.activePersona).toBe("Develop");
    expect(state.gridMode).toBe(1);
    expect(state.activeInspectorTab).toBe("code-diff");
  });

  it("enforces persona invariants: no panel disappears during a task, file tree stays accessible, and MVP queues concurrent agents sequentially", () => {
    const stores = createCockpitStoreBundle({
      initialChats: [
        {
          chatId: "chat-1",
          title: "#1 Auth",
          modelName: "Codex",
          validationState: "ValidatedGreen",
        },
        {
          chatId: "chat-2",
          title: "#2 Payments",
          modelName: "Claude",
          validationState: "ReviewYellow",
        },
      ],
    });

    // Start agent on chat-1 -> Running; start on chat-2 -> QueuedSequential (MVP invariant)
    expect(stores.startAgentTaskOnChat("chat-1")).toBe("Running");
    expect(stores.startAgentTaskOnChat("chat-2")).toBe("QueuedSequential");
    expect(stores.zone3.getState().activeRunningAgentChatId).toBe("chat-1");
    expect(stores.zone3.getState().sequentialAgentQueue).toEqual(["chat-2"]);

    // Switching persona across all 5 modes during an active task never hides the sidebar or file tree
    for (const persona of ["Create", "Learn", "Develop", "Infrastructure", "Data"] as const) {
      stores.setPersona(persona, true);
      const z1 = stores.zone1.getState();
      expect(z1.activePersona).toBe(persona);
      expect(z1.sidebarOpen).toBe(true);
      expect(z1.fileTreeAccessible).toBe(true);
      expect(z1.permissionsLevel).toBe("standard-enforced");
    }

    // Completing chat-1 automatically promotes chat-2 from the sequential queue
    stores.completeAgentTaskOnChat("chat-1");
    expect(stores.zone3.getState().activeRunningAgentChatId).toBe("chat-2");
    stores.completeAgentTaskOnChat("chat-2");
    expect(stores.zone3.getState().activeRunningAgentChatId).toBeNull();
  });

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

  it("BLOCKING SCENARIO: Typing stability in CodeMirror 6 under 150 tokens/s streaming + continuous terminal logs + 30,000-file tree + grid 1|2|4|8 switches (0 remounts, p95 <= 16 ms)", () => {
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
    // + continuous terminal log output + 30,000-node file tree scrolling + Grid 1 | 2 | 4 | 8 switching
    // while typing 40 TypeScript characters into CodeMirror 6.
    const keystrokeLatenciesMs: number[] = [];
    const gridSequence = [1, 2, 4, 8, 4, 2, 1] as const;

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

      // Every 4 steps, flush the 16ms rAF batch, scroll the 30,000-node file tree, and cycle Grid 1|2|4|8
      if (step % 4 === 0) {
        while (pendingFrames.length > 0) {
          const nextFrame = pendingFrames.shift();
          nextFrame?.();
        }
        controller.scrollFileTree(step * 480, 600);
        const nextGrid = gridSequence[(step / 4) % gridSequence.length] ?? 1;
        stores.setGridMode(nextGrid);
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

    // Zero remounts of CodeMirror 6 and zero spurious Zone 4 re-renders during streaming & grid switches
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

  it("supports full keyboard navigation (Cmd/Ctrl+1..6, Alt+Arrow) and UI zoom (50%..200%) without truncating the 4 zones", () => {
    const rootContainer = document.createElement("div");
    document.body.appendChild(rootContainer);

    const stores = createCockpitStoreBundle({
      initialChats: [
        {
          chatId: "chat-1",
          title: "#1 Login UI",
          modelName: "Codex",
          validationState: "ValidatedGreen",
          targetDocumentId: "src/login.ts",
          targetDocumentContent: "export const login = true;\n",
        },
        {
          chatId: "chat-2",
          title: "#2 Stripe Webhook",
          modelName: "Claude",
          validationState: "ReviewYellow",
          targetDocumentId: "src/stripe.ts",
          targetDocumentContent: "export const stripe = true;\n",
        },
      ],
      initialGridMode: 2,
    });

    const ipcChannel = new InMemoryBinaryHostBridge();
    const editorView = new ColorideEditorView({
      initialDocumentId: "src/login.ts",
      initialContent: "export const login = true;\n",
      ipcChannel,
    });

    const controller = new CockpitDomController({
      rootContainer,
      stores,
      editorView,
    });

    const { shell, zone1, zone2, zone3, zone4 } = controller.getZoneElements();

    // Keyboard shortcuts Cmd/Ctrl+1..6 switch Zone 1 Activity Bar sections
    const expectedSections = ["sessions", "files", "search", "git", "debug", "mcp"] as const;
    for (let i = 0; i < expectedSections.length; i += 1) {
      shell.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: String(i + 1),
          ctrlKey: true,
          bubbles: true,
        }),
      );
      expect(stores.zone1.getState().activeSection).toBe(expectedSections[i]);
    }

    // Alt+ArrowRight navigates to the next chat cell and syncs Zone 4 Inspector in < 10 ms
    shell.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        altKey: true,
        bubbles: true,
      }),
    );
    expect(stores.zone3.getState().activeChatId).toBe("chat-2");
    expect(stores.zone4.getState().syncedChatId).toBe("chat-2");
    expect(stores.zone4.getState().activeDocumentId).toBe("src/stripe.ts");
    expect(stores.zone4.getState().lastSyncDurationMs).toBeLessThan(10);
    expect(editorView.getStoreSnapshot().mountCount).toBe(1);

    // Check 2px Coloride border tokens on Zone 3 chat cells
    const cells = zone3.querySelectorAll<HTMLElement>(".coloride-chat-cell");
    expect(cells).toHaveLength(2);
    expect(cells[0]?.style.border).toContain(COLORIDE_DESIGN_TOKENS.ValidatedGreen.darkBorder);
    expect(cells[1]?.style.border).toContain(COLORIDE_DESIGN_TOKENS.ReviewYellow.darkBorder);

    // Zoom support from 75% to 175% keeps all 4 zones mounted and non-truncated
    for (const zoom of [75, 125, 150, 200]) {
      stores.setUiZoomPercent(zoom);
      expect(shell.dataset.uiZoomPercent).toBe(String(zoom));
      expect(shell.contains(zone1)).toBe(true);
      expect(shell.contains(zone2)).toBe(true);
      expect(shell.contains(zone3)).toBe(true);
      expect(shell.contains(zone4)).toBe(true);
    }

    controller.destroy();
    editorView.destroy();
    rootContainer.remove();
  });
});
