import { describe, expect, it } from "vitest";
import { bootstrapDesktopShell } from "./index.js";

describe("@coloride/desktop-tauri", () => {
  it("bootstraps the desktop shell with dev.coloride.desktop identifier", () => {
    const boot = bootstrapDesktopShell();
    expect(boot.appId).toBe("dev.coloride.desktop");
    expect(boot.shell.activePersona).toBe("Develop");
  });
});
