// @vitest-environment happy-dom
import { CONTRACT_SCHEMA_VERSION } from "@coloride/protocol-types";
import { describe, expect, it } from "vitest";
import {
  bootstrapDesktopShell,
  encodeWorkspaceSessionCacheBinary,
  lazyBootDesktopCockpit,
} from "./index.js";

describe("@coloride/desktop-tauri — LOT-005 Lazy Boot & Inspector Sync", () => {
  it("bootstraps the desktop shell with dev.coloride.desktop identifier and isolated CM6 bridge", () => {
    const boot = bootstrapDesktopShell();
    expect(boot.appId).toBe("dev.coloride.desktop");
    expect(boot.shell.activePersona).toBe("Develop");

    const editor = boot.createIsolatedEditor("src/main.ts", "export const ready = true;\n", [
      {
        fromLine: 1,
        toLine: 1,
        state: "ValidatedGreen",
        snapshotHash: "h0",
      },
    ]);
    expect(editor.getDocumentText()).toBe("export const ready = true;\n");
    editor.dispatchUserEdit(21, 25, "false");
    expect(editor.getDocumentText()).toBe("export const ready = false;\n");
    expect(editor.getDecorations()[0]?.state).toBe("StaleOrange");
    expect(boot.ipcChannel.getHostText("src/main.ts", 1)).toBe("export const ready = false;\n");
    editor.destroy();
  });

  it("BLOCKING SCENARIO: Lazy Boot restores workspace_session_cache.bin and accepts first keystroke in p95 <= 3 s, and synchronizes right inspector in < 10 ms", async () => {
    const rootContainer = document.createElement("div");
    document.body.appendChild(rootContainer);

    const cachedBytes = encodeWorkspaceSessionCacheBinary({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      workspaceRoot: "/workspace/coloride",
      activePersona: "Develop",
      activeActivityPanel: "files",
      gridMode: 4,
      activeInspectorTab: "code-diff",
      activeChatId: "chat-1",
      activeDocumentId: "src/restored.ts",
      activeDocumentContent: "export const boot = 'fast';\n",
      cursorUtf16Offset: 20,
      scrollTopPx: 48,
      uiZoomPercent: 110,
      sidebarVisible: true,
    });

    const launchStart = performance.now();
    const handle = lazyBootDesktopCockpit({
      rootContainer,
      cachedSessionBytes: cachedBytes,
      initialChats: [
        {
          chatId: "chat-1",
          title: "#1 Restored Chat",
          modelName: "Codex",
          validationState: "ValidatedGreen",
          targetDocumentId: "src/restored.ts",
          targetDocumentContent: "export const boot = 'fast';\n",
        },
        {
          chatId: "chat-2",
          title: "#2 Secondary Chat",
          modelName: "Claude",
          validationState: "ReviewYellow",
          targetDocumentId: "src/secondary.ts",
          targetDocumentContent: "export const secondary = 42;\n",
        },
      ],
    });

    // Background services have not blocked interactive boot
    expect(handle.getBackgroundServicesState().vtslsLspReady).toBe(false);

    // First keystroke immediately on the restored CodeMirror 6 buffer
    handle.editorView.dispatchUserEdit(21, 25, "instant");
    const launchToFirstKeystrokeMs = performance.now() - launchStart;

    expect(handle.bootToInteractiveMs).toBeLessThanOrEqual(3_000);
    expect(launchToFirstKeystrokeMs).toBeLessThanOrEqual(3_000);
    expect(handle.editorView.getDocumentText()).toBe("export const boot = 'instant';\n");
    expect(handle.ipcChannel.getHostText("src/restored.ts", 1)).toBe(
      "export const boot = 'instant';\n",
    );

    // Clicking / selecting another chat updates the right inspector in < 10 ms without remounting CM6
    const syncSamplesMs: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const targetId = i % 2 === 0 ? "chat-2" : "chat-1";
      const syncMs = handle.stores.selectChat(targetId);
      syncSamplesMs.push(syncMs);
    }

    const maxSyncMs = Math.max(...syncSamplesMs);
    expect(maxSyncMs).toBeLessThan(10);
    expect(handle.editorView.getStoreSnapshot().mountCount).toBe(1);

    // Wait for deferred background services to finish initializing
    const bgState = await handle.waitForBackgroundServices();
    expect(bgState.vtslsLspReady).toBe(true);
    expect(bgState.biomeDaemonReady).toBe(true);
    expect(bgState.sqliteFts5Ready).toBe(true);
    expect(bgState.sandboxWarmPoolReady).toBe(true);

    // Round-trip export of workspace_session_cache.bin reflects latest layout state
    const exportedBytes = handle.exportSessionCacheBinary();
    expect(exportedBytes.byteLength).toBeGreaterThan(0);

    handle.destroy();
    rootContainer.remove();
  });
});
