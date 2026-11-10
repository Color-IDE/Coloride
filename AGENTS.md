# AGENTS.md — Règles d'Architecture et Invariants pour Agents IA & Développeurs

Ce fichier définit les règles obligatoires pour toute contribution (humaine ou par agent IA) dans le monorepo **Coloride**.

## 1. Invariants Architecturaux Stricts (Ne jamais violer)

1. **Le modèle propose ; le système autorise et exécute :**
   - Aucune sortie de LLM, de serveur MCP ou d'extension ne peut exécuter directement une commande système ou écrire hors du worktree sans passer par `PolicyEngine` (`crates/judge-orchestrator`) et `sandbox-runner`.
2. **Autorité unique de persistance dans `crates/host-core` :**
   - Le texte de référence réside dans `ropey::Rope` côté Rust, protégé par un journal durable (WAL).
   - **Unités d'offsets explicites :** Rust et `Tree-sitter` utilisent des octets **UTF-8** ; JavaScript, CodeMirror 6, LSP et l'émulateur VS Code utilisent des unités de code **UTF-16**. Toute conversion doit passer par le convertisseur centralisé de `host-core`.
3. **Isolation stricte de CodeMirror 6 (`packages/editor-cm6`) :**
   - La vue `EditorView` de CodeMirror 6 ne doit **jamais** être démontée/remontée par un re-rendu React (utiliser des stores atomiques séparés et un cadencement `requestAnimationFrame` à 16 ms pour le streaming).
   - Cible de latence de frappe : **p95 ≤ 16 ms** ; coloration locale Lezer : **< 2 ms**.
4. **Sémantique des 5 états Coloride liée au hash exact de la révision :**
   - `🟢 ✓ Validé` (`ValidatedGreen`) : exige une preuve `Evidence` valide (compilation + `vtsls`/Biome 0 erreur + 100 % tests impactés passés + `Preview Service` 0 crash/`console.error`) correspondant exactement au `content_blake3_hash` courant.
   - Dès qu'un caractère d'une plage `🟢` est modifié localement, elle passe synchroniquement à `🟠 ⟳ Validation périmée` (`StaleOrange`).
5. **Politique Sandbox *Fail-Closed* :**
   - Dans `crates/sandbox-runner`, si la sandbox demandée (Seatbelt macOS, Landlock/bwrap Linux, AppContainer Windows, OCI, Fargate, Firecracker) est indisponible, retourner une erreur explicite. **Il est formellement interdit de faire un repli silencieux vers le shell hôte non isolé.**
6. **Workspace Trust :**
   - Un dépôt non approuvé ne peut déclencher ni hooks Git, ni scripts, ni serveurs de langage locaux au dépôt, ni extensions actives.

## 2. Organisation du Travail par Lots / Lot-Driven Workflow (`docs/en/` & `docs/fr/`)

- Consulter systématiquement dans [`docs/`](./docs/README.md) (disponible en **🇬🇧 EN** et **🇫🇷 FR**) :
  - **Architecture Map & Contrats :** [EN](./docs/en/ARCHITECTURE_MAP.md) | [FR](./docs/fr/ARCHITECTURE_MAP.md)
  - **Plan d'Implémentation & Statuts :** [EN](./docs/en/IMPLEMENTATION_PLAN.md) | [FR](./docs/fr/IMPLEMENTATION_PLAN.md)
  - **Design System (5 états Coloride & Cockpit 4 zones) :** [EN](./docs/en/DESIGN_SYSTEM.md) | [FR](./docs/fr/DESIGN_SYSTEM.md)
  - **Fiches exécutables des 29 lots (`LOT-001`..`LOT-029`) :** [EN (`docs/en/LOTS/`)](./docs/en/LOTS) | [FR (`docs/fr/LOTS/`)](./docs/fr/LOTS)
- Respecter le périmètre **IN / OUT** de chaque lot et mettre à jour le statut du lot dans [docs/en/IMPLEMENTATION_PLAN.md](./docs/en/IMPLEMENTATION_PLAN.md) et [docs/fr/IMPLEMENTATION_PLAN.md](./docs/fr/IMPLEMENTATION_PLAN.md) une fois validé.
- Exécuter systématiquement les validations avant de déclarer un lot terminé :
  - `pnpm lint` (Biome)
  - `pnpm typecheck` (`tsc --noEmit`)
  - `pnpm test` (Vitest)
  - `cargo clippy --workspace --all-targets -- -D warnings`
  - `cargo test --workspace`
