# Coloride

[![CI](https://github.com/Color-IDE/Coloride/actions/workflows/ci.yml/badge.svg)](https://github.com/Color-IDE/Coloride/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-gray.svg)](./LICENSE)

Coloride is a native code-editor foundation built with [Tauri v2](https://v2.tauri.app/), a Rust host, and [CodeMirror 6](https://codemirror.net/). The current implementation covers the desktop shell, authoritative `ropey`/WAL documents, binary editor IPC, workspace navigation, migration, AST analysis, and filtered local context search. Agent execution, the operational `PolicyEngine`, and OS sandbox runners belong to later lots and remain disabled until their fail-closed implementations are complete.

---

### Quick Start

Prerequisites: Rust (`>= 1.80`), Node.js (`>= 22`), and pnpm (`>= 10`).

```bash
git clone https://github.com/Color-IDE/Coloride.git
cd Coloride

pnpm install
pnpm dev
```

`pnpm dev` builds the web UI, starts Vite on `127.0.0.1:1420`, compiles the Rust host, and opens the native Tauri window. Use `pnpm dev:web` only when working on the browser-rendered UI without native commands.

Run the complete local validation boundary with:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

### Repository Layout

- [`apps/desktop-tauri`](./apps/desktop-tauri) — Tauri v2 desktop application shell and native menus.
- [`apps/web-ui`](./apps/web-ui) — React and Vite frontend implementing the 4-zone cockpit.
- [`packages/editor-cm6`](./packages/editor-cm6) — Isolated CodeMirror 6 view and validation state decorations.
- [`packages/protocol-types`](./packages/protocol-types) — TypeScript bindings generated from Rust contracts.
- [`crates/host-core`](./crates/host-core) — Authoritative `ropey` text buffers, WAL persistence, and UTF-8/UTF-16 offset conversion.
- [`crates/context-engine`](./crates/context-engine) — SQLite WAL/mmap, filtered FTS5 search, and Tree-sitter AST indexing.
- [`crates/judge-orchestrator`](./crates/judge-orchestrator) — Foundation for the later deterministic state machine, `PolicyEngine`, and `Evidence` verification lots.
- [`crates/sandbox-runner`](./crates/sandbox-runner) — Capability model for later fail-closed OS sandbox implementations (`Seatbelt`, `Landlock`, `AppContainer`).

### Licensing

Coloride source code is licensed under the [Apache License, Version 2.0](./LICENSE).
