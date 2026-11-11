import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  type LanguageSupport,
  bracketMatching,
  foldGutter as cmFoldGutter,
  codeFolding,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { type Extension, Prec } from "@codemirror/state";
import { classHighlighter, highlightTree, tags } from "@lezer/highlight";

const chalky = "#e5c07b";
const coral = "#e06c75";
const cyan = "#56b6c2";
const invalid = "#ffffff";
const ivory = "#abb2bf";
const stone = "#7d8799";
const malibu = "#61afef";
const sage = "#98c379";
const whiskey = "#d19a66";
const violet = "#c678dd";

/**
 * Exact `oneDarkHighlightStyle` palette used by `Rectury-Package/client/ide/src/features/editor/hosts/codemirror/theme.ts`.
 */
export const colorideDarkHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: violet },
  {
    tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName],
    color: coral,
  },
  { tag: [tags.function(tags.variableName), tags.labelName], color: malibu },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: whiskey },
  { tag: [tags.definition(tags.name), tags.separator], color: ivory },
  {
    tag: [
      tags.typeName,
      tags.className,
      tags.number,
      tags.changed,
      tags.annotation,
      tags.modifier,
      tags.self,
      tags.namespace,
    ],
    color: chalky,
  },
  {
    tag: [
      tags.operator,
      tags.operatorKeyword,
      tags.url,
      tags.escape,
      tags.regexp,
      tags.link,
      tags.special(tags.string),
    ],
    color: cyan,
  },
  { tag: [tags.meta, tags.comment], color: stone },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, color: stone, textDecoration: "underline" },
  { tag: tags.heading, fontWeight: "bold", color: coral },
  { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: whiskey },
  { tag: [tags.processingInstruction, tags.string, tags.inserted], color: sage },
  { tag: tags.invalid, color: invalid },
]);

const FOLD_CHEVRON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 20 20" aria-hidden="true"><path d="M0 0h20v20H0z" fill="none"/><path fill="currentColor" d="M10.103 12.778L16.81 6.08a.69.69 0 0 1 .99.012a.726.726 0 0 1-.012 1.012l-7.203 7.193a.69.69 0 0 1-.985-.006L2.205 6.72a.727.727 0 0 1 0-1.01a.69.69 0 0 1 .99 0z"/></svg>';

function createFoldMarker(open: boolean): HTMLElement {
  const btn = document.createElement("span");
  btn.className = `coloride-fold-btn ${open ? "is-open" : "is-closed"}`;
  btn.innerHTML = FOLD_CHEVRON_SVG;
  return btn;
}

export type SupportedEditorLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "json"
  | "css"
  | "html"
  | "markdown";

export function detectLanguageFromPath(filePath: string): SupportedEditorLanguage {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tsx")) {
    return "tsx";
  }
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) {
    return "typescript";
  }
  if (lower.endsWith(".jsx")) {
    return "jsx";
  }
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return "javascript";
  }
  if (lower.endsWith(".json")) {
    return "json";
  }
  if (lower.endsWith(".css")) {
    return "css";
  }
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    return "html";
  }
  return "markdown";
}

export function resolveLanguageSupport(lang: SupportedEditorLanguage): LanguageSupport {
  switch (lang) {
    case "typescript":
      return javascript({ typescript: true, jsx: false });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "javascript":
      return javascript({ typescript: false, jsx: false });
    case "jsx":
      return javascript({ typescript: false, jsx: true });
    case "json":
      return json();
    case "css":
      return css();
    case "html":
      return html();
    case "markdown":
      return markdown();
  }
}

export function createLezerHighlightingExtensions(filePathOrLang: string): Extension[] {
  const lang: SupportedEditorLanguage =
    filePathOrLang === "typescript" ||
    filePathOrLang === "tsx" ||
    filePathOrLang === "javascript" ||
    filePathOrLang === "jsx" ||
    filePathOrLang === "json" ||
    filePathOrLang === "css" ||
    filePathOrLang === "html" ||
    filePathOrLang === "markdown"
      ? filePathOrLang
      : detectLanguageFromPath(filePathOrLang);

  return [
    resolveLanguageSupport(lang),
    indentOnInput(),
    bracketMatching(),
    codeFolding({ placeholderText: "…" }),
    Prec.lowest(cmFoldGutter({ markerDOM: createFoldMarker })),
    syntaxHighlighting(colorideDarkHighlightStyle, { fallback: true }),
  ];
}

export interface LezerHighlightedToken {
  readonly from: number;
  readonly to: number;
  readonly classes: string;
}

/**
 * Perform synchronous local Lezer parsing and syntax highlighting (< 2 ms budget).
 */
export function highlightSnippetWithLezer(
  code: string,
  lang: SupportedEditorLanguage = "typescript",
): readonly LezerHighlightedToken[] {
  const support = resolveLanguageSupport(lang);
  const tree = support.language.parser.parse(code);
  const tokens: LezerHighlightedToken[] = [];
  highlightTree(tree, classHighlighter, (from, to, classes) => {
    tokens.push({ from, to, classes });
  });
  return tokens;
}
