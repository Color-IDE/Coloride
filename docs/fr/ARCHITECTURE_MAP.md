# Coloride — Cartographie Architecturale, Décisions et Analyse des Risques (`ARCHITECTURE_MAP.md`)

> Document de référence issu de l'analyse intégrale de [ARCHITECTURE_TECHNIQUE.md](./ARCHITECTURE_TECHNIQUE.md).
> Il synthétise les sous-systèmes, les contrats d'interface, les flux de données, les exigences fonctionnelles et non fonctionnelles, les arbitrages de cohérence et les risques techniques.
> Voir [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) pour l'ordonnancement et [LOTS/](./LOTS) pour les fiches exécutables (`LOT-001` à `LOT-028`).

---

## 1. Vision Architecturale et Invariants Fondamentaux

**Coloride** est un environnement de réalisation logicielle où chaque action proposée par une IA reste soumise à un **contrôle déterministe**, une **exécution isolée** et des **preuves vérifiables** (`Evidence`).

### Invariants non négociables
1. **Le modèle propose ; le système autorise et exécute :** aucun texte généré par un LLM ou un agent externe ne devient directement une commande privilégiée.
2. **Autorité unique de persistance dans le Host Rust :** chaque document est géré en mémoire par `ropey::Rope` dans le Host Rust avec un journal durable (Write-Ahead Log) et une distinction explicite entre révision interactive (CodeMirror 6), révision journalisée et révision sauvegardée sur disque.
3. **Preuves liées au snapshot exact (`Evidence`) :** les 5 états visuels Coloride (`🟢 ✓ Validé`, `🟡 ! À examiner`, `🔴 ✕ Échec`, `🟠 ⟳ Validation périmée`, `🔵 • Source inchangée`) sont liés cryptographiquement au hash de la révision testée. La modification d'un seul caractère dans une plage `🟢` l'invalide immédiatement en `🟠`.
4. **Isolation *Fail-Closed* sans Docker obligatoire :** la sandbox native de l'OS (`Seatbelt` sur macOS, `Landlock` + `bubblewrap` sur Linux, `AppContainer` + `Job Objects` sur Windows) s'exécute en `< 5 ms` sur un `git worktree` *Copy-on-Write*. En cas d'indisponibilité de la sandbox, aucun repli silencieux vers le shell hôte n'est autorisé.
5. **Le code demeure l'unique source de vérité :** les cinq personas (*Grand public / No-Code*, *Développeur débutant*, *Développeur senior*, *Ingénieur DevOps*, *DBA*) opèrent sur le même workspace à travers trois modes (*Créer*, *Apprendre*, *Développer*) et deux espaces spécialisés (*Infrastructure*, *Données*). Le niveau de persona ne modifie jamais les permissions du `Policy Engine`.

---

## 2. Cartographie des Sous-Systèmes et du Monorepo

```text
coloride/
├── apps/
│   ├── desktop-tauri/          # Application Tauri v2 (assemblage fenêtre, menus natifs, updater signé)
│   └── web-ui/                 # Interface React + Vite + Zustand/Jotai (Cockpit 4 zones, Multi-Chat, Inspecteur)
├── packages/
│   ├── editor-cm6/             # Vue CodeMirror 6 isolée, Lezer < 2 ms, décorations Coloride (🟢/🟡/🔴/🟠/🔵), diff merge
│   └── protocol-types/         # Types TypeScript générés automatiquement depuis les contrats Rust (ts-rs / specta)
└── crates/
    ├── host-core/              # Monolithe modulaire Rust : buffers ropey, journal, Git checkpoints, LSP/Biome/DAP, migration 1-clic
    ├── context-engine/         # SQLite WAL/mmap, FTS5 (BM25), Tree-sitter, graphe d'impact, sqlite-vec optionnel et serveur MCP local
    ├── judge-orchestrator/     # Machine à états, Policy Engine, budgets, Model Gateway, pont ACP/SDK et validation Evidence
    └── sandbox-runner/         # Exécution isolée : Sandbox OS native (Seatbelt/Landlock/AppContainer), Warm OCI, Fargate et Firecracker
```

