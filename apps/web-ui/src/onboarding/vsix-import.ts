import {
  type Cm6TranslatedKeybinding,
  type DeclarativeVsixBundle,
  type DeclarativeVsixSnippet,
  type DeclarativeVsixTheme,
  translateVsCodeKeyToCm6,
} from "@coloride/editor-cm6";
import { parseJsonc, parseJsoncObject } from "./jsonc.js";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function readPackagedFile(files: Readonly<Record<string, string>>, path: unknown): string | null {
  const relPath = typeof path === "string" ? path.replace(/^\.?\//, "") : "";
  return files[relPath] ?? files[`./${relPath}`] ?? null;
}

function parseTheme(
  raw: JsonObject,
  files: Readonly<Record<string, string>>,
): DeclarativeVsixTheme {
  const label = typeof raw.label === "string" ? raw.label : "Unnamed Theme";
  const uiTheme = typeof raw.uiTheme === "string" ? raw.uiTheme : "vs-dark";
  let editorBackground = "#1e1e2e";
  let editorForeground = "#cdd6f4";
  const themeFileContent = readPackagedFile(files, raw.path);
  if (themeFileContent) {
    const colors = asObject(parseJsonc<JsonObject>(themeFileContent).colors) ?? {};
    if (typeof colors["editor.background"] === "string") {
      editorBackground = colors["editor.background"];
    }
    if (typeof colors["editor.foreground"] === "string") {
      editorForeground = colors["editor.foreground"];
    }
  }
  return { label, uiTheme, editorBackground, editorForeground };
}

function parseSnippetFile(
  raw: JsonObject,
  files: Readonly<Record<string, string>>,
): DeclarativeVsixSnippet[] {
  const language = typeof raw.language === "string" ? raw.language : "plaintext";
  const snipFileContent = readPackagedFile(files, raw.path);
  if (!snipFileContent) {
    return [];
  }
  const snippets: DeclarativeVsixSnippet[] = [];
  for (const [snipName, defVal] of Object.entries(parseJsonc<JsonObject>(snipFileContent))) {
    const defObj = asObject(defVal);
    if (!defObj) {
      continue;
    }
    const prefix =
      typeof defObj.prefix === "string"
        ? defObj.prefix
        : Array.isArray(defObj.prefix) && typeof defObj.prefix[0] === "string"
          ? defObj.prefix[0]
          : "";
    const body =
      typeof defObj.body === "string"
        ? [defObj.body]
        : Array.isArray(defObj.body)
          ? defObj.body.filter((line): line is string => typeof line === "string")
          : [];
    const description = typeof defObj.description === "string" ? defObj.description : undefined;
    if (prefix && body.length > 0) {
      snippets.push({ language, name: snipName, prefix, body, description });
    }
  }
  return snippets;
}

/** Translates one VS Code `{ key, command, when }` entry; null when it is malformed. */
export function translateVsCodeKeybinding(raw: unknown): Cm6TranslatedKeybinding | null {
  const kb = asObject(raw);
  if (!kb || typeof kb.key !== "string" || typeof kb.command !== "string") {
    return null;
  }
  return {
    rawKey: kb.key.trim(),
    cm6Key: translateVsCodeKeyToCm6(kb.key),
    command: kb.command.trim(),
    whenClause: typeof kb.when === "string" ? kb.when.trim() : undefined,
  };
}

/**
 * Reads the declarative contributions (themes, icon themes, snippets, keybindings) of a `.vsix`
 * manifest. Imperative entry points (`main` / `browser`) are flagged and never executed.
 */
export function parseDeclarativeVsixPackage(
  packageJsonc: string,
  files: Readonly<Record<string, string>> = {},
): DeclarativeVsixBundle {
  const manifest = parseJsoncObject(packageJsonc, "VSIX package.json");

  const name = typeof manifest.name === "string" ? manifest.name : "unknown-extension";
  const publisher =
    typeof manifest.publisher === "string" ? manifest.publisher : "unknown-publisher";
  const version = typeof manifest.version === "string" ? manifest.version : "0.0.0";
  const displayName = typeof manifest.displayName === "string" ? manifest.displayName : name;
  const imperativeEntrypointQuarantined =
    typeof manifest.main === "string" || typeof manifest.browser === "string";

  const contributes = asObject(manifest.contributes) ?? {};
  const listOf = (value: unknown): JsonObject[] =>
    Array.isArray(value) ? value.flatMap<JsonObject>((item: unknown) => asObject(item) ?? []) : [];

  const themes = listOf(contributes.themes).map((raw) => parseTheme(raw, files));
  const iconThemes = listOf(contributes.iconThemes).flatMap((raw) => {
    const label =
      typeof raw.label === "string" ? raw.label : typeof raw.id === "string" ? raw.id : null;
    return label ? [label] : [];
  });
  const snippets = listOf(contributes.snippets).flatMap((raw) => parseSnippetFile(raw, files));
  const keybindings = Array.isArray(contributes.keybindings)
    ? contributes.keybindings.flatMap((raw) => translateVsCodeKeybinding(raw) ?? [])
    : [];

  return {
    extensionId: `${publisher}.${name}`,
    displayName,
    version,
    themes,
    iconThemes,
    snippets,
    keybindings,
    imperativeEntrypointQuarantined,
    executedJsEntrypoints: 0,
  };
}
