# Plan: Build the "Claude Studio" look for pi — a warm-dark theme + compact-but-expandable tool/message/spinner renderers, all sharing ONE palette so everything is tonally consistent. This is the user's chosen package (they like Claude's "bright but not harsh" warm-dark feel; they have ADHD → want minimal-by-default, detail-on-demand).

Three deliverables, all in this repo, jiti-loaded TS / JSON, installed by the existing install.sh globs.

=== DELIVERABLE 1: THEME (config) ===
Create config/themes/claude-warm-dark.json — a full 51-token pi theme. Use EXACTLY this content (already validated: 51 tokens present, all vars resolve, JSON valid):

{
	"$schema": "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
	"name": "claude-warm-dark",
	"vars": {
		"bg": "#1a1815", "clay": "#d97757", "clayDeep": "#c15f3c", "cream": "#e8e6e3",
		"sage": "#9bab7a", "coral": "#d97066", "gold": "#d9a866",
		"slateLight": "#87867f", "slate": "#5e5d59", "slateDim": "#403e39",
		"surfaceSel": "#2a2620", "surfaceUser": "#232019", "surfaceTool": "#211e19",
		"surfaceOk": "#1e231a", "surfaceErr": "#2a1c1a", "surfaceMsg": "#241f18"
	},
	"colors": {
		"accent": "clay", "border": "slateDim", "borderAccent": "clay", "borderMuted": "slateDim",
		"success": "sage", "error": "coral", "warning": "gold", "muted": "slateLight", "dim": "slate",
		"text": "cream", "thinkingText": "slateLight",
		"selectedBg": "surfaceSel", "userMessageBg": "surfaceUser", "userMessageText": "cream",
		"customMessageBg": "surfaceMsg", "customMessageText": "cream", "customMessageLabel": "clay",
		"toolPendingBg": "surfaceTool", "toolSuccessBg": "surfaceOk", "toolErrorBg": "surfaceErr",
		"toolTitle": "cream", "toolOutput": "slateLight",
		"mdHeading": "gold", "mdLink": "clay", "mdLinkUrl": "slate", "mdCode": "sage",
		"mdCodeBlock": "cream", "mdCodeBlockBorder": "slateDim", "mdQuote": "slateLight",
		"mdQuoteBorder": "slateDim", "mdHr": "slateDim", "mdListBullet": "clay",
		"toolDiffAdded": "sage", "toolDiffRemoved": "coral", "toolDiffContext": "slate",
		"syntaxComment": "slate", "syntaxKeyword": "clay", "syntaxFunction": "gold",
		"syntaxVariable": "cream", "syntaxString": "sage", "syntaxNumber": "#cba98a",
		"syntaxType": "gold", "syntaxOperator": "slateLight", "syntaxPunctuation": "slateLight",
		"thinkingOff": "slateDim", "thinkingMinimal": "slate", "thinkingLow": "#9c8f7f",
		"thinkingMedium": "gold", "thinkingHigh": "clay", "thinkingXhigh": "clayDeep",
		"bashMode": "sage"
	},
	"export": { "pageBg": "#141312", "cardBg": "#1f1d19", "infoBg": "#2a2218" }
}

ALSO: update install.sh so themes get symlinked into ~/.pi/agent/themes/. Mirror the existing per-file symlink pattern used for crew agents (the loop that does `for agent in "$crew"*.md; link ... "$AGENT_DIR/agents/..."`). Add an analogous block: ensure `mkdir -p "$AGENT_DIR/themes"`, then for each `extensions/*/themes/*.json` AND for `config/themes/*.json`, symlink into `$AGENT_DIR/themes/`. (Theme lives in config/themes/, parallel to the existing config/models.json which install.sh already symlinks.) Keep idempotent via the existing link() helper. Do not break any existing install.sh behavior.
ALSO: set the theme active by adding "theme": "claude-warm-dark" to the settings.json writer block at the bottom of install.sh (the python3 heredoc that already sets defaultProvider/defaultModel/defaultThinkingLevel) — add data["theme"] = "claude-warm-dark" there so a fresh install selects it. Keep the other defaults.

=== DELIVERABLE 2: TOOL RENDERERS (extension) — the ADHD core ===
Create extensions/claude-studio/ (package.json mirroring session-namer + index.ts). This extension re-registers the built-in tools (read, bash, edit, write) with COMPACT renderers that delegate execute() to the originals — behavior unchanged, only display. This is the BLESSED pattern; copy the structure from the official example at:
  /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/built-in-tool-renderer.ts
