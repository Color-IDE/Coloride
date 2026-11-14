import type {
  CockpitAstSymbolItem,
  CockpitFileTreeNode,
  CockpitImpactedTestItem,
} from "../stores/index.js";

/**
 * Lightweight lexical symbol discovery for immediate UI feedback while the authoritative
 * Tree-sitter/LSP analysis is unavailable. Results must never be presented as exact AST/LSP data.
 */
export function extractSymbolsHeuristically(content: string): readonly CockpitAstSymbolItem[] {
  const lines = content.split(/\r?\n/);
  const symbols: CockpitAstSymbolItem[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const fnMatch = /^\s*(export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(line);
    if (fnMatch?.[2]) {
      const name = fnMatch[2];
      const firstChar = name[0] ?? "";
      symbols.push({
        name,
        kind: firstChar >= "A" && firstChar <= "Z" ? "component" : "function",
        line: i + 1,
        exported: Boolean(fnMatch[1]),
        confidence: "HeuristicText",
      });
      continue;
    }

    const declarationMatch = /^\s*(export\s+)?(class|interface|type|const)\s+([A-Za-z0-9_$]+)/.exec(
      line,
    );
    if (!declarationMatch?.[2] || !declarationMatch[3]) continue;

    const declarationKind = declarationMatch[2];
    const name = declarationMatch[3];
    const firstChar = name[0] ?? "";
    const isComponent =
      declarationKind === "const" && firstChar >= "A" && firstChar <= "Z" && line.includes("=>");
    symbols.push({
      name,
      kind: isComponent
        ? "component"
        : (declarationKind as "class" | "interface" | "type" | "const"),
      line: i + 1,
      exported: Boolean(declarationMatch[1]),
      confidence: "HeuristicText",
    });
  }
  return symbols;
}

/**
 * Heuristic fallback for the impacted-test panel. The host ImpactAnalyzer remains authoritative.
 */
export function inferImpactedTestsHeuristically(
  filePath: string,
  symbols: readonly CockpitAstSymbolItem[],
  fileTree: readonly CockpitFileTreeNode[],
): readonly CockpitImpactedTestItem[] {
  const stem = filePath.replace(/\.(tsx|ts|jsx|js)$/, "");
  const primarySymbol = symbols[0]?.name ?? (stem.split("/").pop() || "module");
  const impacted: CockpitImpactedTestItem[] = [];
  const seen = new Set<string>();

  for (const node of fileTree) {
    if (node.isDirectory || !/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(node.path)) continue;
    const nodeStem = node.path.replace(/\.(test|spec)\.(ts|tsx|js|jsx)$/, "");
    if (nodeStem !== stem && !node.path.includes(primarySymbol)) continue;
    seen.add(node.path);
    impacted.push({
      testFilePath: node.path,
      coveredSymbol: primarySymbol,
      confidence: "HeuristicText",
    });
  }

  const canonicalTestPath = `${stem}.test.ts`;
  if (!seen.has(canonicalTestPath)) {
    impacted.push({
      testFilePath: canonicalTestPath,
      coveredSymbol: primarySymbol,
      confidence: "HeuristicText",
    });
  }
  return impacted;
}
