# DESIGN_SYSTEM.md — Système Visuel Coloride & Cockpit 4 Zones

Ce document spécifie les jetons visuels (*design tokens*), la sémantique accessible des 5 états de validation Coloride et les règles de mise en page du **Cockpit Multi-Chat en 4 zones** (utilisés dès [LOT-004](./LOTS/LOT-004.md) et [LOT-005](./LOTS/LOT-005.md)).

---

## 1. Les 5 États de Validation Coloride (Accessibilité WCAG AA/AAA)

Pour garantir une accessibilité irréprochable (daltonisme protanopie/deutéranopie/tritanopie et lecteurs d'écran VoiceOver, NVDA, Orca), **aucun état ne repose uniquement sur la couleur**. Chaque état associe obligatoirement :
1. **Une couleur de premier plan et d'arrière-plan** (gouttière CodeMirror 6 + bordure de carte Chat).
2. **Une icône géométrique distincte** (`✓`, `!`, `✕`, `⟳`, `•`).
3. **Un libellé explicite** (`aria-label` et badge visible).

| État | Code | Icône | Libellé FR / ES | Fond Sombre (Bg / Border / Text) | Fond Clair (Bg / Border / Text) | Condition stricte |
|---|---|---|---|---|---|---|
| 🟢 **Vert** | `ValidatedGreen` | `✓` | `✓ Validé` / `✓ Validado` | `#052e16` / `#22c55e` / `#86efac` | `#dcfce7` / `#16a34a` / `#14532d` | Build + `vtsls`/Biome + 100 % tests impactés + Preview 0 erreur sur le hash exact |
| 🟡 **Jaune / Ambre** | `ReviewYellow` | `!` | `! À examiner` / `! Revisar` | `#422006` / `#eab308` / `#fde047` | `#fef9c3` / `#ca8a04` / `#713f12` | Patch agent en attente d'arbitrage humain, décision d'architecture ou collision AST |
| 🔴 **Rouge** | `FailedRed` | `✕` | `✕ Échec` / `✕ Fallo` | `#450a0a` / `#ef4444` / `#fca5a5` | `#fee2e2` / `#dc2626` / `#7f1d1d` | Erreur de compilation, erreur `vtsls`, règle Biome bloquante, test ou preview en échec |
| 🟠 **Orange / Ardoise** | `StaleOrange` | `⟳` | `⟳ Validation périmée` / `⟳ Caducado` | `#431407` / `#f97316` / `#fdba74` | `#ffedd5` / `#ea580c` / `#7c2d12` | Plage précédemment `🟢` modifiée localement par l'utilisateur après les tests |
| 🔵 **Bleu** | `UnchangedBlue` | `•` | `• Source inchangée` / `• Sin cambios` | `#0f172a` / `#3b82f6` / `#93c5fd` | `#dbeafe` / `#2563eb` / `#1e3a8a` | Code d'origine ou d'infrastructure non modifié par la tâche courante |

---

## 2. Grille du Cockpit Multi-Chat en 4 Zones

```text
┌──────┬───────────────────────┬────────────────────────────────────────────┬──────────────────────────────┐
│ Z1   │ Z2. PANNEAU LATÉRAL   │ Z3. CENTRE : GRILLE MULTI-CHAT (1/2/4/8)   │ Z4. INSPECTEUR CONTEXTUEL    │
│ 48px │ 240px - 320px (flex)  │ Flexible (1fr)                             │ 380px - 50% (sync < 10 ms)   │
└──────┴───────────────────────┴────────────────────────────────────────────┴──────────────────────────────┘
```

- **Zone 1 (`Activity Bar` — `48px` fixe) :** navigation rapide par icônes et raccourcis clavier (`Cmd/Ctrl+1..6`) entre Sessions, Fichiers, Recherche FTS5, Git/Checkpoints, Debug/Tests et MCP/Extensions.
- **Zone 2 (`Sidebar` — virtualisée) :** affiche les sessions avec leur pastille d'état ou l'arborescence de fichiers annotée.
- **Zone 3 (`Multi-Chat Grid` — `1 | 2 | 4 | 8` cellules) :** chaque cellule de chat possède un contour de `2px` de la couleur de son état Coloride courant et streame à `60 FPS` (batching `requestAnimationFrame` de `16 ms`).
- **Zone 4 (`Inspector` — `[ 👁 Preview | 💻 Code & Diff ]`) :** contient l'instance isolée de **CodeMirror 6** (`@coloride/editor-cm6`) et la vue `@codemirror/merge`, ou l'aperçu isolé `Preview Service`.

---

## 3. Typographie et Budgets de Rendu

- **Police UI :** `Inter`, `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, sans-serif.
- **Police Code & Terminal :** `JetBrains Mono`, `SF Mono`, `Cascadia Code`, `Fira Code`, monospace (ligatures optionnelles).
- **Budgets de fluidité :**
  - Frappe CodeMirror 6 : **p95 ≤ 16 ms** (0 re-render React du conteneur d'édition).
  - Coloration locale Lezer : **< 2 ms**.
  - Bascule de l'inspecteur droit : **< 10 ms**.
