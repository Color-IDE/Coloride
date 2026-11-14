import { CLOSE_PANEL_ICON, MAXIMIZE_ICON, RESTORE_ICON } from "../cockpit/panels/panel-icons.js";

/**
 * Icons of the Zone 2 option menus. Every one is drawn at 14 px with lines about 1.1 px thick,
 * as the panel header icons are: the 24-unit icons use a stroke of 2, the 512-unit one 42, and the
 * 16- and 512-unit icons that are filled outlines get a thin stroke of their own to match.
 */
const open = (viewBox: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="${viewBox}" aria-hidden="true">`;
const line = (body: string) =>
  `${open("0 0 24 24")}<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">${body}</g></svg>`;

/** A chevron pointing down: expand. */
export const MENU_CHEVRON_DOWN_ICON = line('<path d="m4 9 8 8 8-8"/>');
/** A chevron pointing up: collapse. */
export const MENU_CHEVRON_UP_ICON = line('<path d="m4 15 8-8 8 8"/>');
/** Two chevrons pointing down: expand everything. */
export const MENU_CHEVRONS_DOWN_ICON = line('<path d="m4 4 8 8 8-8"/><path d="m4 13 8 8 8-8"/>');
/** The same turned upside down: collapse everything. */
export const MENU_CHEVRONS_UP_ICON = line(
  '<g transform="translate(0 25) scale(1 -1)"><path d="m4 4 8 8 8-8"/><path d="m4 13 8 8 8-8"/></g>',
);
/** Two sheets: copy. */
export const MENU_COPY_ICON = `${open("0 0 512 512")}<rect width="336" height="336" x="128" y="128" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="42" rx="57" ry="57"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="42" d="m383.5 128l.5-24a56.16 56.16 0 0 0-56-56H112a64.19 64.19 0 0 0-64 64v216a56.16 56.16 0 0 0 56 56h24"/></svg>`;
/** A pencil: rename. */
export const MENU_RENAME_ICON = `${open("0 0 512 512")}<path fill="currentColor" stroke="currentColor" stroke-linejoin="round" stroke-width="12" d="m29.663 482.25l.087.087a24.85 24.85 0 0 0 17.612 7.342a25.2 25.2 0 0 0 8.1-1.345l142.006-48.172l272.5-272.5A88.832 88.832 0 0 0 344.334 42.039l-272.5 272.5l-48.168 142.002a24.84 24.84 0 0 0 5.997 25.709m337.3-417.584a56.832 56.832 0 0 1 80.371 80.373L411.5 180.873L331.127 100.5ZM99.744 331.884L308.5 123.127l80.373 80.373l-208.757 208.756l-121.634 41.262Z"/></svg>`;
/** A bin: delete. */
export const MENU_TRASH_ICON = `${open("0 0 16 16")}<path fill="currentColor" stroke="currentColor" stroke-linejoin="round" stroke-width="0.34" d="M14 2h-4c0-1.103-.897-2-2-2S6 .897 6 2H2a.5.5 0 0 0 0 1h.54l.809 9.708A2.513 2.513 0 0 0 5.84 15h4.319a2.514 2.514 0 0 0 2.491-2.292L13.459 3h.54a.5.5 0 0 0 0-1zM8 1c.551 0 1 .449 1 1H7c0-.551.449-1 1-1m3.655 11.625A1.51 1.51 0 0 1 10.16 14H5.841a1.51 1.51 0 0 1-1.495-1.375L3.544 3h8.914l-.802 9.625zM7 5.5v6a.5.5 0 0 1-1 0v-6a.5.5 0 0 1 1 0m3 0v6a.5.5 0 0 1-1 0v-6a.5.5 0 0 1 1 0"/></svg>`;
/** Stacked cards with a cross: close several sessions. */
export const MENU_CLOSE_MANY_ICON = line(
  '<path d="M7 9.667A2.667 2.667 0 0 1 9.667 7h8.666A2.667 2.667 0 0 1 21 9.667v8.666A2.667 2.667 0 0 1 18.333 21H9.667A2.667 2.667 0 0 1 7 18.333z"/><path d="M4.012 16.737A2 2 0 0 1 3 15V5c0-1.1.9-2 2-2h10c.75 0 1.158.385 1.5 1m-5 7.5l4.9 5m.1-5l-5.1 5"/>',
);
/** A folder with a bar: take a project off the list. */
export const MENU_FOLDER_MINUS_ICON = `${open("0 0 16 16")}<g fill="currentColor" stroke="currentColor" stroke-linejoin="round" stroke-width="0.34"><path d="m.5 3l.04.87a2 2 0 0 0-.342 1.311l.637 7A2 2 0 0 0 2.826 14H9v-1H2.826a1 1 0 0 1-.995-.91l-.637-7A1 1 0 0 1 2.19 4h11.62a1 1 0 0 1 .996 1.09L14.54 8h1.005l.256-2.819A2 2 0 0 0 13.81 3H9.828a2 2 0 0 1-1.414-.586l-.828-.828A2 2 0 0 0 6.172 1H2.5a2 2 0 0 0-2 2m5.672-1a1 1 0 0 1 .707.293L7.586 3H2.19q-.362.002-.683.12L1.5 2.98a1 1 0 0 1 1-.98z"/><path d="M11 11.5a.5.5 0 0 1 .5-.5h4a.5.5 0 1 1 0 1h-4a.5.5 0 0 1-.5-.5"/></g></svg>`;
/** An open folder: open a project. */
export const MENU_FOLDER_ICON = `${open("0 0 512 512")}<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="42" d="M64 192v-72a40 40 0 0 1 40-40h75.89a40 40 0 0 1 22.19 6.72l27.84 18.56a40 40 0 0 0 22.19 6.72H408a40 40 0 0 1 40 40v40"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="42" d="M479.9 226.55L463.68 392a40 40 0 0 1-39.93 40H88.25a40 40 0 0 1-39.93-40L32.1 226.55A32 32 0 0 1 64 192h384.1a32 32 0 0 1 31.8 34.55Z"/></svg>`;

export {
  CLOSE_PANEL_ICON as MENU_CLOSE_ICON,
  MAXIMIZE_ICON as MENU_MAXIMIZE_ICON,
  RESTORE_ICON as MENU_RESTORE_ICON,
};
