# statusline

A new self-contained pi extension that replaces the default pi footer via `ctx.ui.setFooter()` to render a high-density, custom status line.

## Overview
What it renders:
- **Line 1 (Identity/Location):**
  - **Session Name:** Current session name with a pencil icon (`✎ session-name`), rendered in accent color (only when set).
  - **Git Branch:** Current git branch prefixed with `⎇` (muted), appended with status indicators `(unstaged, staged, ahead↑, behind↓)` in warning color when changes are detected.
  - **Working Directory:** The session current working directory, relative to home (e.g. `~/path/to/project`), muted. Dropped first if the width is less than NARROW (60).
- **Line 2 (Stats Group):**
  - **Context usage bar:** A themed 12-cell bar (`▰` / `▱`) with the current context usage percentage (colored green/warning/error based on usage thresholds, or `?` when unknown).
  - **Session Tokens:** Cumulative input tokens, output tokens (k-formatted), muted. Dropped if the line does not fit.
  - **Session Cost:** USD cost (muted). Derived from config/models.json pricing. The cost is an estimated API-equivalent cost (as real cliproxy subscription cost is flat). Dropped first if the line does not fit.
  - **Model ID & Thinking Level (Right-aligned):** The active model ID with its thinking level (`model-id • thinking-level` or `model-id • thinking off` if reasoning is supported but disabled, else just `model-id`), muted. Never dropped.
- **Line 3+:**
  - **Preserved Extension Statuses:** The extension statuses set via `ctx.ui.setStatus()`, sorted alphabetically by key and sanitized.

## Caveat: Replaces the Entire Footer
Since `ctx.ui.setFooter()` replaces the built-in footer entirely, we must re-render the extension-statuses line ourselves. Without this, outputs from other extensions (such as Foreman or Continual Learning) would be lost (regression). This extension preserves that seam exactly.

## Performance: git polling
Because `render()` is synchronous and executes on every frame, git status operations are decoupled from render calls to ensure no UI blocking occurs. A background loop refreshes status using `execFile` (node:child_process) every 2.5 seconds, caches the dirty/ahead/behind numbers, and invokes `tui.requestRender()` if a state change is detected. The background timer and branch-change listener are cleaned up correctly via `dispose()`.

## Foreman Integration (Future)
A Foreman "stage + agents-alive" section can be surfaced dynamically without modifying this extension. Foreman simply calls `ctx.ui.setStatus("foreman", <text>)`, and the output appears automatically via the preserved extension-statuses line.

The alternative of implementing a dedicated inline section in this extension to read Foreman's internal state was rejected because it would require a hard cross-extension dependency. This violates the harness design rule: *Compose through substrate (session transcript → AGENTS.md), no hard cross-extension imports.*
