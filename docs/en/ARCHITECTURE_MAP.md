# Coloride — Architectural Map, Decisions & Risk Analysis (`ARCHITECTURE_MAP.md`)

> 🇫🇷 [Version française disponible ici](../fr/ARCHITECTURE_MAP.md)
>
> Reference architecture map derived from the full analysis of [ARCHITECTURE_TECHNIQUE.md](./ARCHITECTURE_TECHNIQUE.md).
> See [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) for lot sequencing and [LOTS/](./LOTS) for executable specifications (`LOT-001` to `LOT-029`).

---

## 1. Architectural Vision & Core Invariants

**Coloride** is a native software engineering environment where every AI-proposed action is governed by **deterministic control**, **isolated sandbox execution**, and **verifiable proofs (`Evidence`)**.

### Non-Negotiable Invariants
1. **The model proposes; the system authorizes and executes:** no LLM output, MCP response, or extension ever becomes a privileged command directly.
2. **Single persistence authority in the Native Rust Host:** every document is held in memory by `ropey::Rope` inside the Rust Host with a durable Write-Ahead Log (WAL) and an explicit distinction between interactive revision (CodeMirror 6), journaled revision, and disk-saved revision.
3. **Proofs bound to the exact snapshot (`Evidence`):** the 5 Coloride visual states (`🟢 ✓ Validated`, `🟡 ! Needs Review`, `🔴 ✕ Failed`, `🟠 ⟳ Stale Validation`, `🔵 • Unchanged Source`) are cryptographically bound to the tested revision hash. Modifying a single character inside a `🟢` range immediately invalidates it to `🟠`.
4. **Fail-Closed isolation without mandatory Docker:** the OS kernel's native sandbox (`Seatbelt` on macOS, `Landlock` + `bubblewrap` on Linux, `AppContainer` + `Job Objects` on Windows) starts in `< 5 ms` on a *Copy-on-Write* `git worktree`. If the sandbox is unavailable, silent fallback to the host shell is strictly forbidden.
5. **Code remains the single source of truth:** all five personas (*General Public / No-Code*, *Junior Developer*, *Senior Developer*, *DevOps Engineer*, *DBA*) operate on the same workspace across three modes (*Create*, *Learn*, *Develop*) and two specialized workspaces (*Infrastructure*, *Data*). Persona selection never alters `Policy Engine` permissions.

---

## 2. Subsystems & Monorepo Map

```text
coloride/
├── docs/                       # Bilingual documentation (en/ and fr/) + 29 executable lots
├── apps/
│   ├── desktop-tauri/          # Tauri v2 desktop app (window assembly, native menus, signed updater)
│   └── web-ui/                 # React + Vite + Zustand/Jotai UI (4-zone Cockpit, Multi-Chat, Inspector)
├── packages/
│   ├── editor-cm6/             # Isolated CodeMirror 6 view, Lezer < 2 ms, Coloride decorations (🟢/🟡/🔴/🟠/🔵), diff merge
│   └── protocol-types/         # TypeScript types auto-generated from Rust contracts (ts-rs / specta)
└── crates/
    ├── host-core/              # Modular Rust Host: ropey buffers, WAL journal, Git checkpoints, LSP/Biome/DAP, 1-click migration & VS Code Extension Host
    ├── context-engine/         # SQLite WAL/mmap, FTS5 (BM25), Tree-sitter, impact graph, optional sqlite-vec & local MCP server
    ├── judge-orchestrator/     # Persistent state machine, Policy Engine, budgets, Model Gateway, ACP/SDK bridge & Evidence verifier
    └── sandbox-runner/         # Isolated execution: Native OS Sandbox (Seatbelt/Landlock/AppContainer), Warm OCI, Fargate & Firecracker
```

