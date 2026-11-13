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
/** A window with the file tree as its right-hand column; `arrow` is the chevron in the editor. */
const treeIcon = (arrow: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M22 12C22 8.25027 22 6.3754 21.0451 5.06107C20.7367 4.6366 20.3634 4.26331 19.9389 3.95491C18.6246 3 16.7497 3 13 3H11C7.25027 3 5.3754 3 4.06107 3.95491C3.6366 4.26331 3.26331 4.6366 2.95491 5.06107C2 6.3754 2 8.25027 2 12C2 15.7497 2 17.6246 2.95491 18.9389C3.26331 19.3634 3.6366 19.7367 4.06107 20.0451C5.3754 21 7.25027 21 11 21H13C16.7497 21 18.6246 21 19.9389 20.0451C20.3634 19.7367 20.7367 19.3634 21.0451 18.9389C22 17.6246 22 15.7497 22 12Z"/><path d="M14.5 3.5L14.5 20.5"/><path d="M19 7H17.5" stroke-linecap="round"/><path d="M19 11H17.5" stroke-linecap="round"/><path d="${arrow}" stroke-linecap="round"/></svg>`;
/** Chevron pointing right: the tree is visible and this hides it (towards the right edge). */
export const TREE_HIDE_ICON = treeIcon(
  "M8 10L9.22654 11.0572C9.74218 11.5016 10 11.7239 10 12C10 12.2761 9.74218 12.4984 9.22654 12.9428L8 14",
);
/** The same icon with the chevron pointing left: the tree is hidden and this brings it in. */
export const TREE_SHOW_ICON = treeIcon(
  "M10 10L8.77346 11.0572C8.25782 11.5016 8 11.7239 8 12C8 12.2761 8.25782 12.4984 8.77346 12.9428L10 14",
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
