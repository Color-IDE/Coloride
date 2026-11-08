## 📝 Résumé des modifications
- **Issue liée :** Closes #___
- **Crates / Packages modifiés :**

## 🛡️ Checklist Architecturale Coloride (Obligatoire)
- [ ] **Intégrité d'édition :** Aucune mutation directe du disque sans passer par `ropey` / le journal du Host Rust ou un `git worktree` isolé.
- [ ] **Sécurité & Sandbox :** Aucun appel d'outil d'agent ne s'exécute sur le shell hôte non isolé.
- [ ] **Fluidité UI :** Pas de re-rendu React global lors du streaming (stores atomiques respectés, CodeMirror 6 isolé).
- [ ] **Contrats :** Les types `protocol-types` (Rust ↔ TS) sont synchronisés.

## 🧪 Preuves de Validation (`Evidence`)
- [ ] `cargo test --workspace` & `cargo clippy -- -D warnings` passent à 100 %.
- [ ] `pnpm biome check` & `pnpm test` passent à 100 %.
- [ ] Testé manuellement dans l'application Tauri v2.
