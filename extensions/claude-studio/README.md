# Claude Studio Look

A warm-dark theme and compact tool renderers matching the Claude aesthetic for pi.

## Deliverables

1. **Theme Configuration** (`config/themes/claude-warm-dark.json`): A complete 51-token pi theme utilizing a warm-dark palette. Selected via settings `"theme": "claude-warm-dark"` or the `/settings` command.
2. **Tool Renderers Extension** (`extensions/claude-studio/`): Wraps the built-in `read`, `bash`, `edit`, and `write` tools with compact, ADHD-friendly UI outputs. Collapsed by default (one-line summary), expandable on demand with detail (using the standard `app.tools.expand` keybinding / Ctrl+O).
3. **Working Indicator / Spinner**: Configures a clean clay-toned spinner on session start to match the theme. The streaming indicator shows the clay dots followed by the word **"cooking"** (a calm, on-brand replacement for pi's default "Working..."), set via `pi.ui.setWorkingMessage("cooking")` (guarded; only called when the API is available).

## Architecture

- **Behavior Delegation**: Every re-registered tool forwards all execution logic to the original built-in implementations. No changes to actual tool execution.
- **Visual styling**: Avoids hardcoding any styling/colors, relying entirely on the active theme's token mappings via `theme.fg()` and `theme.bg()`.
- **Message Rendering**: Message stream rendering remains untouched for reliability.

## Related: Foreman tool output

The Foreman orchestrator tool's output is **collapsed by default** to a one-line stage summary (e.g. `▸ Foreman · GATE 1 · plan ready — approve or revise`), with the full transcript available on demand via the standard `app.tools.expand` keybinding (Ctrl+O) — matching the collapse-by-default pattern used by the tool renderers here. This is implemented in the `foreman` extension (`extensions/foreman/`), not in claude-studio.