| Domain | Component / Crate | Key Responsibilities | Technical Dependencies |
|---|---|---|---|
| **1. Contracts & Foundation** | `packages/protocol-types` & Rust schema module | Versioned schemas auto-generated (`ts-rs`/`specta`) for the 9 canonical contracts and Coloride states. | `serde`, `ts-rs`/`specta`, `blake3` |
| **2. Core Host & Editing** | `crates/host-core` | `ropey` buffers, UTF-8 ↔ UTF-16 offset conversion, durable WAL journal, atomic save, crash recovery, *Lazy Boot*, invisible Git checkpoints (`refs/coloride/checkpoints/<task_id>`), CoW `git worktree`, `vtsls`/Biome/DAP/PTY supervision, isolated `Preview Service`, 1-click migration, `.vsix` OpenVSX loader, `VS Code Extension Host Shim` supervisor ([LOT-029](./LOTS/LOT-029.md)), and WASI plugins (`wasmtime`). | `tokio`, `ropey`, `git2`, `portable-pty`, `wasmtime` |
| **3. CM6 Editor View** | `packages/editor-cm6` | Virtualized DOM rendering outside React's cycle, local Lezer highlighting (< 2 ms), binary IPC sync (`tauri::ipc::Channel`), IME handling, `StateField`/`Decoration` for the 5 Coloride states, `@codemirror/merge` review, V1 co-editing via `y-codemirror.next`. | `@codemirror/state`, `@codemirror/view`, `@codemirror/merge`, `y-codemirror.next` |
| **4. Cockpit UI** | `apps/web-ui` & `apps/desktop-tauri` | 4-zone Cockpit (Activity Bar, Dynamic Sidebar, 1/2/4/8 Multi-Chat Center Grid, `[Preview \| Code & Diff]` Inspector), atomic Zustand/Jotai stores batched at 16 ms (`requestAnimationFrame`), *Create* / *Learn* / *Develop* modes. | Tauri v2, React, Zustand/Jotai, `xterm.js` |
| **5. Context Engine** | `crates/context-engine` | ACL & secret filtering prior to indexing and export, SQLite `WAL` + `mmap`, FTS5 lexical search (BM25, 0 MB required at boot), incremental `Tree-sitter` AST, impact graph & *Test Impact Analysis*, optional `sqlite-vec` embeddings (< 150 MB), local MCP server (< 20 ms). | `rusqlite` (FTS5, WAL, mmap), `tree-sitter`, `sqlite-vec` |
| **6. Judge, Agents & Models** | `crates/judge-orchestrator` | Persistent 11-state machine, `Policy Engine`, `BudgetLedger`, idempotent `Tool Broker`, `Model Gateway` (local `llama.cpp`/Ollama, OS keyring BYOK, Managed Cloud, private vLLM, *Prompt Caching*), `ACP/SDK` bridge (Claude Code, Codex, Copilot SDK), AST `ChangeSet` compiler, deterministic Judge (max 2 auto retries). | `tokio`, `keyring`, `opentelemetry`, `axum` (cloud) |
| **7. Isolation & Execution** | `crates/sandbox-runner` | Tier 1: Native OS Sandbox (< 5 ms: Seatbelt, Landlock/bwrap, AppContainer/Job Objects). Tier 2: Warm OCI Pool (OrbStack/Docker/Podman). Tier 3: AWS ECS Fargate. Tier 4: Firecracker (Linux/KVM). | OS APIs (Seatbelt, Landlock, Win32 AppContainer/JobObject), OCI, AWS SDK |

---

## 3. Interface Contracts & Core Data Flows

### 3.1 The 9 Canonical Technical Contracts (stabilized in [LOT-002](./LOTS/LOT-002.md))

| Contract | Mandatory Fields & Invariants |
|---|---|
| `EditorTransaction` | `document_id`, `session_generation`, `base_revision`, `op_id`, `changes` (explicit UTF-8 / UTF-16 offsets), `selection`, `origin` (`User`, `Agent(TaskId)`, `Peer(PeerId)`, `Extension(ExtId)`), `ime_composing` flag. |
| `EditorSnapshot` | `document_id`, `session_generation`, `interactive_revision`, `journaled_revision`, `disk_saved_revision`, `content_blake3_hash`, `has_unsaved_changes`. |
| `TaskSpec` | `task_id`, `objective`, `workspace_id`, `base_snapshot_id`, `target_env`, `policy`, `budget_limits`, `acceptance_criteria`. |
| `ContextBundle` | `bundle_id`, `workspace_version`, `excerpts` (sources, ranges, `ConfidenceLevel`, freshness), `classification`, `authorized_destination`, stable `cache_control` prefix. |
| `ModelProvider` | `provider_id`, `capabilities`, streaming output, `structured_tool_calls`, `CancellationToken`, usage & cost metrics. |
| `ToolCall` | `call_id`, `tool_name`, `validated_args`, `required_capabilities`, `preconditions`, `idempotency_key`. |
| `ChangeSet` | `changeset_id`, `base_revision`, AST operations (`Tree-sitter`) or symbol-anchored `SEARCH/REPLACE` blocks, `affected_files`, `result_digest`. |
| `Evidence` | `evidence_id`, `tested_snapshot_hash`, `checkpoint_ref`, executed commands, exit codes, `vtsls`/Biome diagnostics, `Preview Service` runtime report (`0 console.error` / crash), artifacts, and verdict (`🟢`/`🟡`/`🔴`). |
| `Approval` | `approval_id`, `actor_identity`, `target_env`, `action_kind`, `approved_digest` (invalidated if the patch, target, or plan changes by a single bit), `expires_at`. |

