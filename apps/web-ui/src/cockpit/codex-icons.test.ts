// @vitest-environment happy-dom
import { ColorideEditorView, InMemoryBinaryHostBridge } from "@coloride/editor-cm6";
import { afterEach, describe, expect, it } from "vitest";
import { CockpitDomController, createCockpitStoreBundle, restoreCachedSession } from "../index.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("Codex mark and session number across the interface", () => {
  it("a Codex session shows the mark in its header tab, panel title and sidebar row, with its number after the name", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const chat = (chatId: string, title: string, modelName: string) => ({
      kind: "agent" as const,
      chatId,
      title,
      modelName,
      validationState: "UnchangedBlue" as const,
    });
    const stores = createCockpitStoreBundle({
      initialChats: [
        chat("a", "#16 New session", "Codex"),
        chat("b", "#17 Other", "Other model"),
        restoreCachedSession({
          chatId: "terminal",
          title: "Codex shell",
          kind: "terminal",
          modelName: "Codex",
          validationState: "UnchangedBlue",
        }),
      ],
    });
    const editorView = new ColorideEditorView({
      initialDocumentId: "src/main.ts",
      initialContent: "",
      ipcChannel: new InMemoryBinaryHostBridge(),
    });
    const controller = new CockpitDomController({ rootContainer: root, stores, editorView });
    cleanups.push(() => {
      controller.destroy();
      editorView.destroy();
      root.remove();
    });

    const tab = (id: string) =>
      root.querySelector<HTMLElement>(`.coloride-zone-3-header [data-chat-id="${id}"]`);
    // Header tab: the mark as its icon, and the number written after the name, in the same text.
    expect(
      tab("a")?.querySelector(".coloride-header-tab-icon .coloride-codex-icon"),
    ).not.toBeNull();
    expect(tab("a")?.querySelector(".coloride-header-tab-label")?.textContent).toBe(
      "New session #16",
    );
    // Another model keeps its state glyph.
    expect(tab("b")?.querySelector(".coloride-codex-icon")).toBeNull();

    const cell = (id: string) =>
      root.querySelector<HTMLElement>(`.coloride-chat-cell[data-chat-id="${id}"]`);
    expect(
      cell("a")?.querySelector(".coloride-chat-cell-title-icon .coloride-codex-icon"),
    ).not.toBeNull();
    expect(cell("b")?.querySelector(".coloride-chat-cell-title-icon")?.hasAttribute("hidden")).toBe(
      true,
    );

    const sidebarRows = Array.from(root.querySelectorAll(".sidebar-row--session"));
    expect(sidebarRows.some((row) => row.querySelector(".coloride-codex-icon"))).toBe(true);
    // Even a legacy terminal carrying a Codex model must not receive agent branding.
    expect(tab("terminal")?.querySelector(".coloride-terminal-icon")).not.toBeNull();
    expect(tab("terminal")?.querySelector(".coloride-codex-icon")).toBeNull();
    expect(cell("terminal")?.querySelector(".coloride-codex-icon")).toBeNull();
    const terminalRow = sidebarRows.find((row) => row.textContent?.includes("Codex shell"));
    expect(terminalRow?.querySelector(".coloride-terminal-icon")).not.toBeNull();
    expect(terminalRow?.querySelector(".coloride-codex-icon")).toBeNull();
  });
});