| Domaine | Composant / Crate | Responsabilités clés |Dépendances techniques |
|---|---|---|---|
| **1. Contrats & Socle** | `packages/protocol-types` & module de types Rust | Schémas versionnés et générés automatiquement (`ts-rs`/`specta`) pour les 9 contrats canoniques et les états Coloride. | `serde`, `ts-rs`/`specta`, `blake3` |
| **2. Core Host & Édition** | `crates/host-core` | Buffers `ropey`, conversions d'offsets UTF-8 ↔ UTF-16, journal durable, sauvegarde atomique, reprise après crash, *Lazy Boot*, checkpoints Git invisibles (`refs/coloride/checkpoints/<task_id>`), `git worktree` CoW, supervision `vtsls`/Biome/DAP/PTY, `Preview Service` isolé, migration 1-clic, chargeur `.vsix` OpenVSX, superviseur `VS Code Extension Host Shim` ([LOT-029](./LOTS/LOT-029.md)) et plugins WASI (`wasmtime`). | `tokio`, `ropey`, `git2`, `portable-pty`, `wasmtime` |
| **3. Vue d'Édition CM6** | `packages/editor-cm6` | Rendu DOM virtualisé hors cycle React, coloration locale Lezer (< 2 ms), synchronisation binaire (`tauri::ipc::Channel`), gestion IME, `StateField`/`Decoration` pour les 5 états Coloride, revue `@codemirror/merge`, coédition V1 `y-codemirror.next`. | `@codemirror/state`, `@codemirror/view`, `@codemirror/merge`, `y-codemirror.next` |
| **4. Interface Cockpit** | `apps/web-ui` & `apps/desktop-tauri` | Cockpit en 4 zones (Activity Bar, Panneau latéral, Grille centrale 1/2/4/8 chats, Inspecteur `[Preview \| Code & Diff]`), stores atomiques Zustand/Jotai cadencés à 16 ms (`requestAnimationFrame`), modes *Créer* / *Apprendre* / *Développer*. | Tauri v2, React, Zustand/Jotai, `xterm.js` |
| **5. Context Engine** | `crates/context-engine` | Filtrage ACL et secrets avant indexation et export, SQLite `WAL` + `mmap`, recherche lexicale FTS5 (BM25, 0 Mo requis au lancement), AST incrémental `Tree-sitter`, graphe d'impact et *Test Impact Analysis*, embeddings optionnels `sqlite-vec` (< 150 Mo), serveur MCP local (< 20 ms). | `rusqlite` (FTS5, WAL, mmap), `tree-sitter`, `sqlite-vec` |
| **6. Juge, Agents & Modèles** | `crates/judge-orchestrator` | Machine à états persistante (11 états), `Policy Engine`, `BudgetLedger`, `Tool Broker` à clés d'idempotence, `Model Gateway` (local `llama.cpp`/Ollama, BYOK coffre OS, Cloud managé, vLLM privé, *Prompt Caching*), pont `ACP/SDK` (Claude Code, Codex, Copilot SDK), compilation AST `ChangeSet`, Juge déterministe (max 2 retries auto). | `tokio`, `keyring`, `opentelemetry`, `axum` (cloud) |
| **7. Isolation & Exécution** | `crates/sandbox-runner` | Niveau 1 : Sandbox OS native (< 5 ms : Seatbelt, Landlock/bwrap, AppContainer/Job Objects). Niveau 2 : Warm Pool OCI (OrbStack/Docker/Podman). Niveau 3 : AWS ECS Fargate. Niveau 4 : Firecracker (Linux/KVM). | APIs OS (Seatbelt, Landlock, Win32 AppContainer/JobObject), OCI, AWS SDK |

---

## 3. Contrats d'Interface et Flux de Données Structurants

### 3.1 Les 9 contrats techniques canoniques (stabilisés dès [LOT-002](./LOTS/LOT-002.md))

