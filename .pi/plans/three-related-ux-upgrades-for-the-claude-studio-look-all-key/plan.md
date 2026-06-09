# Plan: THREE related UX upgrades for the "Claude Studio" look, all keyboard-first (pi has NO mouse — confirmed engine never enables mouse tracking; any arrow glyph is a visual indicator, expansion is via the app.tools.expand keybinding / Ctrl+O). Make it beautiful, structured, ADHD-friendly (group related info, scan-by-color).

=== DELIVERABLE 1: POWERLINE STATUSLINE (modify extensions/statusline/index.ts) ===
Replace ONLY the visual assembly in render() with a grouped, adaptive powerline. KEEP everything else identical: the git background poll (execFile 2.5s, refreshing guard), footerData.onBranchChange subscription, dispose() clearing interval+unsub, ctx.getContextUsage(), cost/token summation over ctx.sessionManager.getBranch() assistant messages, session name via ctx.sessionManager.getSessionName(), model+thinking via ctx.model + pi.getThinkingLevel(), AND the preserved extension-statuses line (footerData.getExtensionStatuses(), sorted by key, sanitized) as the LAST line(s) — that foreman seam must stay.

POWERLINE RENDERING (no new deps — build truecolor ANSI inline):
- Add helpers at top of the factory or module:
    const hexToRgb = (h) => { const n=parseInt(h.slice(1),16); return [n>>16&255, n>>8&255, n&255]; };
    const FG = (h) => { const [r,g,b]=hexToRgb(h); return `\x1b[38;2;${r};${g};${b}m`; };
    const BG = (h) => { const [r,g,b]=hexToRgb(h); return `\x1b[48;2;${r};${g};${b}m`; };
    const RST = "\x1b[0m";
- Claude-aligned segment palette (hardcode as named consts; comment: matches claude-warm-dark theme):
    CLAY="#d97757", DARK="#1a1815", SEL="#2a2620", TOOL="#211e19", OKBG="#1e231a",
    CREAM="#e8e6e3", SLATE="#87867f", DIM="#5e5d59", SAGE="#9bab7a", GOLD="#d9a866", CORAL="#d97066"
- A segment helper: seg(bgHex, fgHex, text) => `${BG(bgHex)}${FG(fgHex)} ${text} `; and an arrow between bg A and bg B = `${BG(bHex)}${FG(aHex)}\ue0b0`; line END cap = `${RST}${FG(lastBgHex)}\ue0b0${RST}`. Use the Nerd Font glyph "\ue0b0" () for the right-pointing separator.
- GLYPH FALLBACK: read const ASCII = process.env.PI_STATUSLINE_ASCII === "1". When ASCII, do NOT emit \ue0b0 arrows; instead render each segment as `${BG}${FG} text ${RST}` separated by a single space, no arrow glyphs (still colored bg blocks). Document this env toggle in README.

GROUPED 3-LINE LAYOUT (each line is its own powerline strip, left-anchored, ending with a cap arrow to default bg):
- LINE 1 (identity): clay segment — `✎ <session name>` (DARK text on CLAY bg). If no name, fall back to `π pi`. This line is the bold anchor.
- LINE 2 (location group: git + path): SEL-bg segment(s) — `⎇ <branch>` (CREAM) + git indicators `(<unstaged>, +<staged>, <ahead>↑, <behind>↓)` (GOLD) when present; then a TOOL-bg segment `📁 <cwd>` (SLATE), home shortened to ~.
- LINE 3 (stats group: model + context + tokens + cost): segments in this order —
    `🤖 <modelId> • <thinking>` (CLAY text on a slightly different warm bg e.g. "#3a2a1f"),
    `<12-cell ▰▱ bar> <NN%>` (SAGE/GOLD/CORAL by >70/>90 thresholds, on OKBG),
    `↑<in> ↓<out>` (SLATE on SEL),
    `$<cost>` (GOLD on SEL).
  Keep the existing k-formatter and cost.toFixed(3).
- LAST LINE(S): preserved extension-statuses (unchanged behavior).

