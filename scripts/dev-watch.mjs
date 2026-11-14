// Development server for the desktop app: Vite plus the two build steps its inputs go through.
//
// The app imports `@coloride/web-ui` and `@coloride/editor-cm6` from their built `dist/` folders
// (compiled TypeScript and the Tailwind stylesheet), so without watchers an edit to either shows
// nothing until someone rebuilds by hand. This starts, side by side:
//   - `tsc -b --watch`: recompiles the TypeScript packages,
//   - `tailwindcss --watch`: regenerates `dist/tailwind.css`,
//   - `vite`: the dev server Tauri points at.
// If any of them exits, the others are stopped too (Tauri then sees the dev server end).
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shell = process.platform === "win32";

const jobs = [
  { name: "tsc", args: ["exec", "tsc", "-b", "--watch", "--preserveWatchOutput"], cwd: root },
  {
    name: "css",
    args: [
      "exec",
      "tailwindcss",
      "-i",
      "./src/theme/tailwind.css",
      "-o",
      "./dist/tailwind.css",
      "--watch=always",
    ],
    cwd: resolve(root, "apps/web-ui"),
  },
  {
    name: "vite",
    args: ["exec", "vite", "--host", "127.0.0.1", "--port", "1420", "--strictPort"],
    cwd: resolve(root, "apps/desktop-tauri"),
  },
];

const children = jobs.map((job) => {
  const child = spawn("pnpm", job.args, { cwd: job.cwd, stdio: "inherit", shell });
  child.on("exit", (code, signal) => {
    if (!stopping) {
      console.error(`[dev-watch] ${job.name} stopped (${signal ?? code}); stopping the rest`);
      stop(code ?? 1);
    }
  });
  return child;
});

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500).unref();
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => stop(0));
