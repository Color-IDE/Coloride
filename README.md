# Coloride

[![CI](https://github.com/Color-IDE/Coloride/actions/workflows/ci.yml/badge.svg)](https://github.com/Color-IDE/Coloride/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-gray.svg)](./LICENSE)

Coloride is a native code-editor foundation built with [Tauri v2](https://v2.tauri.app/), a Rust host, and [CodeMirror 6](https://codemirror.net/). The current implementation covers the desktop shell, authoritative `ropey`/WAL documents, binary editor IPC, workspace navigation, migration, AST analysis, filtered local context search, and a read-only local MCP server with token-budgeted context assembly and optional vector retrieval. Agent execution, the operational `PolicyEngine`, and OS sandbox runners belong to later lots and remain disabled until their fail-closed implementations are complete.

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

### Frontend boundaries and performance checks

`cockpit-dom.ts` composes zones and routes store subscriptions; document-scoped
shortcuts live in `cockpit/shell/shell-shortcuts.ts`, and column geometry/resizing in
`cockpit/shell/shell-layout.ts`. `state/ui-preferences.ts` owns the versioned UI snapshot
(widths and hidden tree), validates persisted data, and migrates the old keys.
Document text still belongs to Rust host-core; UI preferences contain no document text.

Sessions are a discriminated union: `kind: "agent"` requires `modelName`, while
`kind: "terminal"` has neither a model nor agent execution state. Cache restoration
normalizes legacy sessions once, and `cockpit/panels/session-presentation.ts` owns session icons.
CodeMirror's controller retains its singleton lifecycle and IPC/revision handling;
`editor-state.ts` owns the extension recipe, with no view creation or remounting.
Theme tokens/base rules stay in `tailwind.css`; component styles are split into
shell, header, panels, scrollbar, editor, and onboarding stylesheets.

`pnpm test` runs timing-sensitive specs separately from other test files.
`pnpm test:performance` runs the editor and LOT-005 fixtures serially, with the
original thresholds (typing p95 <= 16 ms, highlighting < 2 ms, file open <= 150 ms)
and no retries. It writes `artifacts/performance/vitest.json` for test outcomes and
`samples.json` alongside it for raw timing samples, budgets, machine metadata and
missing scenarios, including on failures. CI has a separate performance job and retains reports for 30 days.
Run this check without concurrent builds; happy-dom results are a fixture measurement,
not a claim about physical input latency on all machines. Investigate failed runs
before classifying them as machine contention; do not raise budgets to make them pass.

`judge-orchestrator` and `sandbox-runner` remain foundations: health checks report
`policy_engine_operational: false` and `execution_available: false`. The agent queue
models UI intent, not actual execution. Desktop boot reports no background service
ready unless an initialization provider supplies that result. Implementing policy
and OS isolation belongs to later lots, before agent execution can be enabled.

### Local context MCP server (LOT-009)

Run the read-only JSON-RPC 2.0 server over newline-delimited stdio with an existing
workspace and an index path whose parent exists inside that workspace:

```bash
cargo run -p context-engine --bin coloride-context-mcp -- /absolute/workspace /absolute/workspace/context.sqlite main
```

The server exposes `search_codebase`, `get_symbol_definition`, `get_impact_graph`,
`get_diagnostics`, and `build_context_bundle`. Initialize the MCP session before
calling tools. Bundle assembly defaults to a 16,000-token upper bound, uses reciprocal
rank fusion, and deduplicates excerpts. Responses transmit source text only in
`bundle.excerpts`. `render_prompt()` renders deterministic untrusted-data JSON lines
on demand; `cache_prefix_excerpt_count` identifies the stable excerpt prefix and
`cache_control_prefix` is its BLAKE3 cache identity, not another copy of source text.
`token_accounting = ConservativeUtf8BytesUpperBound` explicitly identifies the
budget method: UTF-8 bytes of the rendered prompt, including provenance and escaping.
This is a safe byte-level-tokenizer upper bound, not an actual tokenizer count; it
can fit roughly four times less text than a typical 16,000-token model window.
Only `LocalOnly` export is authorized by the executable; embedded hosts can configure
an explicit destination allowlist. Diagnostics can be published by a trusted host
provider and are bound to the document hash; absent providers return `Unavailable`,
and edited documents return `Stale`. LSP/Biome execution belongs to LOT-010.

Embeddings are disabled by default and return `LexicalAndAstOnly`. To opt in, build
with `--features vector`, provide ONNX Runtime 1.20+ through `ORT_DYLIB_PATH`, and
append `--vectors /absolute/workspace/model-cache` (an existing directory). The
optional dependency graph requires Rust 1.88 or newer. Model initialization and
index construction run on a background worker, downloading quantized BGE-small only
on explicit opt-in. The model must be smaller than 150 MB. SQLite `vec0` cosine
retrieval is fused with lexical/AST hits when available, even when it returns zero
matches. `vector_state` reports `Disabled`, `Building`, `Ready`, `Stale`, or `Failed`.
Missing runtime errors explain how to configure `ORT_DYLIB_PATH`.

`model-cache/vectors.sqlite` persists vector rows and chunk hashes using SQLite WAL.
Unchanged chunks reuse their embeddings after restart. A bounded mutation journal
tracks indexed files and unsaved buffers, so unchanged calls check revision counters
in O(1); updates visit only affected files and embed only previously unseen content
hashes. A lagging consumer that outlives the journal requests a full metadata snapshot,
which still reuses unchanged vectors. The background writer commits deltas atomically;
the reader continues serving unchanged chunks and filters outdated chunk hashes.
Only chunk identities, paths, hashes, and vectors are stored; excerpts are resolved
from current host/index buffers. Hosts can select quantized MiniLM through
`enable_vectors_with_model`; model or branch changes reset the vector scope.
The small registration wrapper's source review is recorded in
[`DEPENDENCIES.md`](crates/context-engine/DEPENDENCIES.md). The LOT-008 lexical
store currently uses its existing in-memory maps and custom WAL snapshots; it is
not a native SQLite database.

Run the blocking MCP checks with `cargo test -p context-engine --test lot009_mcp`.
The latency fixture measures 200 warm stdio round trips over 100 files, with p95 < 20 ms;
it does not establish that bound for arbitrary repository sizes. Optional tests run
with `cargo test -p context-engine --features vector`. To verify actual model
inference and retrieval with ONNX Runtime available, run:

```bash
cargo test -p context-engine --features vector --test lot009_vectors -- --include-ignored
```

### Licensing

Coloride source code is licensed under the [Apache License, Version 2.0](./LICENSE).
