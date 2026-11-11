import type { Compartment, Extension } from "@codemirror/state";
import { EditorView, type KeyBinding, keymap } from "@codemirror/view";

export type KeymapPresetId = "VsCode" | "Vim" | "JetBrains";

export interface Cm6TranslatedKeybinding {
  readonly rawKey: string;
  readonly cm6Key: string;
  readonly command: string;
  readonly whenClause?: string | undefined;
}

export interface DeclarativeVsixTheme {
  readonly label: string;
  readonly uiTheme: "vs-dark" | "vs" | "hc-black" | string;
  readonly editorBackground: string;
  readonly editorForeground: string;
  readonly fontFamily?: string | undefined;
  readonly fontSizePx?: number | undefined;
}

export interface DeclarativeVsixSnippet {
  readonly language: string;
  readonly name: string;
  readonly prefix: string;
  readonly body: readonly string[];
  readonly description?: string | undefined;
}

export interface DeclarativeVsixBundle {
  readonly extensionId: string;
  readonly displayName: string;
  readonly version: string;
  readonly themes: readonly DeclarativeVsixTheme[];
  readonly iconThemes: readonly string[];
  readonly snippets: readonly DeclarativeVsixSnippet[];
  readonly keybindings: readonly Cm6TranslatedKeybinding[];
  readonly imperativeEntrypointQuarantined: boolean;
  readonly executedJsEntrypoints: 0;
}

export const DEFAULT_COLORIDE_CM6_THEME: DeclarativeVsixTheme = {
  label: "Coloride Dark (WCAG AAA)",
  uiTheme: "vs-dark",
  editorBackground: "#1e1e1e",
  editorForeground: "#d4d4d4",
  fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, monospace',
  fontSizePx: 13,
};

/**
 * Translate a VS Code / Cursor keybinding string (e.g. `"ctrl+shift+p"` or `"cmd+k cmd+s"`)
 * into CodeMirror 6 keybinding format (`"Mod-Shift-p"`, `"Mod-k Mod-s"`).
 */
export function translateVsCodeKeyToCm6(rawKey: string): string {
  return rawKey
    .trim()
    .split(/\s+/)
    .filter((chord) => chord.length > 0)
    .map((chord) =>
      chord
        .split("+")
        .filter((part) => part.length > 0)
        .map((part) => {
          const lower = part.trim().toLowerCase();
          switch (lower) {
            case "cmd":
            case "ctrl":
            case "meta":
            case "ctrlcmd":
            case "cmdorctrl":
              return "Mod";
            case "shift":
              return "Shift";
            case "alt":
            case "opt":
            case "option":
              return "Alt";
            case "enter":
            case "return":
              return "Enter";
            case "esc":
            case "escape":
              return "Escape";
            case "backspace":
              return "Backspace";
            case "delete":
            case "del":
              return "Delete";
            case "tab":
              return "Tab";
            case "space":
              return "Space";
            case "up":
            case "arrowup":
              return "ArrowUp";
            case "down":
            case "arrowdown":
              return "ArrowDown";
            case "left":
            case "arrowleft":
              return "ArrowLeft";
            case "right":
            case "arrowright":
              return "ArrowRight";
            default:
              return lower;
          }
        })
        .join("-"),
    )
    .join(" ");
}

/**
 * Expand a VS Code snippet body (replacing `${1:default}` with `default` and `$0` with cursor position).
 */
export function renderSnippetTemplate(bodyLines: readonly string[]): {
  readonly text: string;
  readonly cursorRelativeOffset: number;
} {
  const joined = bodyLines.join("\n");
  const withPlaceholders = joined.replace(/\$\{\d+:([^}]+)\}/g, "$1").replace(/\$\{\d+\}/g, "");
  const zeroIdx = withPlaceholders.indexOf("$0");
  if (zeroIdx >= 0) {
    const clean = withPlaceholders.replace("$0", "");
    return { text: clean, cursorRelativeOffset: zeroIdx };
  }
  return { text: withPlaceholders, cursorRelativeOffset: withPlaceholders.length };
}

/**
 * Canonical preset command table for `VS Code`, `Vim`, and `JetBrains` keymaps in CodeMirror 6.
 */
