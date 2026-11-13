import type { ExternalIdeDiscoveredPaths, OsPlatformId } from "./types.js";

/**
 * Resolve standard read-only configuration paths for VS Code, Cursor, and Claude Desktop
 * across macOS, Windows, and Linux (`LOT-006`).
 */
export function resolveExternalIdePaths(
  platform: OsPlatformId,
  homeDir: string,
  appDataOverride?: string,
  xdgConfigOverride?: string,
): readonly ExternalIdeDiscoveredPaths[] {
  const sep = platform === "Windows" ? "\\" : "/";
  const join = (...parts: string[]) =>
    parts
      .map((p, idx) => (idx === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
      .join(sep);

  const baseConfigDir =
    platform === "MacOs"
      ? join(homeDir, "Library", "Application Support")
      : platform === "Windows"
        ? (appDataOverride ?? join(homeDir, "AppData", "Roaming"))
        : (xdgConfigOverride ?? join(homeDir, ".config"));

  return [
    {
      source: "VsCode",
      platform,
      settingsJsonPath: join(baseConfigDir, "Code", "User", "settings.json"),
      keybindingsJsonPath: join(baseConfigDir, "Code", "User", "keybindings.json"),
      mcpConfigJsonPath: join(baseConfigDir, "Code", "User", "mcp.json"),
    },
    {
      source: "Cursor",
      platform,
      settingsJsonPath: join(baseConfigDir, "Cursor", "User", "settings.json"),
      keybindingsJsonPath: join(baseConfigDir, "Cursor", "User", "keybindings.json"),
      mcpConfigJsonPath: join(homeDir, ".cursor", "mcp.json"),
    },
    {
      source: "ClaudeDesktop",
      platform,
      settingsJsonPath: null,
      keybindingsJsonPath: null,
      mcpConfigJsonPath: join(baseConfigDir, "Claude", "claude_desktop_config.json"),
    },
  ];
}
