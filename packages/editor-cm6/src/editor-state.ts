import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { type Compartment, EditorState } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";

import { breakpointKeyBindings, colorideBreakpoints } from "./breakpoints.js";
import {
  type EditorRangeDecoration,
  colorideStateDecorations,
  setColorideDecorationsEffect,
} from "./decorations.js";
import { colorideDiagnostics } from "./diagnostics.js";
import type { LanguageFeatureClient } from "./language-features.js";
import { createLezerHighlightingExtensions } from "./languages.js";
import {
  type Cm6TranslatedKeybinding,
  type DeclarativeVsixTheme,
  type KeymapPresetId,
  createKeymapCompartmentExtension,
  createThemeCompartmentExtension,
} from "./onboarding-vsix.js";
import { scopeGuides } from "./scope-guides.js";
import { highlightSelectedLineGutter, textOnlySelection } from "./selection.js";

export interface EditorStateRecipe {
  readonly historyCompartment: Compartment;
  readonly languageCompartment: Compartment;
  readonly keymapCompartment: Compartment;
  readonly themeCompartment: Compartment;
  readonly activeKeymapPreset: KeymapPresetId;
  readonly customKeybindings: readonly Cm6TranslatedKeybinding[];
  readonly activeTheme: DeclarativeVsixTheme;
  readonly languageFeatures: LanguageFeatureClient;
  readonly hostDeltaSync: import("@codemirror/state").Extension;
  onKeyCommand(command: string): void;
}

export function createEditorState(
  recipe: EditorStateRecipe,
  documentId: string,
  initialContent: string,
  initialDecorations: readonly EditorRangeDecoration[],
): EditorState {
  const baseState = EditorState.create({
    doc: initialContent,
    extensions: [
      EditorState.tabSize.of(2),
      indentUnit.of("  "),
      ...colorideStateDecorations(),
      colorideDiagnostics(),
      colorideBreakpoints(),
      highlightSelectedLineGutter(),
      scopeGuides(),
      textOnlySelection(),
      lineNumbers({
        formatNumber: (lineNo) => String(lineNo).padStart(4, " "),
      }),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      recipe.historyCompartment.of(history()),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      rectangularSelection(),
      closeBrackets(),
      highlightActiveLine(),
      autocompletion({ override: [recipe.languageFeatures.completionSource] }),
      keymap.of([
        ...recipe.languageFeatures.keyBindings(),
        ...breakpointKeyBindings,
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      recipe.languageCompartment.of(createLezerHighlightingExtensions(documentId)),
      createKeymapCompartmentExtension(
        recipe.keymapCompartment,
        recipe.activeKeymapPreset,
        recipe.customKeybindings,
        (cmd) => {
          recipe.onKeyCommand(cmd);
        },
      ),
      createThemeCompartmentExtension(recipe.themeCompartment, recipe.activeTheme),
      recipe.hostDeltaSync,
    ],
  });

  if (initialDecorations.length === 0) {
    return baseState;
  }

  return baseState.update({
    effects: setColorideDecorationsEffect.of(initialDecorations),
  }).state;
}