ADAPTIVE (use the real `width` arg; compute with visibleWidth from @earendil-works/pi-tui which strips ANSI):
- width >= 90: full 3-line layout above, full cwd.
- 60 <= width < 90: same 3 lines but shorten cwd to `~/…/<lastdir>` and drop the 🤖/📁 emoji (keep text); if a line still exceeds width, truncateToWidth it.
- width < 60: collapse to 2 plain lines (NO glyphs/bg, ASCII style regardless of env): line1 = `✎ <name> · ⎇ <branch>`, line2 = `<NN%> · <modelId> <thinking>`; then ext-statuses. This guarantees no overflow on narrow terminals.
- ALWAYS finish every line with truncateToWidth(line, width) as a safety net so no line ever exceeds width.
- invalidate(){} no-op; compute fresh each render.

=== DELIVERABLE 2: FOREMAN TOOL COLLAPSE (modify extensions/foreman/index.ts) ===
The foreman tool currently returns `{ content:[{type:"text", text: transcript.join("\n") }] }` (see done() ~line 1652) with NO renderResult, so its output renders as a wall of text. Add a `renderResult` to the foreman tool's registerTool (the one with name:"foreman" ~line 1523) so it is COLLAPSED by default with a one-line summary + an indicator arrow, and shows the full transcript only when expanded.
- import { Text } from "@earendil-works/pi-tui" and keyHint from "@earendil-works/pi-coding-agent" if not already imported (check existing imports; foreman already imports from pi-coding-agent).
- renderResult(result, { expanded, isPartial }, theme, _ctx):
    * isPartial → return new Text(theme.fg("warning", "▾ Foreman running…"), 0, 0).
    * Get full text = result?.content?.[0]?.type === "text" ? result.content[0].text : "". Split into lines.
    * Derive a STAGE SUMMARY from the text (first match wins): 
        contains "GATE 1 / PLAN" → "GATE 1 · plan ready — approve or revise"
        contains "GATE 2 / SHIP" → "GATE 2 · ready to ship — approve or revise"
        contains "SHIPPED"        → "✓ shipped"
        contains "Task halted"     → "■ halted"
        contains "awaiting_decision" or "escalat" → "? awaiting your decision"
        else → the FIRST non-empty line, truncated to ~80 chars.
    * COLLAPSED (expanded false): return new Text(`${theme.fg("accent","▸")} ${theme.fg("toolTitle","Foreman")} ${theme.fg("muted","· "+summary)} ${theme.fg("dim","("+keyHint("app.tools.expand","expand")+")")}`, 0, 0).
    * EXPANDED (expanded true): header line `${theme.fg("accent","▾")} ${theme.fg("toolTitle","Foreman")}` then the FULL transcript text below it (dim for non-marker lines is optional; simplest: append "\n"+full text). Return a single Text with "\n" joins.
    * Defensive: wrap in try/catch returning a short Text on error. Never throw.
  IMPORTANT: do NOT change what execute() returns (the text content the LLM/controller relies on stays intact) — only add the renderResult display layer. Do not touch any other foreman logic.

=== DELIVERABLE 3: SPINNER MESSAGE (modify extensions/claude-studio/index.ts) ===
The extension already sets clay-toned dots via setWorkingIndicator. The word next to it is still pi's default "Working...". On session_start, ALSO call pi.ui.setWorkingMessage("cooking") (lowercase, calm, on-brand) so the streaming indicator reads as the clay dots + "cooking" instead of "Working...". Keep it a single fixed word (no rotation). Guard: only call if typeof pi.ui?.setWorkingMessage === "function".

=== DOCS ===
- Update extensions/statusline/README.md: describe the new grouped 3-line adaptive powerline (line1 identity, line2 git+path, line3 model+context+tokens+cost), the PI_STATUSLINE_ASCII=1 env toggle for no-Nerd-Font fallback, that segment colors are Claude-warm by design, and that the extension-statuses (foreman) line is still preserved. Keep the Performance/git-polling + Foreman-integration sections.
- Update extensions/claude-studio/README.md: note the spinner now shows clay dots + "cooking", and that foreman tool output is now collapsed-by-default with Ctrl+O (app.tools.expand) to see the full transcript (cross-reference: implemented in foreman extension).

