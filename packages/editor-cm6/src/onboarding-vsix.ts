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
  editorBackground: "#090d16",
  editorForeground: "#e2e8f0",
  fontFamily: "JetBrains Mono, SF Mono, Cascadia Code, monospace",
  fontSizePx: 14,
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
  return EditorView.theme(
    {
      "&": {
        backgroundColor: theme.editorBackground,
        color: theme.editorForeground,
        fontFamily: theme.fontFamily ?? "JetBrains Mono, SF Mono, Cascadia Code, monospace",
        fontSize: `${theme.fontSizePx ?? 14}px`,
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
