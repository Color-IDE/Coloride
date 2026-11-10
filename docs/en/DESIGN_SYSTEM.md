# DESIGN_SYSTEM.md — Coloride Visual System & 4-Zone Cockpit (`EN`)

> 🇫🇷 [Version française disponible ici](../fr/DESIGN_SYSTEM.md)

This document specifies the visual design tokens, the accessible semantics of the 5 Coloride validation states, and the layout rules of the **4-Zone Multi-Chat Cockpit** (implemented starting in [LOT-004](./LOTS/LOT-004.md) and [LOT-005](./LOTS/LOT-005.md)).

---

## 1. The 5 Coloride Validation States (WCAG AA/AAA Accessibility)

To guarantee full accessibility (protanopia/deuteranopia/tritanopia color blindness and screen readers VoiceOver, NVDA, Orca), **no state ever relies on color alone**. Every state combines:
1. **A high-contrast foreground and background color pair** (CodeMirror 6 gutter + Chat card border).
2. **A distinct geometric icon** (`✓`, `!`, `✕`, `⟳`, `•`).
3. **An explicit text label** (`aria-label` and visible badge).

| State | Code | Icon | Label EN / FR | Dark Mode (Bg / Border / Text) | Light Mode (Bg / Border / Text) | Exact Condition |
|---|---|---|---|---|---|---|
| 🟢 **Green** | `ValidatedGreen` | `✓` | `✓ Validated` / `✓ Validé` | `#052e16` / `#22c55e` / `#86efac` | `#dcfce7` / `#16a34a` / `#14532d` | Build + `vtsls`/Biome + 100% impacted tests + Preview 0 runtime errors on exact snapshot hash |
| 🟡 **Yellow / Amber** | `ReviewYellow` | `!` | `! Needs Review` / `! À examiner` | `#422006` / `#eab308` / `#fde047` | `#fef9c3` / `#ca8a04` / `#713f12` | Agent patch awaiting human review, architectural decision, or AST conflict |
| 🔴 **Red** | `FailedRed` | `✕` | `✕ Failed` / `✕ Échec` | `#450a0a` / `#ef4444` / `#fca5a5` | `#fee2e2` / `#dc2626` / `#7f1d1d` | Build error, `vtsls` type error, blocking Biome rule, failed test or preview crash |
| 🟠 **Orange / Slate** | `StaleOrange` | `⟳` | `⟳ Stale Validation` / `⟳ Validation périmée` | `#431407` / `#f97316` / `#fdba74` | `#ffedd5` / `#ea580c` / `#7c2d12` | Previously `🟢` range modified locally by the user after tests passed |
| 🔵 **Blue** | `UnchangedBlue` | `•` | `• Unchanged Source` / `• Source inchangée` | `#0f172a` / `#3b82f6` / `#93c5fd` | `#dbeafe` / `#2563eb` / `#1e3a8a` | Original source or infrastructure code untouched by the current task |

---

## 2. The 4-Zone Multi-Chat Cockpit Grid

```text
┌──────┬───────────────────────┬────────────────────────────────────────────┬──────────────────────────────┐
│ Z1   │ Z2. DYNAMIC SIDEBAR   │ Z3. CENTER : MULTI-CHAT GRID (1/2/4/8)     │ Z4. CONTEXTUAL INSPECTOR     │
│ 48px │ 240px - 320px (flex)  │ Flexible (1fr)                             │ 380px - 50% (sync < 10 ms)   │
└──────┴───────────────────────┴────────────────────────────────────────────┴──────────────────────────────┘
```

- **Zone 1 (`Activity Bar` — fixed `48px`):** fast icon and keyboard shortcut navigation (`Cmd/Ctrl+1..6`) across Chat Sessions, File Explorer, Global FTS5 Search, Git/Checkpoints, Debug/Tests, and MCP/Extensions.
- **Zone 2 (`Sidebar` — DOM virtualized):** displays chat sessions with their status badge or the file tree annotated by validation state.
- **Zone 3 (`Multi-Chat Grid` — `1 | 2 | 4 | 8` cells):** each chat cell displays a `2px` border matching its real-time Coloride state and streams at `60 FPS` (`16 ms` `requestAnimationFrame` batching).
- **Zone 4 (`Inspector` — `[ 👁 Preview | 💻 Code & Diff ]`):** hosts the isolated **CodeMirror 6** instance (`@coloride/editor-cm6`) and `@codemirror/merge` review view, or the isolated `Preview Service`.

---

## 3. Typography & Fluidity Budgets

- **UI Font:** `Inter`, `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, sans-serif.
- **Code & Terminal Font:** `JetBrains Mono`, `SF Mono`, `Cascadia Code`, `Fira Code`, monospace.
- **Fluidity Budgets:**
  - CodeMirror 6 keystroke latency: **p95 ≤ 16 ms** (0 React re-mounts of the editor container).
  - Local Lezer syntax highlighting: **< 2 ms**.
  - Right inspector synchronization: **< 10 ms**.
