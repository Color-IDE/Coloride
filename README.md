# Coloride

[![CI](https://github.com/Color-IDE/Coloride/actions/workflows/ci.yml/badge.svg)](https://github.com/Color-IDE/Coloride/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-gray.svg)](./LICENSE)

Welcome to Coloride, a high-performance, deterministic AI code editor built with [Tauri v2](https://v2.tauri.app/), a native Rust host, and [CodeMirror 6](https://codemirror.net/). Every AI-proposed change is verified in an isolated OS sandbox (`< 5 ms`) and backed by cryptographic validation proofs (`Evidence`).

---

### Quick Start

Prerequisites: Rust (`>= 1.80`), Node.js (`>= 22`), and pnpm (`>= 10`).

```bash
git clone https://github.com/Color-IDE/Coloride.git
cd Coloride

pnpm install
pnpm build
cargo test --workspace && pnpm test
```

### Repository Layout

- [`apps/desktop-tauri`](./apps/desktop-tauri) — Tauri v2 desktop application shell and native menus.
- [`apps/web-ui`](./apps/web-ui) — React and Vite frontend implementing the 4-zone cockpit.
- [`packages/editor-cm6`](./packages/editor-cm6) — Isolated CodeMirror 6 view and validation state decorations.
- [`packages/protocol-types`](./packages/protocol-types) — TypeScript bindings generated from Rust contracts.
- [`crates/host-core`](./crates/host-core) — Authoritative `ropey` text buffers, WAL persistence, and UTF-8/UTF-16 offset conversion.
- [`crates/context-engine`](./crates/context-engine) — SQLite WAL/mmap, FTS5 search, Tree-sitter AST indexing, and local MCP server.
- [`crates/judge-orchestrator`](./crates/judge-orchestrator) — Deterministic state machine, `PolicyEngine`, and `Evidence` verification.
- [`crates/sandbox-runner`](./crates/sandbox-runner) — Fail-closed OS sandboxing (`Seatbelt`, `Landlock`, `AppContainer`).

### Licensing

Coloride source code is licensed under the [Apache License, Version 2.0](./LICENSE).