Key requirements:
- import { createReadTool, createBashTool, createEditTool, createWriteTool, keyHint } from "@earendil-works/pi-coding-agent"; import { Text } from "@earendil-works/pi-tui"; types ReadToolDetails/BashToolDetails/EditToolDetails as needed.
- const cwd = process.cwd(); create originals once; each re-registered tool delegates execute() to the original.
- COLLAPSED (default, expanded=false): exactly ONE line per tool, no noise:
    * read  → `read <path>` + result `<n> lines` (success color). 
    * bash  → `$ <cmd truncated 80>` + result `done` (success) or `exit <code>` (error) + ` (<n> lines)` dim.
    * edit  → `edit <path>` + result `+<adds>` (success) ` / ` dim `-<rem>` (error). Count adds/rem from details.diff lines (skip +++/---). Use renderShell:"self" for edit (matches example).
    * write → `write <path>` + result `wrote <n> lines` or `created`.
  When NOT expanded and there is more to see, append a hint: ` (${keyHint("app.tools.expand","expand")})` in dim — so the user always knows detail is one key away.
- EXPANDED (expanded=true): show detail on demand:
    * read → first ~15 lines dim, then `... N more lines` muted.
    * bash → first ~20 output lines dim, then `... more output`.
    * edit → diff lines (cap ~40) colored: added→toolDiffAdded/success, removed→toolDiffRemoved/error, context→dim; then `... N more diff lines`.
    * write → file path + size.
- Handle isPartial in renderResult: "Reading…/Running…/Editing…/Writing…" in warning color.
- Use theme.fg(...) tokens ONLY (accent, success, error, warning, dim, muted, toolTitle, toolDiffAdded/Removed/Context) so it auto-matches the Claude theme. Text padding (0,0) (default Box handles the rest). Defensive: every details/content access optional-chained; renderResult never throws (fall back to a short Text).

=== DELIVERABLE 3: MESSAGE + SPINNER (same extension, index.ts) ===
- SPINNER: on session_start, set a clay-toned working indicator:
    ctx.ui.setWorkingIndicator({ frames: [theme.fg("dim","·"), theme.fg("muted","•"), theme.fg("accent","●"), theme.fg("muted","•")], intervalMs: 120 });
  Get theme via ctx.ui.theme. (This is cosmetic; keep it simple.)
