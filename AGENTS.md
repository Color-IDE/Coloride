# AGENTS.md — Architectural Rules & Invariants

> Read in: [English](#agents-en) · [Français](#agents-fr)

---

<a id="agents-en"></a>

## English — Mandatory Rules for AI Agents & Developers

1. **The Model Proposes; The System Authorizes and Executes:**
   - No LLM output, MCP server response, or extension may directly execute a system command or write outside the worktree without passing through `PolicyEngine` (`crates/judge-orchestrator`) and `sandbox-runner`.
2. **Single Persistence Authority in `crates/host-core`:**
   - Authoritative document text lives in `ropey::Rope` on the Rust side, backed by a durable Write-Ahead Log (WAL).
   - **Explicit Offset Units:** Rust and `Tree-sitter` use **UTF-8** bytes; JavaScript, CodeMirror 6, LSP, and the VS Code Extension Emulator use **UTF-16** code units. All conversions must go through `host-core`'s centralized converter.
3. **Strict Isolation of CodeMirror 6 (`packages/editor-cm6`):**
   - The CodeMirror 6 `EditorView` must **never** be unmounted/remounted by a React re-render (use isolated atomic stores and `16 ms` `requestAnimationFrame` stream batching).
   - Keystroke latency target: **p95 <= 16 ms**; local Lezer highlighting: **< 2 ms**.
4. **Coloride 5-State Semantics Bound to the Exact Revision Hash:**
   - `Validated` (`ValidatedGreen` / `✓`): requires a valid `Evidence` struct (build + `vtsls`/Biome 0 errors + 100% impacted tests passed + `Preview Service` 0 crashes/`console.error`) matching the exact `content_blake3_hash`.
   - Editing a single character inside a `ValidatedGreen` range synchronously downgrades it to `Stale Validation` (`StaleOrange` / `⟳`).
5. **Fail-Closed Sandbox Policy:**
   - In `crates/sandbox-runner`, if the requested sandbox (macOS Seatbelt, Linux Landlock/bwrap, Windows AppContainer, OCI, Fargate, Firecracker) is unavailable, return an explicit error. **Silent fallback to the unisolated host shell is strictly forbidden.**
6. **Workspace Trust:**
   - An untrusted repository cannot trigger Git hooks, startup scripts, workspace-local language servers, or active extensions.

---

<a id="agents-fr"></a>

## Français — Règles Obligatoires pour Agents IA & Développeurs

1. **Le modèle propose ; le système autorise et exécute :**
   - Aucune sortie de LLM, de serveur MCP ou d'extension ne peut exécuter directement une commande système ou écrire hors du worktree sans passer par `PolicyEngine` (`crates/judge-orchestrator`) et `sandbox-runner`.
2. **Autorité unique de persistance dans `crates/host-core` :**
   - Le texte de référence réside dans `ropey::Rope` côté Rust, protégé par un journal durable (WAL).
   - **Unités d'offsets explicites :** Rust et `Tree-sitter` utilisent des octets **UTF-8** ; JavaScript, CodeMirror 6, LSP et l'émulateur VS Code utilisent des unités de code **UTF-16**. Toute conversion doit passer par le convertisseur centralisé de `host-core`.
3. **Isolation stricte de CodeMirror 6 (`packages/editor-cm6`) :**
   - La vue `EditorView` de CodeMirror 6 ne doit **jamais** être démontée/remontée par un re-rendu React (utiliser des stores atomiques séparés et un cadencement `requestAnimationFrame` à 16 ms pour le streaming).
   - Cible de latence de frappe : **p95 <= 16 ms** ; coloration locale Lezer : **< 2 ms**.
4. **Sémantique des 5 états Coloride liée au hash exact de la révision :**
   - `Validé` (`ValidatedGreen` / `✓`) : exige une preuve `Evidence` valide (compilation + `vtsls`/Biome 0 erreur + 100 % tests impactés passés + `Preview Service` 0 crash/`console.error`) correspondant exactement au `content_blake3_hash` courant.
   - Dès qu'un caractère d'une plage `ValidatedGreen` est modifié localement, elle passe synchroniquement à `Validation périmée` (`StaleOrange` / `⟳`).
5. **Politique Sandbox *Fail-Closed* :**
   - Dans `crates/sandbox-runner`, si la sandbox demandée (Seatbelt macOS, Landlock/bwrap Linux, AppContainer Windows, OCI, Fargate, Firecracker) est indisponible, retourner une erreur explicite. **Il est formellement interdit de faire un repli silencieux vers le shell hôte non isolé.**
6. **Workspace Trust :**
   - Un dépôt non approuvé ne peut déclencher ni hooks Git, ni scripts, ni serveurs de langage locaux au dépôt, ni extensions actives.

## Validation Checks

Run all workspace checks locally before submitting changes:
- `pnpm lint` (Biome)
- `pnpm typecheck` (`tsc -b`)
- `pnpm test` (Vitest)
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo test --workspace`
