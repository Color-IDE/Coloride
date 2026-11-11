import {
  COLORIDE_LAYOUT_METRICS,
  COLORIDE_SURFACE_PALETTE,
  type ColorideLayoutMetrics,
  type ColorideSurfacePalette,
} from "./theme-tokens.js";

export const COLORIDE_THEME_STYLE_ID = "coloride-cockpit-theme-styles";

/**
 * Generate runtime CSS custom properties from `ColorideSurfacePalette` and `ColorideLayoutMetrics`
 * consumed by Tailwind v4 (`src/theme/tailwind.css`).
 */
export function buildCockpitThemeCss(
  palette: ColorideSurfacePalette = COLORIDE_SURFACE_PALETTE,
  metrics: ColorideLayoutMetrics = COLORIDE_LAYOUT_METRICS,
): string {
  const totalVerticalInsetPx = metrics.macosTitlebarHeightPx + metrics.bottomFrameGapPx;

  return `:root {
  --color-exterior: ${palette.exteriorBg};
  --color-main: ${palette.mainBg};
  --color-sidebar: ${palette.sidebarBg};
  --color-nav-rail: ${palette.navigationRailBg};
  --color-topbar: ${palette.topBarBg};
  --color-selected: ${palette.selectedHoverBg};
  --color-card: ${palette.cardBg};
  --color-composer: ${palette.composerBg};
  --color-text-primary: ${palette.textPrimary};
  --color-text-secondary: ${palette.textSecondary};
  --color-text-muted: ${palette.textMuted};
  --border-subtle: ${palette.borderSubtle};
  --layout-titlebar-h: ${metrics.macosTitlebarHeightPx}px;
  --layout-bottom-gap: ${metrics.bottomFrameGapPx}px;
  --layout-right-gap: ${metrics.rightFrameGapPx}px;
  --layout-shell-h: calc(100vh - ${totalVerticalInsetPx}px);
}`;
}

/**
 * Inject or update the runtime theme variables inside `doc.head`.
 */
export function injectCockpitThemeStyles(
  doc: Document,
  palette: ColorideSurfacePalette = COLORIDE_SURFACE_PALETTE,
  metrics: ColorideLayoutMetrics = COLORIDE_LAYOUT_METRICS,
): HTMLStyleElement {
  let styleEl = doc.getElementById(COLORIDE_THEME_STYLE_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = doc.createElement("style");
    styleEl.id = COLORIDE_THEME_STYLE_ID;
    doc.head.appendChild(styleEl);
  }
  styleEl.textContent = buildCockpitThemeCss(palette, metrics);
  return styleEl;
}
