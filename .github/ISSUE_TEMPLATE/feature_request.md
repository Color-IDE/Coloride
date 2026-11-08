---
name: "✨ User Story / Feature Technique"
about: "Proposer une fonctionnalité ou une brique architecturale de Coloride"
title: "[FEAT] "
labels: ["type: feat"]
---

## 🎯 Persona & Contexte
- **Persona ciblé :** [ ] Développeur Senior [ ] Débutant [ ] No-Code [ ] DevOps [ ] DBA
- **Crate / Package impacté :** `host-core` | `context-engine` | `judge-orchestrator` | `sandbox-runner` | `editor-cm6` | `web-ui` | `desktop-tauri`

## 📖 User Story
**En tant que** [persona],
**Je veux** [action dans le Cockpit / l'Éditeur / le Juge],
**Afin de** [bénéfice mesurable].

## ⚙️ Spécifications Techniques & Contrats
- **Contrats Rust/TS touchés (`protocol-types`) :** `EditorTransaction` / `ChangeSet` / `Evidence` / Aucun
- **Impact latence / mémoire attendu :** (ex. IPC < 16 ms, démarrage sandbox < 5 ms)
- **Comportement sur les 3 OS (macOS / Windows / Linux) :**

## ✅ Critères d'Acceptation (Definition of Done)
- [ ] Implémentation complète sans blocage du thread UI.
- [ ] États de couleur Coloride (`🟢/🟡/🔴/🟠/🔵`) correctement mis à jour et invalidés en cas d'édition locale.
- [ ] Tests unitaires Rust / TypeScript ajoutés et passants.
- [ ] Vérifié sur macOS, Windows et Linux.
