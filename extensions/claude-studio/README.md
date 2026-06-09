# Claude Studio Look

A warm-dark theme and compact tool renderers matching the Claude aesthetic for pi.

## Deliverables

1. **Theme Configuration** (`config/themes/claude-warm-dark.json`): A complete 51-token pi theme utilizing a warm-dark palette. Selected via settings `"theme": "claude-warm-dark"` or the `/settings` command.
2. **Tool Renderers Extension** (`extensions/claude-studio/`): Wraps the built-in `read`, `bash`, `edit`, and `write` tools with compact, ADHD-friendly UI outputs. Collapsed by default (one-line summary), expandable on demand with detail (using the standard `app.tools.expand` keybinding / Ctrl+O).
3. **Working Indicator / Spinner**: Configures a clean clay-toned spinner on session start to match the theme.

## Architecture

- **Behavior Delegation**: Every re-registered tool forwards all execution logic to the original built-in implementations. No changes to actual tool execution.
- **Visual styling**: Avoids hardcoding any styling/colors, relying entirely on the active theme's token mappings via `theme.fg()` and `theme.bg()`.
- **Message Rendering**: Message stream rendering remains untouched for reliability.
