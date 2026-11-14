/** Geometry shared by persisted preferences, resize controls and shell columns. */
export type PanelSide = "sidebar" | "inspector";
export const PANEL_DIMENSIONS = {
  sidebar: { minPx: 180, maxPx: 560, maxShare: 0.5, defaultWidth: "clamp(200px, 19vw, 280px)" },
  inspector: { minPx: 280, maxPx: 1000, maxShare: 0.7, defaultWidth: "clamp(300px, 45%, 640px)" },
} as const;