- MESSAGE: DO NOT override user/assistant rendering this round (registerMessageRenderer is for CUSTOM message types, not the core user/assistant stream — overriding those is riskier and not needed for the look). Skip it. (If you think core message styling is cleanly supported, leave a // NOTE comment pointing to where it WOULD go, but do not implement.)

=== DOCS ===
- extensions/claude-studio/README.md: what the package is (warm-dark Claude look), the three pieces (theme/config + tool renderers/ext + spinner/ext), the ADHD principle (collapsed by default, Ctrl+O / app.tools.expand to expand), that tool BEHAVIOR is unchanged (execute delegates to originals; only display changes), and how it composes with the existing statusline extension (separate, both just read theme tokens). Note the theme is selected via settings.json "theme":"claude-warm-dark" or /settings.

=== CONSTRAINTS ===
- No new deps. ESM, tabs, harness style (see extensions/session-namer). Self-contained; no imports from other extensions (only from @earendil-works/* packages).
- Do not touch the statusline extension. Do not change tool behavior.
- install.sh edits must stay backward-compatible and idempotent.

=== VERIFY ===
The verifyCommand: (1) validates the theme JSON loads through pi's REAL loader (loadThemeFromPath) and renders a token; (2) loads the claude-studio extension via pi's jiti alias map and asserts default export is a function. Prints "CLAUDE STUDIO OK" on success, or FAIL+message and non-zero exit.

## Summary (planner)
Build the 'Claude Studio' warm-dark look for pi as three jiti-loaded deliverables, all sharing one 51-token palette. (1) config/themes/claude-warm-dark.json (exact provided content) + install.sh changes to symlink themes into ~/.pi/agent/themes and set it as the fresh-install default. (2) A new extensions/claude-studio extension (mirroring session-namer) that re-registers read/bash/edit/write with compact-collapsed/expand-on-demand renderers, delegating execute() to the originals so behavior is unchanged. (3) A clay-toned working-indicator spinner on session_start (message renderer intentionally skipped, NOTE only). Plus a README. Recon confirms all pi exports, types, UI APIs, the install.sh patterns, and the verify harness mechanics. .pi/foreman.json already exists, so existing gates are reflected and not overwritten; the task-specific 'CLAUDE STUDIO OK' verify command is the deliverable's acceptance test (mechanics verified) but is not yet a stored repo command.

## Steps
1. Create config/themes/claude-warm-dark.json with the EXACT provided JSON (51 tokens, $schema, vars, colors, export). Do not alter token values.
2. Edit install.sh: after the crew/skills symlink blocks, add an idempotent themes block — mkdir -p "$AGENT_DIR/themes"; loop over extensions/*/themes/*.json AND config/themes/*.json, guarding non-matches with the existing `[ -f "$f" ] || continue` pattern, and symlink each via the existing link() helper into "$AGENT_DIR/themes/$(basename ...)". Keep all existing behavior intact.
3. Edit the python3 settings.json heredoc at the bottom of install.sh: add data["theme"] = "claude-warm-dark" alongside the existing defaultProvider/defaultModel/defaultThinkingLevel keys so fresh installs select the theme.
4. Create extensions/claude-studio/package.json mirroring session-namer (private, type:module, pi.extensions:["index.ts"], descriptive name/version).
5. Create extensions/claude-studio/index.ts: import createReadTool/createBashTool/createEditTool/createWriteTool + keyHint from @earendil-works/pi-coding-agent, Text from @earendil-works/pi-tui, and types ReadToolDetails/BashToolDetails/EditToolDetails; const cwd=process.cwd(); build originals once; re-register each tool delegating execute() to its original; implement COLLAPSED one-line renderers (read→'read <path>'/'<n> lines'; bash→'$ <cmd≤80>'/'done'|'exit <code>'+dim lines; edit→'edit <path>'/'+adds' dim ' / ' '-rem' with renderShell:'self'; write→'write <path>'/'wrote <n> lines'|'created') with a dim ` (${keyHint('app.tools.expand','expand')})` hint when collapsed-with-more; EXPANDED detail (read ~15 lines, bash ~20 lines, edit ~40 diff lines colored via toolDiffAdded/Removed/Context, write path+size); handle isPartial ('Reading…/Running…/Editing…/Writing…' in warning); use only theme.fg(...) tokens; Text padding (0,0); defensive optional-chaining so renderResult never throws.
6. In the same index.ts, on session_start set ctx.ui.setWorkingIndicator({ frames:[theme.fg('dim','·'),theme.fg('muted','•'),theme.fg('accent','●'),theme.fg('muted','•')], intervalMs:120 }) using theme from ctx.ui.theme. Do NOT implement registerMessageRenderer for core user/assistant — leave a // NOTE comment indicating where custom-message rendering would go.
7. Create extensions/claude-studio/README.md describing the warm-dark Claude look, the three pieces (theme/config + tool renderers + spinner), the ADHD principle (collapsed by default, Ctrl+O / app.tools.expand to expand), that tool BEHAVIOR is unchanged (execute delegates to originals), how it composes with the separate statusline extension (both just read theme tokens), and that the theme is selected via settings.json "theme":"claude-warm-dark" or /settings.
8. Run the task verify command and confirm it prints 'CLAUDE STUDIO OK' (validates theme loads through loadThemeFromPath and renders a token, and that the claude-studio default export is a function).

## Files likely
- `config/themes/claude-warm-dark.json (new)`
- `install.sh (edit: add idempotent themes symlink block + data["theme"]="claude-warm-dark" in settings.json heredoc)`
- `extensions/claude-studio/package.json (new)`
- `extensions/claude-studio/index.ts (new)`
- `extensions/claude-studio/README.md (new)`

## Risks
- .pi/foreman.json already exists; per instructions existing gates are reflected and NOT overwritten. The task's 'CLAUDE STUDIO OK' verify command had its harness mechanics verified working, but it references files not yet created and is not a stored repo command, so it is deliberately excluded from proposedGates.
- WriteToolDetails is NOT exported by the package; only import ReadToolDetails/BashToolDetails/EditToolDetails. The write renderer must derive line count from args.content / result content (matches the reference example), not from details.
- install.sh idempotency/backward-compat: the new themes loop must reuse the existing link() helper, mkdir -p the themes dir, and guard empty globs with the existing `[ -f ] || continue` style so an absent config/themes or extensions/*/themes never aborts the script (set -euo pipefail is active).
- registerMessageRenderer exists but is for CUSTOM message types only; overriding core user/assistant stream is out of scope — implement spinner only and leave a NOTE comment, per the task.
- The verify harness uses `readlink -f` (GNU-style); it executed successfully on this macOS host during recon, but remains a portability consideration if run on a stock BSD readlink.
- Theme $schema points at a remote GitHub raw URL; loadThemeFromPath validates locally and does not fetch it — confirmed the theme loads and th.fg('accent','x') works.
- No root package.json/tsconfig/build step exists; the extension is jiti-loaded TS at runtime, so there is no compile gate — correctness rests on the runtime verify command and the reviewer judge.

## Requirements
- (none detected)

## Proposed gates
- verify (per-round command) — command: `grep -q "claude-opus-4-8:xhigh" extensions/foreman/crew/planner.md && bash extensions/foreman/test/planner_timeout_test.sh && bash extensions/foreman/test/planner_test.sh && bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/scorer_test.sh && bash extensions/foreman/test/reviewer_test.sh && bash extensions/foreman/test/docer_test.sh && bash extensions/foreman/test/guard_test.sh && bash extensions/foreman/test/fallback_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/dashboard/test/reader_test.sh`
- review (pre-ship judge) — agent: reviewer
- commit (release action) — action: `commit`

## Proposed manifest
- Existing .pi/foreman.json is present and will be preserved.

## Execution
- Working directory: /Users/a1241968/Desktop/Oscar/my-pi-harness
- Track: frontend (ui-developer; auto-fallback to Opus xhigh on tool failure)
- UI developer: cliproxy/gemini-3.5-flash-low:high implements; controller-owned gates remain ground truth.
- Tester: cliproxy/claude-opus-4-8:high judges intent and catches cheats.
- Up to 3 fix rounds, then escalate.
