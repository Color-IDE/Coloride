# Documentation Technique & Pilotage des Lots — Coloride (`docs/fr/`)

> 🇬🇧 [English version available here](../en/README.md)

Ce répertoire regroupe l'ensemble de la documentation d'architecture, du système visuel et des 29 lots d'implémentation de **Coloride** en français.

---

## 1. Documents Directeurs

| Document | Rôle |
|---|---|
| **[ARCHITECTURE_TECHNIQUE.md](./ARCHITECTURE_TECHNIQUE.md)** | Dossier d'architecture de référence : vision produit, 5 personas, Cockpit 4 zones, CodeMirror 6 + Host Rust, Context Engine, Juge déterministe, Sandboxes, Stack et scénarios bloquants. |
| **[ARCHITECTURE_MAP.md](./ARCHITECTURE_MAP.md)** | Cartographie synthétique des 7 domaines, des 9 contrats canoniques, des exigences fonctionnelles/non-fonctionnelles (cibles p95) et des arbitrages techniques. |
| **[IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)** | Plan directeur des **29 lots**, statut d'avancement, graphe de dépendances Mermaid, chemin critique, vagues d'exécution et matrice de traçabilité. |
| **[DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md)** | Spécification des 5 états visuels Coloride (`🟢/🟡/🔴/🟠/🔵`), tokens de couleurs accessibles (WCAG AA/AAA) et grille du Cockpit 4 zones. |
| **[../../AGENTS.md](../../AGENTS.md)** | Invariants architecturaux stricts et règles de validation pour les agents IA et les développeurs. |

---

## 2. État d'Avancement et Prochaine Action

- **Dernier lot validé (`🟢 Validé`) :** [LOT-001 — Socle Monorepo Cargo/pnpm, Shell Tauri v2 & CI 3 OS](./LOTS/LOT-001.md)
- **Prochain lot à exécuter (`🔜 Prêt`) :** [LOT-002 — Contrats techniques Rust & Génération TypeScript (`protocol-types`)](./LOTS/LOT-002.md)

---

## 3. Index des 29 Fiches de Lots (`docs/LOTS/`)

### Phase 1 — MVP (`M1.1` à `M1.4`)
- **Jalon `M1.1` (Core & Cockpit Shell) :**
  - `🟢` [LOT-001.md](./LOTS/LOT-001.md) — Socle Monorepo Cargo/pnpm, Shell Tauri v2 & CI 3 OS
  - `🔜` [LOT-002.md](./LOTS/LOT-002.md) — Contrats techniques Rust & Génération TypeScript (`protocol-types`)
  - `⏳` [LOT-003.md](./LOTS/LOT-003.md) — Moteur de buffers `ropey`, Journal WAL & Crash Recovery (`host-core`)
  - `⏳` [LOT-004.md](./LOTS/LOT-004.md) — Éditeur CodeMirror 6 isolé & Pont IPC binaire (`editor-cm6`)
  - `⏳` [LOT-005.md](./LOTS/LOT-005.md) — Shell UI Cockpit 4 zones, Lazy Boot & Virtualisation (`web-ui`)
  - `⏳` [LOT-006.md](./LOTS/LOT-006.md) — Service d'Onboarding & Migration 1-clic (VS Code / Cursor / Claude / `.vsix` déclaratif)
- **Jalon `M1.2` (Context & Fast Quality) :**
  - `⏳` [LOT-007.md](./LOTS/LOT-007.md) — Analyse AST incrémentale `Tree-sitter` & Graphe de symboles
  - `⏳` [LOT-008.md](./LOTS/LOT-008.md) — Stockage Context Engine SQLite (`WAL`/`mmap`), Filtrage Secrets & FTS5
  - `⏳` [LOT-009.md](./LOTS/LOT-009.md) — Serveur MCP Local (< 20 ms) & Embeddings optionnels (`sqlite-vec`)
  - `⏳` [LOT-010.md](./LOTS/LOT-010.md) — Intégration Qualité Rapide (`vtsls` LSP, Biome) & Terminal/DAP
- **Jalon `M1.3` (The Judge & OS Sandbox) :**
  - `⏳` [LOT-011.md](./LOTS/LOT-011.md) — Git Time-Travel Checkpoints invisibles & Worktrees *Copy-on-Write*
  - `⏳` [LOT-012.md](./LOTS/LOT-012.md) — Sandbox OS Native 0-VM (Seatbelt, Landlock, AppContainer) & Warm OCI
  - `⏳` [LOT-013.md](./LOTS/LOT-013.md) — Machine à états de Tâche, Policy Engine, Budgets & Tool Broker
  - `⏳` [LOT-014.md](./LOTS/LOT-014.md) — Model Gateway (Local `llama.cpp`/Ollama, BYOK, Cloud) & Pont ACP/SDK
  - `⏳` [LOT-015.md](./LOTS/LOT-015.md) — Compilateur `ChangeSet` AST, Boucle du Juge & États Coloride (`🟢🟡🔴🟠🔵`)
- **Jalon `M1.4` (MVP Launch Ready) :**
  - `⏳` [LOT-016.md](./LOTS/LOT-016.md) — `Preview Service` isolé (Browser Loop) & Capture d'`Evidence` runtime
  - `⏳` [LOT-017.md](./LOTS/LOT-017.md) — API Cloud Managée (Axum/Postgres/OIDC), Runner Fargate & Publication R2/Pages
  - `⏳` [LOT-018.md](./LOTS/LOT-018.md) — Packaging Signé 3 OS, Updater, Accessibilité & Qualification MVP

### Phase 2 — Bêta Fermée (`M2.0`)
- `⏳` [LOT-019.md](./LOTS/LOT-019.md) — Extensions CM6 avancées (Multicurseur, Pliage, Grands Fichiers)
- `⏳` [LOT-020.md](./LOTS/LOT-020.md) — Grille Multi-Chat Parallèle (8 agents //) & Détection de conflits AST
- `⏳` [LOT-021.md](./LOTS/LOT-021.md) — Modes *Créer* (Catalogue Visuel AST) & *Apprendre* (Micro-Agent Pédagogique)
- `⏳` [LOT-022.md](./LOTS/LOT-022.md) — Prompt Caching, Mémoire d'Équipe versionnée & Télémétrie OpenTelemetry
- `⏳` [LOT-029.md](./LOTS/LOT-029.md) — Émulateur d'Extensions VS Code (`VS Code Extension Host Shim` & OpenVSX `.vsix`)

### Phase 3 — V1 Multi-Personas (`M3.0`)
- `⏳` [LOT-023.md](./LOTS/LOT-023.md) — Coédition Temps Réel (`y-codemirror.next` / Yjs) & Undo isolé par origine
- `⏳` [LOT-024.md](./LOTS/LOT-024.md) — Espace DBA : Connecteur PostgreSQL, Clones Assainis & Migrations
- `⏳` [LOT-025.md](./LOTS/LOT-025.md) — Espace DevOps : Connecteurs Terraform/Ansible/CI/K8s & Exécuteur de plans
- `⏳` [LOT-026.md](./LOTS/LOT-026.md) — Backend MicroVM Firecracker & Isolation d'extensions Wasmtime/WASI

### Phase 4 — Scale & Enterprise (`M4.0`)
- `⏳` [LOT-027.md](./LOTS/LOT-027.md) — Gouvernance Enterprise : SSO (OIDC/SAML/SCIM), RBAC/ABAC & vLLM Privé
- `⏳` [LOT-028.md](./LOTS/LOT-028.md) — Déploiement Privé VPC/On-Prem, Conformité RGPD (Purge) & Exercices RPO/RTO
