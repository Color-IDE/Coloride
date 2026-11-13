/**
 * Strip `//` line comments, `/* ... * /` block comments, and trailing commas `,` before `}` or `]`
 * while preserving `"..."` string literals intact.
 */
export function sanitizeJsoncToJson(input: string): string {
  let noComments = "";
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < input.length) {
    const ch = input[i] ?? "";
    const next = input[i + 1] ?? "";
    if (inString) {
      noComments += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      noComments += ch;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i + 1 < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        if (input[i] === "\n") {
          noComments += "\n";
        }
        i += 1;
      }
      i = i + 1 < input.length ? i + 2 : input.length;
      continue;
    }

    noComments += ch;
    i += 1;
  }

  let out = "";
  let j = 0;
  inString = false;
  escaped = false;

  while (j < noComments.length) {
    const ch = noComments[j] ?? "";
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      j += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      j += 1;
      continue;
    }

    if (ch === ",") {
      let lookahead = j + 1;
      while (lookahead < noComments.length && /\s/.test(noComments[lookahead] ?? "")) {
        lookahead += 1;
      }
      const nextToken = noComments[lookahead];
      if (nextToken === "}" || nextToken === "]") {
        j += 1;
        continue;
      }
    }

    out += ch;
    j += 1;
  }

  return out;
}

export function parseJsonc<T = unknown>(input: string): T {
  const cleaned = sanitizeJsoncToJson(input);
  return JSON.parse(cleaned) as T;
}

/** Parses JSONC whose root must be an object; `fileLabel` names the file in the error. */
export function parseJsoncObject(input: string, fileLabel: string): Record<string, unknown> {
  const parsed = parseJsonc<unknown>(input);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${fileLabel} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
