---
name: "🐛 Bug Report / Régression"
about: "Signaler une anomalie, une désynchronisation d'état ou un problème d'isolation"
title: "[BUG] "
labels: ["type: fix"]
---

## 🚨 Symptôme observé
Description concise du problème (ex. décalage d'offset UTF-8/UTF-16 entre CodeMirror 6 et `ropey`, badge `🟢 Validé` non invalidé, échec sandbox).

## 🔄 Étapes de reproduction
1. Ouvrir un workspace TypeScript avec...
2. Lancer un chat agent (Codex / Claude Code) avec...
3. Modifier la ligne X pendant que...

## 🖥️ Environnement
- **OS :** macOS (Apple Silicon) / Windows 11 / Ubuntu 24.04
- **Version Coloride / Commit SHA :**
- **Mode Sandbox actif :** OS Natif (Seatbelt/Landlock/AppContainer) / OCI (OrbStack/Docker/Podman) / Cloud
- **Moteur d'agent utilisé :** Claude Code / Codex / Local (`llama.cpp` / Ollama)

## 📎 Logs & Trace OpenTelemetry
Coller ici le `task_id`, `snapshot_id` ou les logs du Host Rust.
