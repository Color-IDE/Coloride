// @vitest-environment happy-dom
import { ColorideEditorView, InMemoryBinaryHostBridge } from "@coloride/editor-cm6";
import { describe, expect, it } from "vitest";
import { CockpitDomController, createCockpitStoreBundle } from "../index.js";

describe("@coloride/web-ui — LOT-003..LOT-008 integration", () => {
  it("integrates LOT-003..LOT-008 in CockpitDomController: file tree click, Cmd+S atomic save, FTS5 unsaved search + secret redaction, AST symbols/impacted tests, and MCP onboarding modal", async () => {
    const rootContainer = document.createElement("div");
    document.body.appendChild(rootContainer);

    const stores = createCockpitStoreBundle({
      initialActiveDocumentId: "src/auth.ts",
      initialChats: [
        {
          chatId: "chat-1",
          title: "#1 Auth Service",
          modelName: "Codex",
          validationState: "ValidatedGreen",
          targetDocumentId: "src/auth.ts",
          targetDocumentContent: "export function verifySessionToken() {\n  return true;\n}\n",
        },
      ],
      initialFileTree: [
        {
          path: "src/auth.ts",
          name: "auth.ts",
          depth: 1,
          isDirectory: false,
          validationState: "ValidatedGreen",
        },
        {
          path: "src/billing.ts",
          name: "billing.ts",
          depth: 1,
          isDirectory: false,
          validationState: "ReviewYellow",
        },
        {
          path: "src/billing.test.ts",
          name: "billing.test.ts",
          depth: 1,
          isDirectory: false,
          validationState: "ValidatedGreen",
        },
      ],
    });

    const ipcChannel = new InMemoryBinaryHostBridge();
    const editorView = new ColorideEditorView({
      initialDocumentId: "src/auth.ts",
      initialContent: "export function verifySessionToken() {\n  return true;\n}\n",
      ipcChannel,
    });

    const controller = new CockpitDomController({
      rootContainer,
      stores,
      editorView,
    });

    const { shell, zone2, zone4 } = controller.getZoneElements();

    // 1. LOT-005: Clicking a file row in the Zone 4 File Tree opens it in Zone 4 CM6 (< 10 ms, 0 remounts)
    stores.updateInMemoryDocumentContent(
      "src/billing.ts",
      "export function chargeInvoice() {\n  return 100;\n}\n",
      false,
    );
    const billingRow = zone4.querySelector<HTMLElement>(
      '.cm-coloride-virtual-tree-row[data-path="src/billing.ts"]',
    );
    expect(billingRow).not.toBeNull();
    billingRow?.click();
    expect(stores.zone4.getState().activeDocumentId).toBe("src/billing.ts");
    expect(editorView.getDocumentText()).toContain("chargeInvoice");
    expect(editorView.getStoreSnapshot().mountCount).toBe(1);

    // 2. LOT-003: Editing marks Zone 4 unsaved indicator in-place; Ctrl+S saves atomically
    editorView.dispatchUserEdit(
      editorView.getDocumentText().length,
      editorView.getDocumentText().length,
      "// live_unsaved_marker sk-live1234567890abcdef\n",
    );
    expect(zone4.dataset.unsavedChanges).toBe("true");

    // 3. LOT-008: Global FTS5 search finds the unsaved in-memory edit and redacts inline secrets
    stores.setActivitySection("search");
    const hits = stores.runGlobalSearch("live_unsaved_marker");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.filePath).toBe("src/billing.ts");
    expect(hits[0]?.freshness).toBe("LiveUnsavedBuffer");
    expect(hits[0]?.snippet).toContain("[REDACTED_SECRET]");
    expect(hits[0]?.snippet).not.toContain("sk-live1234567890abcdef");
    expect(zone2.querySelectorAll(".coloride-search-result-item").length).toBe(1);

    // Save with Ctrl+S and verify unsaved indicator clears
    await controller.saveActiveDocument();
    expect(zone4.dataset.unsavedChanges).toBe("false");

    // 4. LOT-007: Switching to Debug (Cmd/Ctrl+3) renders AST symbols and impacted test files
    stores.setActivitySection("debug");
    const symbolItems = zone2.querySelectorAll(".coloride-ast-symbol-item");
    const impactedItems = zone2.querySelectorAll(".coloride-impacted-test-item");
    expect(symbolItems.length).toBeGreaterThanOrEqual(1);
    expect(symbolItems[0]?.textContent).toContain("chargeInvoice");
    expect(impactedItems.length).toBeGreaterThanOrEqual(1);
    expect(impactedItems[0]?.textContent).toContain("src/billing.test.ts");

    // 5. LOT-006: Switching to MCP (Cmd/Ctrl+5) renders the onboarding toggle and opens modal
    stores.setActivitySection("mcp");
    const openBtn = zone2.querySelector<HTMLButtonElement>(".coloride-open-onboarding-btn");
    expect(openBtn).not.toBeNull();
    openBtn?.click();
    expect(controller.getOnboardingController().store.getState().modalOpen).toBe(true);
    expect(shell.querySelector(".coloride-onboarding-modal")).not.toBeNull();
    expect(editorView.getStoreSnapshot().mountCount).toBe(1);

    controller.destroy();
    editorView.destroy();
    rootContainer.remove();
  });
});
