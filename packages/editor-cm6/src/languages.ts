import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import {
  type LanguageSupport,
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { classHighlighter, highlightTree } from "@lezer/highlight";

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
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
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
