// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { bootstrapDesktopShell } from "./index.js";

describe("@coloride/desktop-tauri", () => {
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
});
