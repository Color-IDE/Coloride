/**
 * Canonical monochrome dark surface palette for the Coloride Desktop Cockpit.
 */
export interface ColorideSurfacePalette {
  /** Exterior window background (`#000000`) */
  readonly exteriorBg: string;
  /** Main central chat & inspector background (`#1E1E1E`) */
  readonly mainBg: string;
  /** Z2 sidebar panel for projects, sessions & file tree (`#212121`) */
  readonly sidebarBg: string;
  /** Z1 vertical icon navigation rail (`#262626`) */
  readonly navigationRailBg: string;
  /** Integrated macOS top bar (`#262626`) */
  readonly topBarBg: string;
  /** Selected or hovered item in sidebar / rail (`#303030`) */
  readonly selectedHoverBg: string;
  /** Chat card surface (`#313131`) */
  readonly cardBg: string;
  /** Bottom prompt composer & terminal box surface (`#323232`) */
  readonly composerBg: string;
  /** Subtle divider & card border */
  readonly borderSubtle: string;
  /** Primary foreground text */
  readonly textPrimary: string;
  /** Secondary foreground text */
  readonly textSecondary: string;
  /** Muted foreground text */
  readonly textMuted: string;
}

export const COLORIDE_SURFACE_PALETTE: ColorideSurfacePalette = {
  exteriorBg: "#000000",
  mainBg: "#1E1E1E",
  sidebarBg: "#212121",
  navigationRailBg: "#262626",
  topBarBg: "#262626",
  selectedHoverBg: "#303030",
  cardBg: "#313131",
  composerBg: "#323232",
  borderSubtle: "rgba(255, 255, 255, 0.08)",
  textPrimary: "#ECECEC",
  textSecondary: "#B4B4B4",
  textMuted: "#8E8E8E",
} as const;

/**
 * Canonical layout geometry tokens for the macOS window frame and 4-Zone Cockpit.
 */
export interface ColorideLayoutMetrics {
  readonly macosTitlebarHeightPx: number;
  readonly macosTrafficLightsInsetPx: number;
  readonly navigationRailWidthPx: number;
  readonly navigationButtonSizePx: number;
  readonly navigationButtonFontSizePx: number;
  readonly bottomFrameGapPx: number;
  readonly rightFrameGapPx: number;
  readonly cardCornerRadiusPx: number;
}

export const COLORIDE_LAYOUT_METRICS: ColorideLayoutMetrics = {
  macosTitlebarHeightPx: 35,
  macosTrafficLightsInsetPx: 80,
  navigationRailWidthPx: 48,
  navigationButtonSizePx: 36,
  navigationButtonFontSizePx: 16,
  bottomFrameGapPx: 2,
  rightFrameGapPx: 2,
  cardCornerRadiusPx: 12,
} as const;