### 3.2 Task State Machine ([LOT-013](./LOTS/LOT-013.md))
- **Nominal flow:** `Created → ContextReady → Planned → Running → Verifying → AwaitingReview → Applied`
- **Exception & control states:** `Paused` (budget cap reached or awaiting user input), `Failed` (after 2 failed auto-correction loops or repeated identical failure), `Cancelled` (immediate cancellation), `NeedsReconciliation` (interruption during an external side-effect action whose state must be inspected before resumption, with zero blind retries).

---

## 4. Functional & Non-Functional Requirements

### 4.1 Functional Requirements (EF)
- **EF-01 (Editing & Persistence):** CodeMirror 6 isolated from React, binary-synced with `ropey` (`host-core`), crash recovery journal, atomic disk save, disk conflict detection, IME composition coordination ([LOT-003](./LOTS/LOT-003.md), [LOT-004](./LOTS/LOT-004.md)).
- **EF-02 (Coloride Validation States):** 5 states (`🟢 ✓ Validated`, `🟡 ! Needs Review`, `🔴 ✕ Failed`, `🟠 ⟳ Stale Validation`, `🔵 • Unchanged Source`) combining color, icon, and explicit label bound to the revision hash, with immediate local invalidation (`🟢 → 🟠`) on edit ([LOT-004](./LOTS/LOT-004.md), [LOT-015](./LOTS/LOT-015.md)).
- **EF-03 (4-Zone Cockpit & Multi-Chat Grid):** Activity Bar, dynamic sidebar, 1/2/4/8 center chat grid (sequential in MVP, up to 8 parallel agents on isolated worktrees with AST conflict detection in Beta), and `[Preview | Code & Diff]` inspector ([LOT-005](./LOTS/LOT-005.md), [LOT-020](./LOTS/LOT-020.md)).
- **EF-04 (Git Time-Travel Checkpoints):** Invisible references `refs/coloride/checkpoints/<task_id>` before every agent action and 1-click rollback without polluting `git log` or overwriting human edits ([LOT-011](./LOTS/LOT-011.md)).
- **EF-05 (Context Engine & Local MCP):** SQLite `WAL`/`mmap` + FTS5 (BM25) + `Tree-sitter`/LSP graph (0 MB required at boot), optional `sqlite-vec` (< 150 MB), unsaved buffer priority, ACL/secret filtering before indexing and export, local MCP server (< 20 ms) ([LOT-007](./LOTS/LOT-007.md), [LOT-008](./LOTS/LOT-008.md), [LOT-009](./LOTS/LOT-009.md)).
- **EF-06 (Orchestration, Models & ACP Agents):** Persistent state machine, `Policy Engine`, budget reservation, `Model Gateway` (local `llama.cpp`/Ollama, OS keyring BYOK, Managed Cloud), and `ACP/SDK` bridge (Claude Code, Codex, Copilot SDK) ([LOT-013](./LOTS/LOT-013.md), [LOT-014](./LOTS/LOT-014.md)).
- **EF-07 (Sandboxes, Preview & Publishing):** 0-VM Native OS Sandbox (< 5 ms), Warm OCI Pool, Cloud Fargate Runner, isolated `Preview Service` capturing runtime errors/DOM in `Evidence`, and 1-click Cloudflare R2/Pages static publishing by digest with 1-click rollback ([LOT-012](./LOTS/LOT-012.md), [LOT-016](./LOTS/LOT-016.md), [LOT-017](./LOTS/LOT-017.md)).
- **EF-08 (1-Click Migration, Local Quality & VS Code Extension Emulator):** 1-click import (VS Code, Cursor, Claude Desktop) with quarantined MCP servers, native declarative `.vsix` OpenVSX loader ([LOT-006](./LOTS/LOT-006.md)), *Workspace Trust*, `vtsls` LSP, Biome, `xterm.js` terminal & JS DAP ([LOT-010](./LOTS/LOT-010.md)), and **VS Code Extension Emulator (`VS Code Extension Host Shim`)** isolated in the OS Sandbox translating `vscode.*` API calls to `ropey` and CodeMirror 6 ([LOT-029](./LOTS/LOT-029.md)).
- **EF-09 (Beta, V1 & Enterprise):** Multi-cursor/folding/large files ([LOT-019](./LOTS/LOT-019.md)), *Create* (visual AST catalog) and *Learn* (pedagogical micro-agent) modes ([LOT-021](./LOTS/LOT-021.md)), *Prompt Caching*, governed team memory & OpenTelemetry ([LOT-022](./LOTS/LOT-022.md)), `y-codemirror.next` Yjs co-editing with per-origin isolated Undo ([LOT-023](./LOTS/LOT-023.md)), PostgreSQL DBA workspace + sanitized clones ([LOT-024](./LOTS/LOT-024.md)), Terraform/Ansible/CI/K8s DevOps workspace + separate deployment executor ([LOT-025](./LOTS/LOT-025.md)), Firecracker + WASI ([LOT-026](./LOTS/LOT-026.md)), OIDC/SAML/SCIM SSO + RBAC/ABAC + private vLLM ([LOT-027](./LOTS/LOT-027.md)), VPC/On-Prem + GDPR cascading purge + RPO/RTO drills ([LOT-028](./LOTS/LOT-028.md)).

