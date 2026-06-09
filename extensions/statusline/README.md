# statusline

A new self-contained pi extension that replaces the default pi footer via `ctx.ui.setFooter()` to render a high-density, custom status line.

## Overview
What it renders:
- **Line 1 (Left):**
  - **Context usage bar:** A themed 12-cell bar (`▰` / `▱`) with the current context usage percentage (colored green/warning/error based on usage thresholds, or `?` when unknown).
  - **Git Branch:** Current git branch prefixed with `⎇` (muted).
  - **Session Cost & Tokens:** Cumulative input tokens, output tokens (k-formatted), and USD cost (muted).
- **Line 1 (Right):**
  - **Model ID:** The active model ID (muted).
- **Line 2+:**
  - **Preserved Extension Statuses:** The extension statuses set via `ctx.ui.setStatus()`, sorted alphabetically by key and sanitized.

## Caveat: Replaces the Entire Footer
Since `ctx.ui.setFooter()` replaces the built-in footer entirely, we must re-render the extension-statuses line ourselves. Without this, outputs from other extensions (such as Foreman or Continual Learning) would be lost (regression). This extension preserves that seam exactly.

## Foreman Integration (Future)
A Foreman "stage + agents-alive" section can be surfaced dynamically without modifying this extension. Foreman simply calls `ctx.ui.setStatus("foreman", <text>)`, and the output appears automatically via the preserved extension-statuses line.

The alternative of implementing a dedicated inline section in this extension to read Foreman's internal state was rejected because it would require a hard cross-extension dependency. This violates the harness design rule: *Compose through substrate (session transcript → AGENTS.md), no hard cross-extension imports.*
