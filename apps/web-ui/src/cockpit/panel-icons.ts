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
/** A terminal window with a prompt; used for terminal panels and their menu entry. */
export const TERMINAL_ICON =
  '<svg class="coloride-terminal-icon" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M0 0h12v12H0z" fill="none"/><g fill="currentColor"><path d="M2.15 3.13c.2-.2.51-.2.71 0l2.5 2.5c.2.2.2.51 0 .71l-2.5 2.5c-.1.1-.23.15-.35.15L2.5 9a.47.47 0 0 1-.35-.15c-.2-.2-.2-.51 0-.71L4.3 5.99L2.15 3.84c-.2-.2-.2-.51 0-.71M9.5 8c.28 0 .5.22.5.5s-.22.5-.5.5h-4c-.28 0-.5-.22-.5-.5s.22-.5.5-.5z"/><path fill-rule="evenodd" d="M9.5 0A2.5 2.5 0 0 1 12 2.5v7A2.5 2.5 0 0 1 9.5 12h-7A2.5 2.5 0 0 1 0 9.5v-7A2.5 2.5 0 0 1 2.5 0zm-7 1C1.67 1 1 1.67 1 2.5v7c0 .83.67 1.5 1.5 1.5h7c.83 0 1.5-.67 1.5-1.5v-7c0-.83-.67-1.5-1.5-1.5z" clip-rule="evenodd"/></g></svg>';
export const CLOSE_PANEL_ICON = svg('<path d="M6 6l12 12M18 6L6 18"/>');
