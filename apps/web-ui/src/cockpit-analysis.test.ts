import { describe, expect, it } from "vitest";
import {
  extractSymbolsHeuristically,
  inferImpactedTestsHeuristically,
} from "./cockpit-analysis.js";

describe("cockpit heuristic analysis", () => {
  it("never labels regex-derived symbols as exact AST/LSP evidence", () => {
    const symbols = extractSymbolsHeuristically("export function LoginView() {\n  return true;\n}");

    expect(symbols).toMatchObject([
      { name: "LoginView", kind: "component", confidence: "HeuristicText" },
    ]);
  });

  it("labels inferred impacted tests as heuristic", () => {
    const symbols = extractSymbolsHeuristically("export const login = true;");
    const tests = inferImpactedTestsHeuristically("src/login.ts", symbols, []);

    expect(tests).toEqual([
      {
        testFilePath: "src/login.test.ts",
        coveredSymbol: "login",
        confidence: "HeuristicText",
      },
    ]);
  });
});
