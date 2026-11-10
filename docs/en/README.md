# Technical Documentation & Lot Tracking — Coloride (`docs/en/`)

> 🇫🇷 [Version française disponible ici](../fr/README.md)

This directory contains the complete technical architecture, visual design system, and the 29 executable implementation lots for **Coloride** in English.

---

## 1. Core Architecture Documents

| Document | Purpose |
|---|---|
| **[ARCHITECTURE_TECHNIQUE.md](./ARCHITECTURE_TECHNIQUE.md)** | Full technical architecture blueprint: product vision, 5 personas, 4-zone Cockpit, CodeMirror 6 + Native Rust Host, Context Engine, Deterministic Judge, Sandboxes, Stack & ADRs, and blocking scenarios. |
| **[ARCHITECTURE_MAP.md](./ARCHITECTURE_MAP.md)** | Executive architecture map: 7 technical domains, 9 canonical contracts, functional/non-functional requirements (p95 targets), and resolved architectural tensions. |
| **[IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)** | Master delivery plan across **29 atomic lots**, live status tracking, Mermaid dependency DAG, critical path, execution waves, and traceability matrix. |
| **[DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md)** | Specification of the 5 Coloride validation states (`🟢/🟡/🔴/🟠/🔵`), WCAG AA/AAA accessible color tokens, and the 4-zone Multi-Chat Cockpit layout. |
| **[../../AGENTS.md](../../AGENTS.md)** | Strict architectural invariants and validation rules for AI coding agents and developers. |

---

## 2. Current Progress & Next Action

- **Latest validated lot (`🟢 Validated`):** [LOT-001 — Cargo/pnpm Monorepo Foundation, Tauri v2 Shell & 3-OS CI](./LOTS/LOT-001.md)
- **Next lot to execute (`🔜 Ready`):** [LOT-002 — Rust Technical Contracts & TypeScript Generation (`protocol-types`)](./LOTS/LOT-002.md)

---

## 3. Index of the 29 Executable Lots (`docs/en/LOTS/`)

### Phase 1 — MVP (`M1.1` to `M1.4`)
- **Milestone `M1.1` (Core & Cockpit Shell):**
  - `🟢` [LOT-001.md](./LOTS/LOT-001.md) — Cargo/pnpm Monorepo Foundation, Tauri v2 Shell & 3-OS CI
  - `🔜` [LOT-002.md](./LOTS/LOT-002.md) — Rust Technical Contracts & TypeScript Generation (`protocol-types`)
  - `⏳` [LOT-003.md](./LOTS/LOT-003.md) — `ropey` Buffer Engine, WAL Journal & Crash Recovery (`host-core`)
  - `⏳` [LOT-004.md](./LOTS/LOT-004.md) — Isolated CodeMirror 6 Editor & Binary IPC Bridge (`editor-cm6`)
  - `⏳` [LOT-005.md](./LOTS/LOT-005.md) — 4-Zone Cockpit UI Shell, Lazy Boot & Virtualization (`web-ui`)
  - `⏳` [LOT-006.md](./LOTS/LOT-006.md) — 1-Click Onboarding & Migration Service (VS Code / Cursor / Claude / Declarative `.vsix`)
- **Milestone `M1.2` (Context & Fast Quality):**
  - `⏳` [LOT-007.md](./LOTS/LOT-007.md) — Incremental `Tree-sitter` AST Analysis & Symbol Graph
  - `⏳` [LOT-008.md](./LOTS/LOT-008.md) — SQLite (`WAL`/`mmap`) Context Engine Storage, Secret Filtering & FTS5
  - `⏳` [LOT-009.md](./LOTS/LOT-009.md) — Local MCP Server (< 20 ms) & Optional Embeddings (`sqlite-vec`)
  - `⏳` [LOT-010.md](./LOTS/LOT-010.md) — Fast Quality Integration (`vtsls` LSP, Biome) & Terminal/DAP
- **Milestone `M1.3` (The Judge & OS Sandbox):**
  - `⏳` [LOT-011.md](./LOTS/LOT-011.md) — Invisible Git Time-Travel Checkpoints & *Copy-on-Write* Worktrees
  - `⏳` [LOT-012.md](./LOTS/LOT-012.md) — 0-VM Native OS Sandbox (Seatbelt, Landlock, AppContainer) & Warm OCI
  - `⏳` [LOT-013.md](./LOTS/LOT-013.md) — Task State Machine, Policy Engine, Budgets & Tool Broker
  - `⏳` [LOT-014.md](./LOTS/LOT-014.md) — Model Gateway (Local `llama.cpp`/Ollama, BYOK, Cloud) & ACP/SDK Bridge
  - `⏳` [LOT-015.md](./LOTS/LOT-015.md) — AST `ChangeSet` Compiler, Judge Loop & Coloride States (`🟢🟡🔴🟠🔵`)
- **Milestone `M1.4` (MVP Launch Ready):**
  - `⏳` [LOT-016.md](./LOTS/LOT-016.md) — Isolated `Preview Service` (Browser Loop) & Runtime `Evidence` Capture
  - `⏳` [LOT-017.md](./LOTS/LOT-017.md) — Managed Cloud API (Axum/Postgres/OIDC), Fargate Runner & R2/Pages Publishing
  - `⏳` [LOT-018.md](./LOTS/LOT-018.md) — Signed 3-OS Packaging, Updater, Accessibility & MVP Qualification

### Phase 2 — Closed Beta (`M2.0`)
- `⏳` [LOT-019.md](./LOTS/LOT-019.md) — Advanced CM6 Extensions (Multi-cursor, Folding, Large Files)
- `⏳` [LOT-020.md](./LOTS/LOT-020.md) — Parallel Multi-Chat Grid (8 Concurrent Agents) & AST Conflict Detection
- `⏳` [LOT-021.md](./LOTS/LOT-021.md) — *Create* Mode (Visual AST Catalog) & *Learn* Mode (Pedagogical Micro-Agent)
- `⏳` [LOT-022.md](./LOTS/LOT-022.md) — Prompt Caching, Versioned Team Memory & OpenTelemetry
- `⏳` [LOT-029.md](./LOTS/LOT-029.md) — VS Code Extension Emulator (`VS Code Extension Host Shim` & OpenVSX `.vsix`)

### Phase 3 — Multi-Persona V1 (`M3.0`)
- `⏳` [LOT-023.md](./LOTS/LOT-023.md) — Real-Time Co-Editing (`y-codemirror.next` / Yjs) & Per-Origin Isolated Undo
- `⏳` [LOT-024.md](./LOTS/LOT-024.md) — DBA Workspace: PostgreSQL Connector, Sanitized Clones & Migrations
- `⏳` [LOT-025.md](./LOTS/LOT-025.md) — DevOps Workspace: Terraform/Ansible/CI/K8s Connectors & Plan Executor
- `⏳` [LOT-026.md](./LOTS/LOT-026.md) — Firecracker MicroVM Backend & Wasmtime/WASI Extension Isolation

### Phase 4 — Scale & Enterprise (`M4.0`)
- `⏳` [LOT-027.md](./LOTS/LOT-027.md) — Enterprise Governance: SSO (OIDC/SAML/SCIM), RBAC/ABAC & Private vLLM
- `⏳` [LOT-028.md](./LOTS/LOT-028.md) — Private VPC/On-Prem Deployment, GDPR Cascading Purge & RPO/RTO Drills
