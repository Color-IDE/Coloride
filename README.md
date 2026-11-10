# Coloride — Next-Gen Deterministic AI IDE

**Coloride** est un environnement de réalisation logicielle natif (**Tauri v2 + Host Rust + CodeMirror 6**) où chaque action proposée par une IA reste soumise à un **contrôle déterministe**, une **exécution isolée en sandbox (< 5 ms)** et des **preuves vérifiables (`Evidence`)** projetées visuellement par états de couleur.

---

## Documentation Principale / Main Documentation (`docs/`)

> 🌐 **Languages / Langues :** **[🇬🇧 English (`docs/en/`)](./docs/en/README.md)** | **[🇫🇷 Français (`docs/fr/`)](./docs/fr/README.md)** | **[📚 Hub (`docs/README.md`)](./docs/README.md)**

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

## Structure du Monorepo (Cargo Workspace + pnpm)

```text
coloride/
├── docs/                       # Documentation d'architecture, Design System, Plan & 29 Lots (LOT-001..029)
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

---

## Prérequis & Démarrage Rapide

### Prérequis
- **Rust** : stable (`rustc >= 1.85`, `cargo`, `clippy`, `rustfmt`)
- **Node.js** : `>= 22` LTS
- **pnpm** : `>= 10`
- **Dépendances système Tauri v2** :
  - **macOS** : Xcode Command Line Tools
  - **Ubuntu 24.04** : `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`
  - **Windows 11** : Microsoft Visual Studio C++ Build Tools & WebView2

### Commandes principales

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