=== CONSTRAINTS ===
- No new npm deps (truecolor ANSI built inline; node:child_process already used). ESM, tabs, harness style. Self-contained per extension; only @earendil-works/* + node builtins.
- Do NOT change tool/foreman BEHAVIOR — only display (renderResult) and the spinner message.
- Every render path defensive; never throw; always truncateToWidth so no line exceeds width.

=== VERIFY ===
verifyCommand: theme loads via pi's real loader + the three modified modules load via pi's jiti alias map (statusline, claude-studio default exports are functions; foreman default export is a function — importing only DEFINES, does not run). Prints "STUDIO PRO OK".

## Summary (planner)
Foreman Gate 1 plan for three keyboard-first 'Claude Studio' UX upgrades (all display-only, no behavior change): (1) replace ONLY the visual assembly in statusline render() with a grouped 3-line adaptive truecolor powerline (inline ANSI, no new deps) while keeping every data source, the git poll, dispose, and the preserved ext-statuses seam identical, plus a PI_STATUSLINE_ASCII=1 glyph fallback and a plain <60-width collapse; (2) add a defensive renderResult to the foreman tool so its transcript is collapsed-by-default with a derived stage summary + Ctrl+O (app.tools.expand) to expand, without touching execute()/done() return; (3) add a guarded pi.ui.setWorkingMessage('cooking') on session_start in claude-studio. Update both READMEs. Verified the loader smoke command prints 'STUDIO PRO OK'.

## Steps
1. statusline/index.ts: add hexToRgb/FG/BG/RST helpers + Claude-warm palette consts (CLAY/DARK/SEL/TOOL/OKBG/CREAM/SLATE/DIM/SAGE/GOLD/CORAL + the #3a2a1f model bg) and seg()/arrow/end-cap helpers at top of factory/module; read const ASCII = process.env.PI_STATUSLINE_ASCII === '1'.
2. statusline/index.ts: rewrite ONLY the visual assembly inside render() into 3 left-anchored powerline strips — line1 identity (✎ name on CLAY, fallback 'π pi'); line2 location (⎇ branch + GOLD git indicators on SEL, 📁 cwd on TOOL, home→~); line3 stats (🤖 model • thinking on #3a2a1f, 12-cell ▰▱ bar + NN% SAGE/GOLD/CORAL by >70/>90 on OKBG, ↑in ↓out on SEL, $cost.toFixed(3) on SEL) — reusing existing name/branch/git/cwd/contextUsage/token-sum/cost/model/thinking values and the existing fmt() formatter unchanged.
3. statusline/index.ts: implement adaptivity via the real width arg using visibleWidth — >=90 full+full cwd; 60..89 same 3 lines but cwd→~/…/<lastdir> and drop 🤖/📁 emoji (keep text); <60 collapse to 2 plain ASCII lines (no glyphs/bg) 'line1=✎ name · ⎇ branch', 'line2=NN% · model thinking'; in ASCII mode emit colored bg blocks separated by single space with no \ue0b0 arrows; ALWAYS wrap every pushed line in truncateToWidth(line,width); keep invalidate(){} no-op.
4. statusline/index.ts: keep the ext-statuses block (getExtensionStatuses sorted by key, sanitized, truncateToWidth) as the LAST line(s), behavior unchanged; keep refreshGit/execFile/2.5s interval/refreshing guard, onBranchChange unsub, dispose, getContextUsage, getBranch summation, getSessionName, ctx.model+getThinkingLevel all identical.
5. foreman/index.ts: extend the pi-tui/pi-coding-agent imports to add { Text } from '@earendil-works/pi-tui' and keyHint from '@earendil-works/pi-coding-agent' (only if not already present).
6. foreman/index.ts: add renderResult(result,{expanded,isPartial},theme,_ctx) to the name:'foreman' registerTool (~1523): isPartial→'▾ Foreman running…'; else read result.content[0].text, derive first-match stage summary (GATE 1 / PLAN→'GATE 1 · plan ready — approve or revise', GATE 2 / SHIP→'GATE 2 · ready to ship — approve or revise', SHIPPED→'✓ shipped', 'Task halted'→'■ halted', awaiting_decision|escalat→'? awaiting your decision', else first non-empty line truncated ~80); collapsed=one-line ▸ Foreman · summary (Ctrl+O hint via keyHint('app.tools.expand','expand')); expanded=▾ header + full transcript joined by \n; wrap whole thing in try/catch returning a short Text; never throw; do NOT change execute()/done() return at ~1700.
7. claude-studio/index.ts: in the session_start handler add a guarded call — if (typeof pi.ui?.setWorkingMessage === 'function') pi.ui.setWorkingMessage('cooking') — keeping the existing clay-dot setWorkingIndicator; single fixed lowercase word, no rotation.
8. extensions/statusline/README.md: document the new grouped 3-line adaptive powerline (line1 identity, line2 git+path, line3 model+context+tokens+cost), the PI_STATUSLINE_ASCII=1 no-Nerd-Font toggle, that segment colors are Claude-warm by design, and that the foreman/ext-statuses line is still preserved; keep the Performance/git-polling and Foreman-integration sections.
9. extensions/claude-studio/README.md: note the spinner now shows clay dots + 'cooking', and that foreman tool output is collapsed-by-default with Ctrl+O (app.tools.expand) to view the full transcript (cross-reference: implemented in the foreman extension).
10. Verify: re-run the jiti loader smoke check (theme.loadThemeFromPath + import statusline/claude-studio/foreman default exports as functions) and confirm it prints 'STUDIO PRO OK'; importing only DEFINES the modules, never runs them.

## Files likely
- `extensions/statusline/index.ts`
- `extensions/foreman/index.ts`
- `extensions/claude-studio/index.ts`
- `extensions/statusline/README.md`
- `extensions/claude-studio/README.md`

## Risks
- Adaptive math depends on visibleWidth/truncateToWidth stripping truecolor ESC[38;2;r;g;bm + ESC[48;2;...m + Nerd Font \ue0b0 sequences; these are standard CSI/glyphs so should be handled, but the per-line truncateToWidth(line,width) safety net is the guarantee against overflow.
- Wide glyphs (emoji 📁/🤖, powerline \ue0b0) can be miscounted by cell-width heuristics; mitigated by always truncating each line and by the <60 plain/ASCII collapse and PI_STATUSLINE_ASCII=1 toggle for non-Nerd-Font terminals.
- Must change ONLY the visual assembly in render() — accidental edits to refreshGit/dispose/getBranch summation/ext-statuses would be a regression; keep all data sources and the foreman seam byte-for-byte behavioral.
- foreman renderResult must be display-only: execute() and done() (~1700) return text the controller/LLM relies on and must stay intact; renderResult must be fully try/catch wrapped and never throw.
- Adding imports to foreman/index.ts must not break module load or the existing 'verify' gate (foreman's own test suite, which this task does not modify); the STUDIO PRO OK loader smoke check plus that gate cover load-time regressions.
- Exact semantics of the width arg (full terminal vs footer-available) is assumed to match the current statusline usage; the truncate-per-line net makes an off-by-some-cells assumption safe.
- No new npm deps permitted: truecolor ANSI is built inline; only @earendil-works/* and node builtins (node:child_process already used) — confirmed.

## Requirements
- (none detected)

## Proposed gates
- verify (per-round command) — command: `grep -q "claude-opus-4-8:xhigh" extensions/foreman/crew/planner.md && bash extensions/foreman/test/planner_timeout_test.sh && bash extensions/foreman/test/planner_test.sh && bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/scorer_test.sh && bash extensions/foreman/test/approvalfriction_test.sh && bash extensions/foreman/test/teampacket_test.sh && bash extensions/foreman/test/reviewer_test.sh && bash extensions/foreman/test/docer_test.sh && bash extensions/foreman/test/guard_test.sh && bash extensions/foreman/test/fallback_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/dashboard/test/reader_test.sh`
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
