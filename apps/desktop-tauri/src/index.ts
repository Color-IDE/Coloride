import { createInitialCockpitShellState } from "@coloride/web-ui";

export function bootstrapDesktopShell() {
  return {
    appId: "dev.coloride.desktop",
    shell: createInitialCockpitShellState(),
  };
}
