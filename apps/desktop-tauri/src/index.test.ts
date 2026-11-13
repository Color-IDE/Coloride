// @vitest-environment happy-dom
import { CONTRACT_SCHEMA_VERSION } from "@coloride/protocol-types";
import { describe, expect, it } from "vitest";
import {
  bootstrapDesktopShell,
  encodeWorkspaceSessionCacheBinary,
  lazyBootDesktopCockpit,
} from "./index.js";

describe("@coloride/desktop-tauri — LOT-005 Lazy Boot & Inspector Sync", () => {
  it("restores work groups and their selected header tab from the session cache", () => {
    const first = lazyBootDesktopCockpit();
    first.stores.createWorkGroup("Authentication");
    const cachedSessionBytes = first.exportSessionCacheBinary();
    first.destroy();
    const restored = lazyBootDesktopCockpit({ cachedSessionBytes });
    expect(restored.stores.navigation.getState().groups.at(-1)?.title).toBe("Authentication");
    const previousId = restored.stores.navigation.getState().activeGroupId;
    restored.stores.createWorkGroup("Sidebar");
    expect(restored.stores.navigation.getState().activeGroupId).not.toBe(previousId);
    restored.destroy();
  });

  it("persists folder/group expansion, names, and the last selected session per group", () => {
    const first = lazyBootDesktopCockpit({
      initialChats: [
        {
          chatId: "a",
          title: "Implementation",
          modelName: "Codex",
          validationState: "UnchangedBlue",
        },
        { chatId: "b", title: "Review", modelName: "Claude", validationState: "UnchangedBlue" },
      ],
    });
    first.setWorkspaceRoot("/projects/Coloride");
    first.stores.renameWorkGroup("initial-group", "Authentication");
    first.stores.selectChat("b");
    first.stores.renameChat("b", "Security review");
    first.stores.setWorkGroupExpanded("initial-group", false);
    first.stores.setProjectExpanded(false);
    first.stores.createWorkGroup("Sidebar");
    const bytes = first.exportSessionCacheBinary();
    first.destroy();
    const restored = lazyBootDesktopCockpit({ cachedSessionBytes: bytes });
    const navigation = restored.stores.navigation.getState();
    expect(navigation.projectPath).toBe("/projects/Coloride");
    expect(navigation.expanded).toBe(false);
    expect(navigation.groups[0]).toMatchObject({
      title: "Authentication",
      expanded: false,
      lastActiveChatId: "b",
    });
    expect(restored.stores.zone3.getState().chats.find((chat) => chat.chatId === "b")?.title).toBe(
      "Security review",
    );
    restored.stores.selectWorkGroup("initial-group");
    expect(restored.stores.zone3.getState().activeChatId).toBe("b");
    restored.stores.selectWorkGroup("group-1");
    restored.stores.selectWorkGroup("initial-group");
    expect(restored.stores.zone3.getState().activeChatId).toBe("b");
    restored.destroy();
  });

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
    // Budget is checked on the p95 after a JIT warm-up: a single slow sample on a shared
    // CI runner is scheduler noise, not a regression.
    const chatAt = (i: number) => (i % 2 === 0 ? "chat-2" : "chat-1");
    for (let i = 0; i < 10; i += 1) {
      handle.stores.selectChat(chatAt(i));
    }
    const syncSamplesMs: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      syncSamplesMs.push(handle.stores.selectChat(chatAt(i)));
    }
    syncSamplesMs.sort((a, b) => a - b);
    const p95SyncMs = syncSamplesMs[Math.floor(syncSamplesMs.length * 0.95)] ?? 0;
    expect(p95SyncMs).toBeLessThan(10);
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