### 4.2 Non-Functional Targets (ENF)

| Metric / Requirement | Documented Target | Validation Lot(s) |
|---|---|---|
| CodeMirror 6 typing responsiveness | **p95 ≤ 16 ms** (with streaming chat, terminal, and file tree active) | [LOT-004](./LOTS/LOT-004.md), [LOT-005](./LOTS/LOT-005.md), [LOT-018](./LOTS/LOT-018.md) |
| Local Lezer syntax highlighting | **< 2 ms** (progressively enriched by Tree-sitter/LSP) | [LOT-004](./LOTS/LOT-004.md), [LOT-010](./LOTS/LOT-010.md) |
| Right Inspector synchronization | **< 10 ms** when switching active chat | [LOT-005](./LOTS/LOT-005.md), [LOT-020](./LOTS/LOT-020.md) |
| Native OS Sandbox startup | **< 5 ms**, 0 MB VM memory overhead | [LOT-011](./LOTS/LOT-011.md), [LOT-012](./LOTS/LOT-012.md) |
| Local MCP server latency | **< 20 ms** on warm SQLite `WAL`/`mmap` index | [LOT-009](./LOTS/LOT-009.md) |
| Local file open (≤ 1 MB) | **p95 ≤ 150 ms** (background indexing) | [LOT-003](./LOTS/LOT-003.md), [LOT-004](./LOTS/LOT-004.md) |
| Context retrieval on reference corpus | **p95 ≤ 300 ms** | [LOT-008](./LOTS/LOT-008.md) |
| Short local AI completion (1.5B loaded) | **p95 ≤ 700 ms** with immediate cancellation on new keystroke | [LOT-014](./LOTS/LOT-014.md) |
| First targeted test feedback (*Test Impact Analysis*) | **< 2 s** in sandbox prior to full suite | [LOT-007](./LOTS/LOT-007.md), [LOT-015](./LOTS/LOT-015.md) |
| Desktop cold startup (*Lazy Boot*) | **p95 ≤ 3 s** to interactive UI | [LOT-005](./LOTS/LOT-005.md), [LOT-018](./LOTS/LOT-018.md) |
| MVP Agent quality benchmark | **≥ 70%** pass rate on 100 held-out TypeScript tasks | [LOT-018](./LOTS/LOT-018.md) |
| Cloudflare global publish invalidation | **< 50 ms** ($0 R2 egress fees) | [LOT-017](./LOTS/LOT-017.md) |
| Managed availability & Enterprise DR | **99.5%** (MVP) / **99.9%** (Enterprise); **RPO ≤ 15 min**, **RTO ≤ 4 h** | [LOT-017](./LOTS/LOT-017.md), [LOT-028](./LOTS/LOT-028.md) |
