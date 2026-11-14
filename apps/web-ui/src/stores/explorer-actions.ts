import {
  extractSymbolsHeuristically,
  inferImpactedTestsHeuristically,
} from "../analysis/cockpit-analysis.js";
import type { StoreContext } from "./context.js";
import type {
  CockpitAstSymbolItem,
  CockpitFileTreeNode,
  CockpitImpactedTestItem,
  CockpitStoreBundle,
} from "./types.js";

type ExplorerActions = Pick<
  CockpitStoreBundle,
  "setFileTree" | "setAstAnalysis" | "refreshAstAndImpactedTests"
>;

/** Zone 2 explorer data: the file tree and the AST / impacted tests of the shown file. */
export function createExplorerActions(ctx: StoreContext): ExplorerActions {
  const { zone2 } = ctx;
  return {
    setFileTree(fileTree: readonly CockpitFileTreeNode[]): void {
      zone2.setState((prev) => ({
        ...prev,
        fileTree,
        focusedFileIndex: 0,
        fileTreeScrollTop: 0,
      }));
    },

    setAstAnalysis(
      astSymbols: readonly CockpitAstSymbolItem[],
      impactedTests: readonly CockpitImpactedTestItem[],
    ): void {
      zone2.setState((prev) => ({
        ...prev,
        astSymbols,
        impactedTests,
      }));
    },

    refreshAstAndImpactedTests(filePath: string, content: string): void {
      const astSymbols = extractSymbolsHeuristically(content);
      const impactedTests = inferImpactedTestsHeuristically(
        filePath,
        astSymbols,
        zone2.getState().fileTree,
      );
      zone2.setState((prev) => ({
        ...prev,
        astSymbols,
        impactedTests,
      }));
    },
  };
}
