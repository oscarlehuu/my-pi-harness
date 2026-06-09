# statusline

A new self-contained pi extension that replaces the default pi footer via `ctx.ui.setFooter()` to render a high-density, custom status line.

## Overview
What it renders:
- **Line 1 (Left):**
  - **Session Name:** Current session name with a pencil icon (`✎ session-name`), rendered in accent color (only when set).
  - **Context usage bar:** A themed 12-cell bar (`▰` / `▱`) with the current context usage percentage (colored green/warning/error based on usage thresholds, or `?` when unknown).
  - **Git Branch:** Current git branch prefixed with `⎇` (muted), appended with status indicators `(unstaged, staged, ahead↑, behind↓)` in warning color when changes are detected.
  - **Working Directory:** The session current working directory, relative to home (e.g. `~/path/to/project`), muted.
  - **Session Cost & Tokens:** Cumulative input tokens, output tokens (k-formatted), and USD cost (muted).
- **Line 1 (Right):**
  - **Model ID & Thinking Level:** The active model ID with its thinking level (`model-id • thinking-level` or `model-id • thinking off` if reasoning is supported but disabled, else just `model-id`), muted.
- **Line 2+:**
  - **Preserved Extension Statuses:** The extension statuses set via `ctx.ui.setStatus()`, sorted alphabetically by key and sanitized.

## Caveat: Replaces the Entire Footer
Since `ctx.ui.setFooter()` replaces the built-in footer entirely, we must re-render the extension-statuses line ourselves. Without this, outputs from other extensions (such as Foreman or Continual Learning) would be lost (regression). This extension preserves that seam exactly.

## Performance: git polling
Because `render()` is synchronous and executes on every frame, git status operations are decoupled from render calls to ensure no UI blocking occurs. A background loop refreshes status using `execFile` (node:child_process) every 2.5 seconds, caches the dirty/ahead/behind numbers, and invokes `tui.requestRender()` if a state change is detected. The background timer and branch-change listener are cleaned up correctly via `dispose()`.

## Foreman Integration (Future)
A Foreman "stage + agents-alive" section can be surfaced dynamically without modifying this extension. Foreman simply calls `ctx.ui.setStatus("foreman", <text>)`, and the output appears automatically via the preserved extension-statuses line.

The alternative of implementing a dedicated inline section in this extension to read Foreman's internal state was rejected because it would require a hard cross-extension dependency. This violates the harness design rule: *Compose through substrate (session transcript → AGENTS.md), no hard cross-extension imports.*
