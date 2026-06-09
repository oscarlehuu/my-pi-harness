# statusline

A self-contained pi extension that replaces the default pi footer via `ctx.ui.setFooter()` to render a grouped, **Claude-warm powerline** status line. Information is grouped by purpose and scan-by-color so it is fast to read at a glance.

## Grouped 3-line adaptive powerline
The status line is rendered as three left-anchored powerline strips, each grouping related information. Segments are colored truecolor (24-bit ANSI) blocks separated by the Nerd Font right-pointing separator glyph (`\ue0b0`, ``), with an end-cap arrow back to the default background.

- **Line 1 — identity (the bold anchor):** `✎ <session name>` on a clay background. Falls back to `π pi` when no session name is set.
- **Line 2 — location group (git + path):** `⎇ <branch>` plus git indicators `(<unstaged>, +<staged>, <ahead>↑, <behind>↓)` (gold, only when present), then `📁 <cwd>` with `$HOME` shortened to `~`.
- **Line 3 — stats group (model + context + tokens + cost):**
  - `🤖 <modelId> • <thinking>` (clay text on a warm background).
  - A 12-cell context bar (`▰` / `▱`) with the usage percentage, colored **sage / gold / coral** at the >70% / >90% thresholds.
  - `↑<in> ↓<out>` cumulative session tokens (k-formatted).
  - `$<cost>` session cost (`cost.toFixed(3)`). Derived from config/models.json pricing; an estimated API-equivalent cost (real cliproxy subscription cost is flat).
- **Last line(s) — preserved extension statuses:** statuses set via `ctx.ui.setStatus()`, sorted alphabetically by key and sanitized. This is the Foreman seam (see below) and is always rendered last.

### Claude-warm palette by design
Segment colors are hardcoded named constants (`CLAY`, `DARK`, `SEL`, `TOOL`, `OKBG`, `CREAM`, `SLATE`, `DIM`, `SAGE`, `GOLD`, `CORAL`) chosen to match the `claude-warm-dark` theme. Color is meaningful: clay = identity, warm tones = location/model, sage/gold/coral = healthy/warning/critical context usage.

### Adaptive layout (uses the real terminal width)
Width is measured with `visibleWidth` from `@earendil-works/pi-tui` (which strips ANSI), and every line is passed through `truncateToWidth(line, width)` as a final safety net so no line ever exceeds the terminal width.
- **width ≥ 90:** full 3-line layout with the full cwd.
- **60 ≤ width < 90:** same 3 lines, but the cwd is shortened to `~/…/<lastdir>` and the `🤖`/`📁` emoji are dropped (text kept).
- **width < 60:** collapses to 2 plain lines (no glyphs, no backgrounds — ASCII style regardless of the env toggle) to guarantee no overflow on narrow terminals:
  - line 1: `✎ <name> · ⎇ <branch>`
  - line 2: `<NN%> · <modelId> <thinking>`
  - followed by the preserved extension-statuses line.

### No Nerd Font? `PI_STATUSLINE_ASCII=1`
The powerline separator (`\ue0b0`) requires a Nerd Font. Set `PI_STATUSLINE_ASCII=1` to disable the arrow glyphs: segments are still rendered as colored background blocks but separated by a single space instead of the `` separator. (The `width < 60` collapse already uses a plain ASCII style regardless of this toggle.)

## Caveat: Replaces the Entire Footer
Since `ctx.ui.setFooter()` replaces the built-in footer entirely, we must re-render the extension-statuses line ourselves. Without this, outputs from other extensions (such as Foreman or Continual Learning) would be lost (regression). This extension preserves that seam exactly — the extension-statuses line is always rendered last.

## Performance: git polling
Because `render()` is synchronous and executes on every frame, git status operations are decoupled from render calls to ensure no UI blocking occurs. A background loop refreshes status using `execFile` (node:child_process) every 2.5 seconds, caches the dirty/ahead/behind numbers, and invokes `tui.requestRender()` if a state change is detected. The background timer and branch-change listener are cleaned up correctly via `dispose()`.

## Foreman Integration (Future)
A Foreman "stage + agents-alive" section can be surfaced dynamically without modifying this extension. Foreman simply calls `ctx.ui.setStatus("foreman", <text>)`, and the output appears automatically via the preserved extension-statuses line.

The alternative of implementing a dedicated inline section in this extension to read Foreman's internal state was rejected because it would require a hard cross-extension dependency. This violates the harness design rule: *Compose through substrate (session transcript → AGENTS.md), no hard cross-extension imports.*
