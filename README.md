# Coloride — Next-Gen Deterministic AI IDE

> 🌐 **Read in:** **[🇬🇧 English](#english)** | **[🇫🇷 Français](#francais)**
> 🔒 **Internal Engineering Docs (`docs/` — Collaborators & Core Team only):** Clone the private documentation repository into `docs/` (`git clone https://github.com/Color-IDE/Coloride-docs.git docs`).
> 📚 **Documentation Hub (local):** **[🇬🇧 docs/en/](./docs/en/README.md)** | **[🇫🇷 docs/fr/](./docs/fr/README.md)** | **[docs/README.md](./docs/README.md)**

| Document | 🇬🇧 English (`docs/en/`) | 🇫🇷 Français (`docs/fr/`) |
|---|---|---|
| **Documentation Index & Progress** | [docs/en/README.md](./docs/en/README.md) | [docs/fr/README.md](./docs/fr/README.md) |
| **Full Technical Architecture** | [docs/en/ARCHITECTURE_TECHNIQUE.md](./docs/en/ARCHITECTURE_TECHNIQUE.md) | [docs/fr/ARCHITECTURE_TECHNIQUE.md](./docs/fr/ARCHITECTURE_TECHNIQUE.md) |
| **Architecture Map & Contracts** | [docs/en/ARCHITECTURE_MAP.md](./docs/en/ARCHITECTURE_MAP.md) | [docs/fr/ARCHITECTURE_MAP.md](./docs/fr/ARCHITECTURE_MAP.md) |
| **Master Implementation Plan (29 Lots)** | [docs/en/IMPLEMENTATION_PLAN.md](./docs/en/IMPLEMENTATION_PLAN.md) | [docs/fr/IMPLEMENTATION_PLAN.md](./docs/fr/IMPLEMENTATION_PLAN.md) |
| **Design System & 5 Coloride States** | [docs/en/DESIGN_SYSTEM.md](./docs/en/DESIGN_SYSTEM.md) | [docs/fr/DESIGN_SYSTEM.md](./docs/fr/DESIGN_SYSTEM.md) |
| **29 Executable Lots (`LOT-001`..`LOT-029`)** | [docs/en/LOTS/](./docs/en/LOTS) | [docs/fr/LOTS/](./docs/fr/LOTS) |
| **AI Agent & Developer Rules** | [AGENTS.md](./AGENTS.md) | [AGENTS.md](./AGENTS.md) |

---

<a id="english"></a>

## 🇬🇧 English

**Coloride** is a native software engineering environment (**Tauri v2 + Native Rust Host + CodeMirror 6**) where every AI-proposed action is governed by **deterministic control**, **isolated sandbox execution (< 5 ms)**, and **verifiable proofs (`Evidence`)** projected visually through color-coded validation states (`🟢/🟡/🔴/🟠/🔵`).

### Key Highlights
- **The Model Proposes; The Rust Judge Verifies:** Orchestrate **Claude Code, Codex, Copilot SDK**, or local/BYOK/Cloud models. Every patch is tested in an isolated worktree (`vtsls` + Biome + impacted tests + isolated `Preview Service`) before receiving the `🟢 ✓ Validated` state.
- **4-Zone Multi-Chat Cockpit:** Supervise from **1 up to 8 concurrent AI agents** in the center grid, synchronized in `< 10 ms` with the right `[ 👁 Preview | 💻 Code & Diff ]` inspector.
- **0-VM Instant Sandbox & 0-MB Instant Context:** Runs out-of-the-box without requiring Docker (`Seatbelt` on macOS, `Landlock` on Linux, `AppContainer` on Windows) and indexes your codebase locally via **SQLite WAL/mmap + FTS5 + Tree-sitter** exposed as a `< 20 ms` local MCP server.
- **VS Code Extension Compatibility:** Native declarative `.vsix` loader (OpenVSX themes, icons, snippets, keymaps) + OS-sandboxed **VS Code Extension Host Shim** ([LOT-029](./docs/en/LOTS/LOT-029.md)).

### Monorepo Structure (Cargo Workspace + pnpm)

```text
coloride/
├── docs/                       # Bilingual Architecture, Design System, Plan & 29 Lots (en/ & fr/)
├── apps/
│   ├── desktop-tauri/          # Tauri v2 desktop app (window shell, native menus, signed updater)
│   └── web-ui/                 # React + Vite + Zustand/Jotai UI (4-zone Cockpit, Multi-Chat, Inspector)
├── packages/
│   ├── editor-cm6/             # Isolated CodeMirror 6 view, Lezer < 2 ms, Coloride decorations (🟢/🟡/🔴/🟠/🔵), diff merge
│   └── protocol-types/         # TypeScript types generated from Rust contracts
└── crates/
    ├── host-core/              # Modular Rust Host: ropey buffers, WAL journal, Git checkpoints, 1-click migration & Extension Host
    ├── context-engine/         # SQLite WAL/mmap, FTS5 (BM25), Tree-sitter, impact graph & local MCP server (< 20 ms)
    ├── judge-orchestrator/     # State machine, Policy Engine, budgets, Model Gateway, ACP/SDK bridge & Evidence verifier
    └── sandbox-runner/         # Isolated execution: Native OS Sandbox (Seatbelt/Landlock/AppContainer < 5 ms), OCI, Fargate & Firecracker
```

### Prerequisites & Quick Start (EN)

- **Rust:** stable (`rustc >= 1.80`, `cargo`, `clippy`, `rustfmt`)
- **Node.js:** `>= 22` LTS & **pnpm:** `>= 10`
- **Tauri v2 System Dependencies:**
  - **macOS:** Xcode Command Line Tools
  - **Ubuntu 24.04:** `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`
  - **Windows 11:** Microsoft Visual Studio C++ Build Tools & WebView2

```bash
# Install JavaScript/TypeScript dependencies
pnpm install

# Check formatting & linting (Biome + Clippy)
pnpm lint
cargo clippy --workspace --all-targets -- -D warnings

# Run TypeScript typechecking across all packages
pnpm typecheck

# Run all unit tests (Rust + TypeScript)
cargo test --workspace
pnpm test

# Build the entire monorepo
pnpm build
cargo build --workspace
```

### License

Licensed under the [Apache License, Version 2.0](./LICENSE).

---

<a id="francais"></a>

## 🇫🇷 Français

**Coloride** est un environnement de réalisation logicielle natif (**Tauri v2 + Host Rust + CodeMirror 6**) où chaque action proposée par une IA reste soumise à un **contrôle déterministe**, une **exécution isolée en sandbox (< 5 ms)** et des **preuves vérifiables (`Evidence`)** projetées visuellement par états de couleur (`🟢/🟡/🔴/🟠/🔵`).

### Points Clés
- **Le modèle propose ; le Juge Rust vérifie :** Pilotez **Claude Code, Codex, Copilot SDK** ou des modèles locaux/BYOK/Cloud. Chaque patch est testé dans un worktree isolé (`vtsls` + Biome + tests impactés + `Preview Service` isolé) avant d'obtenir l'état `🟢 ✓ Validé`.
- **Cockpit Multi-Chat en 4 zones :** Supervisez de **1 à 8 agents IA simultanés** dans la grille centrale, synchronisée en `< 10 ms` avec l'inspecteur droit `[ 👁 Preview | 💻 Code & Diff ]`.
- **Sandbox instantanée (0 VM) & Contexte instantané (0 Mo) :** Fonctionne dès l'installation sans Docker obligatoire (`Seatbelt` sur macOS, `Landlock` sur Linux, `AppContainer` sur Windows) et indexe le code localement via **SQLite WAL/mmap + FTS5 + Tree-sitter** exposé en serveur MCP local (`< 20 ms`).
- **Compatibilité Extensions VS Code :** Chargeur natif `.vsix` déclaratif (OpenVSX : thèmes, icônes, snippets, keymaps) + émulateur **VS Code Extension Host Shim** isolé en Sandbox OS ([LOT-029](./docs/fr/LOTS/LOT-029.md)).

### Structure du Monorepo (Cargo Workspace + pnpm)

```text
coloride/
├── docs/                       # Documentation bilingue Architecture, Design System, Plan & 29 Lots (en/ & fr/)
├── apps/
│   ├── desktop-tauri/          # Application Tauri v2 (assemblage fenêtre, menus natifs, updater signé)
│   └── web-ui/                 # Interface React + Vite + Zustand/Jotai (Cockpit 4 zones, Multi-Chat, Inspecteur)
├── packages/
│   ├── editor-cm6/             # Vue CodeMirror 6 isolée, Lezer < 2 ms, décorations Coloride (🟢/🟡/🔴/🟠/🔵), diff merge
│   └── protocol-types/         # Types TypeScript générés depuis les contrats Rust
└── crates/
    ├── host-core/              # Monolithe modulaire Rust : buffers ropey, journal WAL, Git checkpoints, migration 1-clic & Extension Host
    ├── context-engine/         # SQLite WAL/mmap, FTS5 (BM25), Tree-sitter, graphe d'impact et serveur MCP local (< 20 ms)
    ├── judge-orchestrator/     # Machine à états, Policy Engine, budgets, Model Gateway, pont ACP/SDK et validation Evidence
    └── sandbox-runner/         # Exécution isolée : Sandbox OS native (Seatbelt/Landlock/AppContainer < 5 ms), OCI, Fargate & Firecracker
```

### Prérequis & Démarrage Rapide (FR)

- **Rust :** stable (`rustc >= 1.80`, `cargo`, `clippy`, `rustfmt`)
- **Node.js :** `>= 22` LTS & **pnpm :** `>= 10`
- **Dépendances système Tauri v2 :**
  - **macOS :** Xcode Command Line Tools
  - **Ubuntu 24.04 :** `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`
  - **Windows 11 :** Microsoft Visual Studio C++ Build Tools & WebView2

```bash
# Installer les dépendances JavaScript/TypeScript
pnpm install

# Vérifier le formatage et le linting (Biome + Clippy)
pnpm lint
cargo clippy --workspace --all-targets -- -D warnings

# Vérifier le typage TypeScript sur tous les packages
pnpm typecheck

# Exécuter tous les tests (Rust + TypeScript)
cargo test --workspace
pnpm test

# Compiler l'ensemble du monorepo
pnpm build
cargo build --workspace
```

### Licence

Distribué sous licence [Apache License, Version 2.0](./LICENSE).