export const KEYMAP_PRESET_BINDINGS: Record<KeymapPresetId, readonly Cm6TranslatedKeybinding[]> = {
  VsCode: [
    {
      rawKey: "ctrl+shift+p",
      cm6Key: "Mod-Shift-p",
      command: "workbench.action.showCommands",
    },
    {
      rawKey: "ctrl+p",
      cm6Key: "Mod-p",
      command: "workbench.action.quickOpen",
    },
    {
      rawKey: "ctrl+/",
      cm6Key: "Mod-/",
      command: "editor.action.commentLine",
    },
    {
      rawKey: "alt+shift+f",
      cm6Key: "Alt-Shift-f",
      command: "editor.action.formatDocument",
    },
  ],
  Vim: [
    {
      rawKey: "escape",
      cm6Key: "Escape",
      command: "vim.enterNormalMode",
    },
    {
      rawKey: "ctrl+r",
      cm6Key: "Mod-r",
      command: "vim.redo",
    },
    {
      rawKey: "ctrl+w",
      cm6Key: "Mod-w",
      command: "vim.windowPrefix",
    },
    {
      rawKey: "ctrl+f",
      cm6Key: "Mod-f",
      command: "vim.pageDown",
    },
  ],
  JetBrains: [
    {
      rawKey: "alt+enter",
      cm6Key: "Alt-Enter",
      command: "jetbrains.showIntentionActions",
    },
    {
      rawKey: "ctrl+d",
      cm6Key: "Mod-d",
      command: "jetbrains.duplicateLine",
    },
    {
      rawKey: "ctrl+y",
      cm6Key: "Mod-y",
      command: "jetbrains.deleteLine",
    },
    {
      rawKey: "ctrl+alt+l",
      cm6Key: "Mod-Alt-l",
      command: "jetbrains.reformatCode",
    },
  ],
};

export function createKeymapExtension(
  preset: KeymapPresetId,
  customBindings: readonly Cm6TranslatedKeybinding[],
  onCommandTriggered?: (command: string, cm6Key: string) => void,
): Extension {
  const merged = [...KEYMAP_PRESET_BINDINGS[preset], ...customBindings];
  const cmBindings: KeyBinding[] = merged.map((entry) => ({
    key: entry.cm6Key,
    run: () => {
      onCommandTriggered?.(entry.command, entry.cm6Key);
      return true;
    },
  }));
  return keymap.of(cmBindings);
}

