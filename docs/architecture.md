# Architecture Decisions

## How pi loads

- The live agent dir defaults to `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides it completely.
- pi reads fixed names under the agent dir: `extensions/`, `agents/`, `skills/`, `prompts/`,
  `themes/`, `models.json`, `AGENTS.md`, `auth.json`, and `sessions/`.
- Extensions are loaded from the flat `extensions/` layout. A domain with a top-level `index.ts` is
  loaded directly; a domain that ships multiple tools uses `package.json` with a `pi.extensions`
  manifest.
- Project scope can add/override resources from `<cwd>/.pi/{extensions,agents,...}` on top of the
  machine-wide agent dir.

## Install/link model

`~/.pi/agent` is the machine-wide live pi directory. This repo is the versioned source organized by
domain, so `install.sh` symlinks source folders onto the flat names pi expects:

- `extensions/<domain>` -> `~/.pi/agent/extensions/<domain>` for every loadable domain.
- `extensions/foreman/AGENTS.md` -> `~/.pi/agent/AGENTS.md` for the CTO persona.
- `extensions/foreman/crew` -> `~/.pi/agent/agents` for planner/developer/tester/reviewer/scout roles.
- `extensions/foreman/docs` -> `~/.pi/agent/foreman/charter` so crew running in any repo can read the
  portable Foreman framework charter at `foreman/charter/CHARTER.md`.
- `config/models.json` -> `~/.pi/agent/models.json` for shared model routing.
- `extensions/*/themes/*.json` AND `config/themes/*.json` -> `~/.pi/agent/themes/<name>.json`, one
  per-file symlink each (same idempotent `link()` helper as crew/skills). `themes/` is a real dir
  (`mkdir -p`, drop any prior whole-dir symlink) so multiple sources can coexist. The shipped
  `claude-warm-dark` theme lives in `config/themes/`, parallel to `config/models.json`.

Machine-local `auth.json`, `settings.json`, and `sessions/` remain real files under `~/.pi/agent`.
The `settings.json` writer heredoc at the bottom of `install.sh` sets `defaultProvider`,
`defaultModel`, `defaultThinkingLevel`, and `theme` (`"claude-warm-dark"`) so a fresh install selects
the Claude Studio look; users can override via `/settings`. NEVER hardcode colors in extensions —
renderers read the active theme's tokens at render time, so changing `theme` reskins everything.
Normal use does **not** set `PI_CODING_AGENT_DIR`; run `pi` from any project after `./install.sh`.
Foreman's out-of-tree ledger mirror also lives under `~/.pi/agent/foreman/ledger-mirror/`.

## Workspace domains

Each domain is a self-contained folder under `extensions/` and registers one or more tools:

- `foreman` — gated planning/dev/test/review/ship orchestration, crew prompts, dashboard, ledger, and
  the framework charter.
- `statusline` — replaces the default pi footer via `ctx.ui.setFooter()` with a grouped, Claude-warm
  **powerline** footer rendered as three left-anchored truecolor (24-bit ANSI) strips: Line 1 = identity
  anchor (`✎ <session name>` on clay, falling back to `π pi`); Line 2 = location group (`⎇ <branch>` + git
  indicators when present, then `📁 <cwd>` with `$HOME` shortened to `~`); Line 3 = stats group (model +
  thinking, a 12-cell context bar colored sage/gold/coral at >70/>90 thresholds, `↑in ↓out` tokens, and
  `$cost`). Adaptive on the real `width` (measured with `visibleWidth`): ≥90 full layout; 60–89 shortens
  cwd and drops the 🤖/📁 emoji; <60 collapses to 2 plain ASCII lines. `PI_STATUSLINE_ASCII=1` disables the
  Nerd Font separator glyph (`\ue0b0`) for non-Nerd-Font terminals. Every line is passed through
  `truncateToWidth(line, width)` so no line ever exceeds the terminal width. Segment colors are hardcoded
  named constants chosen to match the `claude-warm-dark` theme (this is the deliberate exception to the
  no-hardcoded-colors rule — these are powerline-block backgrounds, not theme tokens). Preserves other
  extensions' status outputs as the LAST line(s) (no hard cross-extension import) by re-rendering
  `footerData.getExtensionStatuses()` — the Foreman seam. Git counts run in a 2.5s background `execFile`
  poll (never inside the synchronous `render()`); see `extensions/statusline/README.md`.
- `subagent` — spawn primitive for isolated pi subprocess agents.
- `AskUserQuestion` — structured interactive ask-the-user prompt primitive used for gate relays.
- `grok` — web/X search plus Grok Imagine image/video tools through the subscription proxy.
- `codex` — ChatGPT/Codex OAuth image generation and edit tools.
- `antigravity` — Antigravity/Gemini flash-image generation and edit tools through cli-proxy-api.
- `claude-studio` — warm-dark "Claude Studio" look: re-registers the built-in `read`/`bash`/`edit`/
  `write` tools with compact, expandable renderers and sets a clay-toned working indicator. Tool
  BEHAVIOR is unchanged — each re-registered tool delegates `execute()` to the original created via
  `createReadTool`/`createBashTool`/`createEditTool`/`createWriteTool` (built once at `cwd`); only
  display changes. Pairs with the `claude-warm-dark` theme; see `extensions/claude-studio/README.md`.

Domains compose at runtime once installed; keep additions domain-scoped and primitive-oriented.

### Claude Studio renderers (ADHD: minimal-by-default, detail-on-demand)

In `extensions/claude-studio/index.ts` the `renderResult(result, { expanded, isPartial }, theme)`
handlers follow one contract per tool:

- Collapsed (`expanded=false`): exactly one summary line — `read`→`<n> lines`, `bash`→`done`/`exit
  <code>` + `(<n> lines)`, `edit`→`+<adds> / -<rem>`, `write`→`wrote <n> lines`. When more detail
  exists, append a dim ` (${keyHint("app.tools.expand","expand")})` hint (Ctrl+O).
- Expanded (`expanded=true`): `read` first ~15 lines, `bash` first ~20 output lines, `edit` diff
  capped ~40 lines colored via `toolDiffAdded`/`toolDiffRemoved`/`toolDiffContext`, `write` path+size;
  each followed by a `... N more` muted line.
- `isPartial=true`: a single warning-colored `Reading…/Running…/Editing…/Writing…` line.

State transition per result: `isPartial → collapsed → expanded` (toggled by `app.tools.expand`).
Invariants / NEVER-do: `renderResult` NEVER throws (wrapped in try/catch returning a short fallback
`Text`); all `result?.details`/`content?.[0]` access is optional-chained; renderers use only
`theme.fg(...)` tokens (no literal colors). The spinner is set on extension load and re-set on
`session_start` via `ctx.ui.setWorkingIndicator`; on `session_start` the extension ALSO calls
`pi.ui.setWorkingMessage("cooking")` (guarded by `typeof pi.ui?.setWorkingMessage === "function"`) so
the streaming indicator reads as the clay dots + the lowercase on-brand word `cooking` instead of pi's
default `Working...` (a single fixed word, no rotation). Core user/assistant message stream rendering is
intentionally NOT overridden (a `// NOTE` in `index.ts` marks where it would go).

The matching collapse-by-default display for the `foreman` orchestrator tool lives in the `foreman`
extension (a `renderResult` on the `foreman` tool, display-only — see below and
`extensions/foreman/docs/INTERNALS.md`), not in claude-studio, to avoid a cross-extension import.

## Live Foreman pipeline

Foreman is documented as a portable framework in `extensions/foreman/docs/CHARTER.md`. The current
loop is:

`brainstorm → plan → [GATE 1] → implement → per-round command gates → tester → pre-ship gates/reviewer → (fix↺) → [GATE 2] → ship + release actions`

Key live pieces:

- `planner` drafts the Gate 1 plan read-only; a valid planner plan may propose `.pi/foreman.json`,
  written only after Gate 1 approval and never over an existing manifest.
- Tracks route implementation to `developer` for backend/logic or `ui-developer` for frontend/UI;
  the frontend track falls back to Opus xhigh on Gemini tool failure.
- `.pi/foreman.json` declares generic gates of kind `command|judge|action` and stage
  `per-round|pre-ship|release`. Without a manifest, a supplied `verifyCommand` remains the legacy
  single per-round command gate.
- Per-round command gates run before tester judgment each round. Pre-ship command gates and reviewer
  judge gates run after a successful round before Gate 2. Release action gates run after strict DoD;
  the supported action is `commit`.
- Gate 2 uses the strict Definition of Done before marking done or allowing release commit. The DoD
  checklist is rendered to the founder, recorded in the ledger, and included in the auto-commit body
  when a commit gate is configured.

## Ledger

The task ledger lives in each target repo at `<repo>/.pi/plans/<slug>/` and is intended to be
committed with the work. It records `state.json`, `plan.md`, persisted planner JSON, handoffs,
`log.jsonl`, and machine-local transcripts/activity. Foreman also mirrors the committable ledger
files out of tree under the agent dir so a task can resume after the in-repo ledger is wiped by
`git clean`, reset, or a crashed tree rebuild.
