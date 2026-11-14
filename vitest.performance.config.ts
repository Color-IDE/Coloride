import { defineConfig } from "vitest/config";

/** Fixed workload, strict budgets, no automatic retries; run without competing builds. */
export default defineConfig({
  test: {
    include: [
      "apps/web-ui/src/cockpit/performance.test.ts",
      "packages/editor-cm6/src/index.test.ts",
    ],
    fileParallelism: false,
    maxWorkers: 1,
    retry: 0,
    reporters: ["default", "json", "./scripts/performance-reporter.mjs"],
    outputFile: { json: "artifacts/performance/vitest.json" },
  },
});