export function createThemeExtension(theme: DeclarativeVsixTheme): Extension {
  const fontFamily =
    theme.fontFamily ??
    '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, monospace';
  const fontSizePx = theme.fontSizePx ?? 13;
  const lineHeightPx = Math.round(fontSizePx * 1.5);
  return EditorView.theme(
    {
      "&": {
        "--coloride-review-add-bg": "rgba(74, 222, 128, 0.10)",
        "--coloride-review-mod-bg": "rgba(210, 153, 34, 0.10)",
        "--coloride-review-del-bg": "rgba(248, 113, 113, 0.10)",
        "--coloride-review-add-number": "#8ea995",
        "--coloride-review-mod-number": "#b4a282",
        backgroundColor: theme.editorBackground,
        color: theme.editorForeground,
        fontFamily,
        fontSize: `${fontSizePx}px`,
        lineHeight: `${lineHeightPx}px`,
        height: "100%",
      },
      "&.cm-focused": {
        outline: "none",
      },
      ".cm-scopeGuideLayer": {
        pointerEvents: "none",
        zIndex: "2",
      },
      ".cm-scopeGuide": {
        pointerEvents: "none",
        backgroundColor: "rgba(255, 255, 255, 0.14)",
      },
      ".cm-scopeGuide-active": {
        backgroundColor: "rgba(255, 255, 255, 0.30)",
      },
      ".cm-scroller": {
        fontFamily,
        fontSize: `${fontSizePx}px`,
        lineHeight: `${lineHeightPx}px`,
        overflow: "auto",
        scrollbarWidth: "none",
        scrollbarGutter: "auto",
      },
      ".cm-scroller::-webkit-scrollbar": {
        display: "none",
        width: "0",
        height: "0",
      },
      ".cm-content": {
        caretColor: "#f0f4f8",
        fontFamily,
        fontSize: `${fontSizePx}px`,
        lineHeight: `${lineHeightPx}px`,
        paddingTop: "0px",
        paddingBottom: "4px",
        boxSizing: "border-box",
        minHeight: "100%",
      },
      ".cm-widgetBuffer": {
        display: "inline",
        verticalAlign: "text-top",
        height: "1em",
        width: "0",
        maxWidth: "none",
        maxHeight: "none",
      },
      ".cm-line": {
        padding: "0",
        fontSize: `${fontSizePx}px`,
        lineHeight: `${lineHeightPx}px`,
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "#f0f4f8",
        borderLeftWidth: "1.5px",
      },
      ".cm-line ::selection, .cm-line::selection, .cm-content ::selection": {
        backgroundColor: "transparent !important",
        color: "inherit",
      },
      ".cm-textSelectionLayer .cm-selectionPath": {
        overflow: "visible",
        pointerEvents: "none",
      },
      ".cm-textSelectionLayer .cm-selectionPath-fill": {
        fill: "rgba(148, 163, 184, 0.24) !important",
      },
      ".cm-textSelectionLayer": {
        zIndex: "1",
      },
      ".cm-selectionLayer": {
        zIndex: "0",
      },
      ".cm-activeLine": {
        backgroundColor: "rgba(255, 255, 255, 0.04)",
      },
      "&.cm-has-selection .cm-activeLine": {
        backgroundColor: "transparent",
      },
      "&.cm-has-selection .cm-activeLineGutter": {
        backgroundColor: "transparent",
      },
      ".cm-gutters, .cm-gutters.cm-gutters-before, .cm-gutters.cm-gutters-after": {
        backgroundColor: theme.editorBackground,
        color: "#6b6b6b",
        fontFamily,
        fontSize: `${fontSizePx}px`,
        lineHeight: `${lineHeightPx}px`,
        border: "none",
        boxShadow: "none",
        userSelect: "none",
      },
      ".cm-gutter": {
        backgroundColor: "transparent",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "rgba(255, 255, 255, 0.04)",
        color: "#a0a0a5",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        padding: "0 8px 0 6px",
        minWidth: "calc(3ch + 16px)",
        boxSizing: "border-box",
        fontFamily,
        fontSize: `${fontSizePx}px`,
        lineHeight: `${lineHeightPx}px`,
        textAlign: "right",
        fontVariantNumeric: "tabular-nums",
        userSelect: "none",
        position: "relative",
      },
      ".cm-lineNumbers .cm-gutterElement.coloride-selected-line-gutter": {
        color: "#c8c8cc",
      },
      ".cm-foldGutter": {
        width: "18px",
        minWidth: "18px",
        position: "relative",
        zIndex: "2",
        userSelect: "none",
      },
      ".cm-foldGutter .cm-gutterElement": {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      },
      ".coloride-fold-btn": {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "14px",
        height: "14px",
        borderRadius: "4px",
        color: "#6b6b6b",
        cursor: "pointer",
        lineHeight: "0",
        opacity: "0",
      },
      ".cm-foldGutter:hover .coloride-fold-btn": {
        opacity: "1",
      },
      ".coloride-fold-btn svg": {
        display: "block",
        width: "10px",
        height: "10px",
        transition: "transform 0.12s ease",
      },
      ".coloride-fold-btn.is-closed svg": {
        transform: "rotate(-90deg)",
      },
      ".coloride-fold-btn:hover": {
        backgroundColor: "rgba(255, 255, 255, 0.10)",
        color: "#a0a0a5",
      },
      ".cm-foldPlaceholder": {
        backgroundColor: "transparent",
        border: "none",
        color: "#6b6b6b !important",
        margin: "0 2px",
        padding: "0 4px",
        borderRadius: "3px",
        cursor: "pointer",
      },
      ".cm-matchingBracket, .cm-nonmatchingBracket": {
        backgroundColor: "#3b3b3b",
        outline: "none",
      },
    },
    { dark: theme.uiTheme !== "vs" },
  );
}

export function createKeymapCompartmentExtension(
  compartment: Compartment,
  preset: KeymapPresetId,
  customBindings: readonly Cm6TranslatedKeybinding[],
  onCommandTriggered?: (command: string, cm6Key: string) => void,
): Extension {
  return compartment.of(createKeymapExtension(preset, customBindings, onCommandTriggered));
}

export function createThemeCompartmentExtension(
  compartment: Compartment,
  theme: DeclarativeVsixTheme,
): Extension {
  return compartment.of(createThemeExtension(theme));
}
