const svg = (body: string) =>
  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** Rectangle cut by a vertical line: the new panel appears on the right. */
export const SPLIT_RIGHT_ICON = svg(
  '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
);
/** Rectangle cut by a horizontal line: the new panel appears below. */
export const SPLIT_DOWN_ICON = svg(
  '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/>',
);
/** A rectangle growing to its corners: show this panel alone. */
export const MAXIMIZE_ICON = svg(
  '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
);
/** Two rectangles: bring the other panels back. */
export const RESTORE_ICON = svg(
  '<rect x="3" y="4" width="8" height="7" rx="1"/><rect x="13" y="4" width="8" height="7" rx="1"/><rect x="3" y="13" width="18" height="7" rx="1"/>',
);
export const CLOSE_PANEL_ICON = svg('<path d="M6 6l12 12M18 6L6 18"/>');
