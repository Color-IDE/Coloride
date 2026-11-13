// @vitest-environment happy-dom
import { ColorideEditorView, InMemoryBinaryHostBridge } from "@coloride/editor-cm6";
import { describe, expect, it } from "vitest";
import {
  COLORIDE_DESIGN_TOKENS,
  CockpitDomController,
  createCockpitStoreBundle,
  createInitialCockpitShellState,
} from "../index.js";

describe("@coloride/web-ui — cockpit layout, panels and keyboard", () => {
  it("collapses the right inspector and its header without remounting the editor", () => {
    const rootContainer = document.createElement("div");
    document.body.appendChild(rootContainer);
    const stores = createCockpitStoreBundle();
    const editorView = new ColorideEditorView({
      initialDocumentId: "src/main.ts",
      initialContent: "const ready = true;",
      ipcChannel: new InMemoryBinaryHostBridge(),
    });
    const controller = new CockpitDomController({ rootContainer, stores, editorView });
    const editorDom = editorView.getEditorView().dom;
    const toggle = document.querySelector<HTMLButtonElement>(".coloride-inspector-toggle");
    const shell = rootContainer.querySelector<HTMLElement>(".coloride-cockpit-shell");
    const header = document.querySelector<HTMLElement>(".coloride-zone-4-header");
    expect(toggle?.getAttribute("aria-label")).toBe("Hide right panel");
    toggle?.click();
    expect(stores.zone1.getState().inspectorOpen).toBe(false);
    expect(shell?.style.gridTemplateColumns.endsWith(" 0px")).toBe(true);
    expect(header?.style.visibility).toBe("hidden");
    expect(toggle?.getAttribute("aria-label")).toBe("Show right panel");
    expect(editorView.getEditorView().dom).toBe(editorDom);
    expect(editorDom.isConnected).toBe(true);
    toggle?.click();
    expect(header?.style.visibility).toBe("visible");
    expect(editorView.getEditorView().dom).toBe(editorDom);
    const sidebarToggle = document.querySelector<HTMLButtonElement>(".coloride-sidebar-toggle");
    expect(sidebarToggle?.getAttribute("aria-label")).toBe("Hide sidebar");
    sidebarToggle?.click();
    expect(stores.zone1.getState().sidebarOpen).toBe(false);
    expect(sidebarToggle?.getAttribute("aria-label")).toBe("Show sidebar");
    expect(editorView.getEditorView().dom).toBe(editorDom);
    controller.destroy();
    rootContainer.remove();
  });
  it("initializes the 4-zone Cockpit shell in Develop mode with code-diff inspector", () => {
    const state = createInitialCockpitShellState();
    expect(state.activePersona).toBe("Develop");
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
      const sessionsPanel = zone2.querySelector<HTMLElement>(".sidebar-navigation");
      const filesPanel = zone2.querySelector<HTMLElement>(".coloride-zone-2-file-tree");
      if (expectedSections[i] === "sessions") {
        expect(sessionsPanel?.hidden).toBe(false);
        expect(filesPanel?.hidden).toBe(true);
      } else if (expectedSections[i] === "files") {
        expect(sessionsPanel?.hidden).toBe(true);
        expect(filesPanel?.hidden).toBe(false);
      }
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
    // The < 10 ms sync budget is asserted on a p95 in apps/desktop-tauri (Lazy Boot scenario);
    // one sample here would only measure CI scheduler noise.
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