| Contrat | Champs et invariants obligatoires |
|---|---|
| `EditorTransaction` | `document_id`, `session_generation`, `base_revision`, `op_id`, `changes` (offsets explicites UTF-8 / UTF-16), `selection`, `origin` (`User`, `Agent(TaskId)`, `Peer(PeerId)`), flag `ime_composing`. |
| `EditorSnapshot` | `document_id`, `session_generation`, `interactive_revision`, `journaled_revision`, `disk_saved_revision`, `content_blake3_hash`, `has_unsaved_changes`. |
| `TaskSpec` | `task_id`, `objective`, `workspace_id`, `base_snapshot_id`, `target_env`, `policy`, `budget_limits`, `acceptance_criteria`. |
| `ContextBundle` | `bundle_id`, `workspace_version`, `excerpts` (sources, plages, `ConfidenceLevel`, fraîcheur), `classification`, `authorized_destination`, préfixe stable `cache_control`. |
| `ModelProvider` | `provider_id`, `capabilities`, streaming token par token, `structured_tool_calls`, `CancellationToken`, métriques d'usage et coût. |
| `ToolCall` | `call_id`, `tool_name`, `validated_args`, `required_capabilities`, `preconditions`, `idempotency_key`. |
| `ChangeSet` | `changeset_id`, `base_revision`, opérations AST (`Tree-sitter`) ou blocs `SEARCH/REPLACE` ancrés sur les symboles, `affected_files`, `result_digest`. |
| `Evidence` | `evidence_id`, `tested_snapshot_hash`, `checkpoint_ref`, commandes exécutées, codes de sortie, diagnostics `vtsls`/Biome, rapport runtime du `Preview Service` (`0 console.error` / crash), artefacts et verdict (`🟢`/`🟡`/`🔴`). |
| `Approval` | `approval_id`, `actor_identity`, `target_env`, `action_kind`, `approved_digest` (invalide si le patch, la cible ou le plan change d'un bit), `expires_at`. |

### 3.2 Machine à états d'une tâche ([LOT-013](./LOTS/LOT-013.md))
- **Flux nominal :** `Created → ContextReady → Planned → Running → Verifying → AwaitingReview → Applied`
- **États d'exception et de contrôle :** `Paused` (plafond de budget atteint ou attente utilisateur), `Failed` (après 2 cycles d'auto-correction en échec ou répétition de la même erreur), `Cancelled` (annulation immédiate), `NeedsReconciliation` (interruption pendant une action externe dont l'état doit être inspecté avant toute reprise, sans retry aveugle).

---

## 4. Recensement Exhaustif des Exigences

### 4.1 Exigences Fonctionnelles (EF)
- **EF-01 (Édition & Persistance) :** CodeMirror 6 isolé de React, synchronisé en binaire avec `ropey` (`host-core`), journal de récupération après crash, sauvegarde atomique, détection de conflits disque, respect de la composition IME ([LOT-003](./LOTS/LOT-003.md), [LOT-004](./LOTS/LOT-004.md)).
- **EF-02 (États de validation Coloride) :** 5 états (`🟢 ✓ Validé`, `🟡 ! À examiner`, `🔴 ✕ Échec`, `🟠 ⟳ Validation périmée`, `🔵 • Source inchangée`) combinant couleur, icône et libellé explicite liés au hash de la révision, avec invalidation locale immédiate (`🟢 → 🟠`) dès modification ([LOT-004](./LOTS/LOT-004.md), [LOT-015](./LOTS/LOT-015.md)).
- **EF-03 (Cockpit 4 zones & Grille Multi-Chat) :** Activity Bar, panneau latéral dynamique, grille centrale 1/2/4/8 chats (séquentielle au MVP, 8 agents parallèles sur worktrees isolés avec détection de conflits AST en Bêta) et inspecteur `[Preview | Code & Diff]` ([LOT-005](./LOTS/LOT-005.md), [LOT-020](./LOTS/LOT-020.md)).
- **EF-04 (Time-Travel Checkpoints Git) :** Références invisibles `refs/coloride/checkpoints/<task_id>` avant chaque action d'agent et restauration en 1 clic sans polluer `git log` ni écraser les modifications humaines ([LOT-011](./LOTS/LOT-011.md)).
- **EF-05 (Context Engine & MCP local) :** SQLite `WAL`/`mmap` + FTS5 (BM25) + graphe `Tree-sitter`/LSP (0 Mo requis au lancement), `sqlite-vec` optionnel (< 150 Mo), priorité aux buffers non sauvegardés, filtrage ACL/secrets avant indexation et export, serveur MCP local (< 20 ms) ([LOT-007](./LOTS/LOT-007.md), [LOT-008](./LOTS/LOT-008.md), [LOT-009](./LOTS/LOT-009.md)).
- **EF-06 (Orchestration, Modèles & Agents ACP) :** Machine à états persistante, `Policy Engine`, réservation de budgets, `Model Gateway` (local `llama.cpp`/Ollama, BYOK coffre OS, Cloud managé) et pont `ACP/SDK` (Claude Code, Codex, Copilot SDK) ([LOT-013](./LOTS/LOT-013.md), [LOT-014](./LOTS/LOT-014.md)).
- **EF-07 (Sandboxes, Preview & Publication) :** Sandbox OS native 0-VM (< 5 ms), Warm Pool OCI, Runner Cloud Fargate, `Preview Service` isolé capturant erreurs runtime/DOM dans `Evidence`, et publication statique Cloudflare R2/Pages par digest avec rollback 1-clic ([LOT-012](./LOTS/LOT-012.md), [LOT-016](./LOTS/LOT-016.md), [LOT-017](./LOTS/LOT-017.md)).
- **EF-08 (Migration 1-clic, Qualité locale & Émulateur d'Extensions VS Code) :** Import 1-clic (VS Code, Cursor, Claude Desktop) avec mise en quarantaine des MCP importés, chargement natif des paquets `.vsix` déclaratifs OpenVSX ([LOT-006](./LOTS/LOT-006.md)), *Workspace Trust*, `vtsls` LSP, Biome, terminal `xterm.js` et DAP JS ([LOT-010](./LOTS/LOT-010.md)), et **Émulateur d'Extensions VS Code (`VS Code Extension Host Shim`)** isolé en Sandbox OS traduisant l'API `vscode.*` (`commands`, `workspace`, `languages`, `window`) vers `ropey` et CodeMirror 6 ([LOT-029](./LOTS/LOT-029.md)).
- **EF-09 (Bêta, V1 & Enterprise) :** Multicurseur/pliage/grands fichiers ([LOT-019](./LOTS/LOT-019.md)), modes *Créer* (catalogue visuel AST) et *Apprendre* (micro-agent pédagogique) ([LOT-021](./LOTS/LOT-021.md)), *Prompt Caching*, mémoire d'équipe gouvernée et OpenTelemetry ([LOT-022](./LOTS/LOT-022.md)), coédition Yjs `y-codemirror.next` avec Undo isolé par origine ([LOT-023](./LOTS/LOT-023.md)), espace DBA PostgreSQL + clones assainis ([LOT-024](./LOTS/LOT-024.md)), espace DevOps Terraform/Ansible/CI/K8s + exécuteur séparé ([LOT-025](./LOTS/LOT-025.md)), Firecracker + WASI ([LOT-026](./LOTS/LOT-026.md)), SSO OIDC/SAML/SCIM + RBAC/ABAC + vLLM privé ([LOT-027](./LOTS/LOT-027.md)), VPC/On-Prem + purge RGPD + exercices RPO/RTO ([LOT-028](./LOTS/LOT-028.md)).

### 4.2 Exigences Non Fonctionnelles et Cibles Mesurables (ENF)

| Métrique / Exigence | Cible documentée | Lot(s) de validation |
|---|---|---|
| Réactivité de saisie CodeMirror 6 | **p95 ≤ 16 ms** (avec chat en streaming, terminal et arborescence actifs) | [LOT-004](./LOTS/LOT-004.md), [LOT-005](./LOTS/LOT-005.md), [LOT-018](./LOTS/LOT-018.md) |
| Coloration syntaxique locale Lezer | **< 2 ms** (enrichie ensuite par Tree-sitter/LSP) | [LOT-004](./LOTS/LOT-004.md), [LOT-010](./LOTS/LOT-010.md) |
| Synchronisation de l'Inspecteur droit | **< 10 ms** lors du changement de chat actif | [LOT-005](./LOTS/LOT-005.md), [LOT-020](./LOTS/LOT-020.md) |
| Démarrage de la Sandbox OS native | **< 5 ms**, 0 Mo de RAM de VM additionnelle | [LOT-011](./LOTS/LOT-011.md), [LOT-012](./LOTS/LOT-012.md) |
| Latence du serveur MCP local | **< 20 ms** sur l'index chaud SQLite `WAL`/`mmap` | [LOT-009](./LOTS/LOT-009.md) |
| Ouverture d'un fichier local (≤ 1 Mo) | **p95 ≤ 150 ms** (indexation en arrière-plan) | [LOT-003](./LOTS/LOT-003.md), [LOT-004](./LOTS/LOT-004.md) |
| Recherche de contexte sur corpus indexé | **p95 ≤ 300 ms** | [LOT-008](./LOTS/LOT-008.md) |
| Complétion IA locale courte (1.5B chargé) | **p95 ≤ 700 ms** avec annulation immédiate dès nouvelle frappe | [LOT-014](./LOTS/LOT-014.md) |
| Premier retour tests ciblés (*Test Impact Analysis*) | **< 2 s** dans la sandbox avant la suite complète | [LOT-007](./LOTS/LOT-007.md), [LOT-015](./LOTS/LOT-015.md) |
| Démarrage desktop (*Lazy Boot*) | **p95 ≤ 3 s** jusqu'à l'interface utilisable | [LOT-005](./LOTS/LOT-005.md), [LOT-018](./LOTS/LOT-018.md) |
| Qualité agent MVP | **≥ 70 %** de réussite sur 100 tâches TS hors entraînement prompts | [LOT-018](./LOTS/LOT-018.md) |
| Invalidation globale publication Cloudflare | **< 50 ms** (0 $ de frais d'*egress* R2) | [LOT-017](./LOTS/LOT-017.md) |
| Disponibilité managée & Reprise Enterprise | **99,5 %** (MVP) / **99,9 %** (Enterprise) ; **RPO ≤ 15 min**, **RTO ≤ 4 h** | [LOT-017](./LOTS/LOT-017.md), [LOT-028](./LOTS/LOT-028.md) |

---

## 5. Résolution des Tensions Architecturales et Informations à Valider

### 5.1 Tensions internes résolues dans le découpage
1. **Grille Multi-Chat séquentielle (MVP) vs parallèle 8 agents (Bêta) :** Le layout UI de la grille et les onglets sont livrés dès [LOT-005](./LOTS/LOT-005.md) (`M1.1`), mais l'orchestration au MVP reste **séquentielle** (1 Codeur + 1 Reviewer actif par workspace dans [LOT-013](./LOTS/LOT-013.md)/[LOT-015](./LOTS/LOT-015.md)). L'exécution parallèle de 8 agents simultanés sur 8 `git worktree` distincts avec détection de conflits AST est isolée dans [LOT-020](./LOTS/LOT-020.md) (`M2.0`).
2. **Numérotation des Sprints vs durées Gantt :** Les estimations de tous les lots ([LOT-001](./LOTS/LOT-001.md) à [LOT-028](./LOTS/LOT-028.md)) sont exprimées en **jours-développeur et heures** vérifiables, rattachées aux jalons `M1.1` → `M4.0`.
3. **Encapsulation de Seatbelt (`sandbox-exec`) sur macOS :** L'implémentation macOS est isolée derrière le trait `SandboxBackend` dans `crates/sandbox-runner` ([LOT-012](./LOTS/LOT-012.md)).
4. **Disponibilité des dépendances dans la Sandbox OS hors-ligne :** Le provisionneur de `git worktree` ([LOT-011](./LOTS/LOT-011.md)) utilise le clonage *Copy-on-Write* (APFS `cp -c`, reflinks Linux, jonctions/hardlinks du store `pnpm` en lecture seule sur Windows) afin que les tests s'exécutent en `< 2 s` avec le réseau coupé par défaut.

### 5.2 Hypothèses et seuils candidats identifiés (à confirmer par les fondateurs)
- **H-01 (Seuil Mode Grand Fichier — [LOT-019](./LOTS/LOT-019.md)) :** Seuil candidat proposé à `> 5 Mo` ou `> 50 000 lignes`.
- **H-02 (Plafond de budget par défaut d'une tâche — [LOT-013](./LOTS/LOT-013.md)) :** Seuil candidat proposé à `1,00 $` / `200 000 tokens` / `60 s` CPU sandbox par tâche avant passage à l'état `Paused`.
- **H-03 (Délais de *debounce* d'indexation — [LOT-008](./LOTS/LOT-008.md)) :** Candidats proposés à `300 ms` pour FTS5/Tree-sitter et `2 000 ms` pour `sqlite-vec`.
- **H-04 (Matériel de référence pour les cibles p95 — [LOT-018](./LOTS/LOT-018.md)) :** Apple M2 16 Go (macOS) et CPU 8 threads x64 / 16 Go RAM / NVMe (Windows 11 & Ubuntu 24.04).
