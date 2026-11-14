import { mkdirSync, writeFileSync } from "node:fs";
import { arch, loadavg, platform } from "node:os";
import { join } from "node:path";

/** Keep raw samples even on failed runs; Vitest's JSON reporter omits console output. */
export default class PerformanceReporter {
  metrics = [];
  root = process.cwd();
  onInit(vitest) {
    this.root = vitest.config.root;
  }
  onUserConsoleLog(log) {
    for (const line of log.content.split("\n")) {
      const marker = "COLORIDE_PERFORMANCE ";
      const start = line.indexOf(marker);
      if (start >= 0) this.metrics.push(JSON.parse(line.slice(start + marker.length)));
    }
  }
  onTestRunEnd(_modules, errors, reason) {
    const directory = join(this.root, "artifacts/performance");
    mkdirSync(directory, { recursive: true });
    const expected = [
      "lezer-highlight",
      "editor-typing-2000-lines",
      "editor-open-1mb",
      "lot005-cockpit",
    ];
    const missingScenarios = expected.filter(
      (name) => !this.metrics.some((metric) => metric.scenario === name),
    );
    writeFileSync(
      join(directory, "samples.json"),
      `${JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          reason,
          node: process.version,
          platform: platform(),
          arch: arch(),
          loadAverage: loadavg(),
          missingScenarios,
          unhandledErrors: errors,
          metrics: this.metrics,
        },
        null,
        2,
      )}\n`,
    );
    if (reason === "passed" && missingScenarios.length) {
      throw new Error(`Performance samples missing: ${missingScenarios.join(", ")}`);
    }
  }
}
