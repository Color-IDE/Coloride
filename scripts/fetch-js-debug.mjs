// Downloads the JavaScript debug adapter (vscode-js-debug, DAP build) used by LOT-010.
//
// It is not published on npm, only as a GitHub release asset. The version and the SHA-256 are
// pinned here (the digest GitHub publishes for the asset); the archive is verified before it is
// extracted, and nothing is ever downloaded at runtime by the app.
//
// Usage: node scripts/fetch-js-debug.mjs  → tools/js-debug/<version>/js-debug/src/dapDebugServer.js
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "v1.140.0";
const SHA256 = "27dab92937ec1ab35821ae955aac867544fe06a1b6307229049f2d789af10968";
const URL = `https://github.com/microsoft/vscode-js-debug/releases/download/${VERSION}/js-debug-dap-${VERSION}.tar.gz`;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "tools", "js-debug", VERSION);
const entry = join(target, "js-debug", "src", "dapDebugServer.js");

if (existsSync(entry)) {
  console.log(`js-debug ${VERSION} already present: ${entry}`);
  process.exit(0);
}

const response = await fetch(URL, { redirect: "follow" });
if (!response.ok) throw new Error(`download failed: HTTP ${response.status} for ${URL}`);
const archive = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(archive).digest("hex");
if (digest !== SHA256) {
  throw new Error(`js-debug ${VERSION}: SHA-256 ${digest} does not match the pinned ${SHA256}`);
}

mkdirSync(join(root, "tools", "js-debug"), { recursive: true });
const staging = mkdtempSync(join(root, "tools", "js-debug", ".staging-"));
try {
  const file = join(staging, "js-debug.tar.gz");
  writeFileSync(file, archive);
  // No absolute paths or `..` in the archive: tar refuses them by default without -P.
  execFileSync("tar", ["-xzf", file, "-C", staging], { stdio: "inherit" });
  rmSync(file);
  if (!existsSync(join(staging, "js-debug", "src", "dapDebugServer.js"))) {
    throw new Error("unexpected archive layout: js-debug/src/dapDebugServer.js missing");
  }
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
console.log(`js-debug ${VERSION} verified (sha256 ${SHA256}) and extracted: ${entry}`);
