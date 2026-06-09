# Plan: MODIFY the existing extension at extensions/statusline/ (index.ts + README.md) to add a session-name section, a thinking-level indicator, working-dir, and git dirty/ahead/behind — WITHOUT regressing the current 3 sections (context bar, branch, cost/tokens) or the preserved extension-statuses line. The file already exists and works; edit it, don't rewrite from scratch.

CURRENT STATE (already shipped, working):
- extensions/statusline/index.ts default-exports function(pi: ExtensionAPI); on "session_start" calls ctx.ui.setFooter((tui, theme, footerData) => ({ dispose, invalidate, render })).
- render() builds Line 1 = left group [context bar, "⎇ branch", "↑in ↓out $cost"] joined by two spaces, right = dim model id, right-aligned via pad + truncateToWidth. Line 2+ = preserved extension statuses (sorted by key, sanitized, dim ellipsis). dispose() unsubscribes footerData.onBranchChange.
- Has a top-of-file FOREMAN INTEGRATION SEAM comment + sanitizeStatusText() + fmt() helpers. Keep all of that.

ADD THESE (all defensive; this is a TUI footer so every value may be missing):

1) SESSION NAME — left, with icon, FIRST in the left group.
   - const name = ctx.sessionManager?.getSessionName?.(); (string | undefined)
   - When truthy, prepend to leftParts: theme.fg("accent", `✎ ${name}`). Use "accent" so the name stands out as a label (the rest of the left group is dim). When unset, render nothing (no placeholder).

2) THINKING LEVEL — right side, next to model, mirroring pi's default footer exactly.
   - The footer factory only receives ctx, but getThinkingLevel() is on `pi` (the default-export arg). Capture pi in the closure: the setFooter call already runs inside the session_start handler which is inside the default export, so `pi` is in scope — use pi.getThinkingLevel().
   - Build right side: const modelId = ctx.model?.id || "no-model"; if (ctx.model?.reasoning) { const lvl = pi.getThinkingLevel() || "off"; rightText = lvl === "off" ? `${modelId} • thinking off` : `${modelId} • ${lvl}`; } else rightText = modelId; then right = theme.fg("dim", rightText). (Replaces the current plain model-id right side.)

3) WORKING DIR — left group, AFTER branch, BEFORE cost/tokens.
   - const home = process.env.HOME || process.env.USERPROFILE || ""; let cwd = ctx.sessionManager?.getCwd?.() || ctx.cwd || ""; if (home && cwd.startsWith(home)) cwd = "~" + cwd.slice(home.length);
   - When cwd truthy, push theme.fg("dim", cwd) into leftParts (after branch).

4) GIT DIRTY / AHEAD / BEHIND — extend the branch section to "⎇ main (3, +1, 2↑ 1↓)".
   - CRITICAL: render() MUST stay synchronous. DO NOT spawn git inside render(). Instead run a background poll that caches results and calls tui.requestRender() when they change. Mirror pi's own footer-data-provider.js (uses child_process + a timer); we use a simple interval.
   - Implementation:
     * import { execFile } from "node:child_process"; (node builtin, allowed — no new dep).
     * Keep module-level/closure cache: let git = { unstaged: 0, staged: 0, ahead: 0, behind: 0 }; and a `let refreshing = false;` guard.
     * gitCwd = ctx.sessionManager?.getCwd?.() || ctx.cwd || process.cwd().
     * refreshGit(): if refreshing return; refreshing = true; run two git commands via execFile with { cwd: gitCwd, timeout: 1500 }:
       - `git --no-optional-locks status --porcelain=v1` → parse stdout lines: staged = count lines where line[0] is not " " and not "?"; unstaged = count lines where line[1] is not " " (this includes "?" untracked and M/D/etc).
       - `git --no-optional-locks rev-list --left-right --count HEAD...@{upstream}` → stdout "<ahead>\t<behind>"; on non-zero exit / error (e.g. no upstream) set ahead=behind=0.
       Use nested callbacks or Promise.all of two promisified execFile calls; on completion set refreshing=false, and if any of the 4 numbers changed vs previous cache, update cache and call tui.requestRender(). Swallow all errors (set zeros, never throw).
     * Start polling inside the setFooter factory: call refreshGit() once immediately, then const gitTimer = setInterval(refreshGit, 2500);. Also call refreshGit() inside the existing onBranchChange callback (branch switch changes ahead/behind/dirty), in addition to the existing tui.requestRender().
     * dispose(): clearInterval(gitTimer) AND the existing onBranchChange unsubscribe. (Both must be cleaned up.)
   - Render the branch section: when branch truthy, build `⎇ ${branch}` (dim), then indicators = []: if git.unstaged>0 push `${git.unstaged}`; if git.staged>0 push `+${git.staged}`; if git.ahead>0 push `${git.ahead}↑`; if git.behind>0 push `${git.behind}↓`; if indicators.length, append " " + theme.fg("warning", `(${indicators.join(", ")})`). The "⎇ branch" part stays theme.fg("dim", ...); only the indicator group is warning-colored.

LEFT GROUP FINAL ORDER (present-only, joined by "  "):
  [✎ session-name (accent)] [context bar (themed)] [⎇ branch (+indicators)] [cwd (dim)] [↑in ↓out $cost (dim)]
Right side: model (+ thinking level) dim, right-aligned. Keep the existing pad/truncateToWidth logic so the line never exceeds width. Line 2+ extension-statuses: UNCHANGED.

DOCS:
- Update extensions/statusline/README.md "Overview" to list the new sections (session name, working dir, git dirty/ahead/behind, thinking level).
- Add a short "## Performance: git polling" section explaining render() is synchronous and called every frame, so git runs in a 2.5s background poll (execFile) that caches counts and calls tui.requestRender() on change — never in render — mirroring pi's footer-data-provider. Note dispose() clears the interval.
- Keep the existing "Foreman integration (future)" section.

CONSTRAINTS:
- No new npm deps (node:child_process is a builtin and is fine).
- Keep ESM, tabs, harness style. Keep the 3 existing sections + extension-statuses preservation behavior identical.
- All new field access defensive (optional chaining / try-catch around git). render() must never throw.

VERIFY (module-eval, unchanged approach): loads index.ts via pi's bundled jiti with pi's loader alias map and asserts default export is a function. Must print "STATUSLINE OK". The module-eval does NOT invoke the extension, so no git spawns during verify.

## Summary (planner)
Modify extensions/statusline/index.ts (and README.md) to add four new footer sections — session name (accent, first in left group), thinking-level indicator (right, next to model, gated on ctx.model.reasoning), working-dir (~-shortened, after branch), and git dirty/ahead/behind indicators (warning-colored, appended to the branch section) — without regressing the existing context-bar/branch/cost sections or the preserved extension-statuses line. Git data is fetched in a 2.5s background execFile poll that caches counts and calls tui.requestRender() on change; render() stays synchronous and never spawns. All new field access is defensive (optional chaining / try-catch). Verified: all required pi API methods exist in dist, jiti is present, and the module-eval verify already prints STATUSLINE OK against the current file.

## Steps
1. Add `import { execFile } from "node:child_process";` near the existing imports (builtin, no new dep). Keep all existing imports/helpers (sanitizeStatusText, fmt, FOREMAN INTEGRATION SEAM comment) intact.
2. Inside the setFooter factory, add a closure-level git cache `let git = { unstaged:0, staged:0, ahead:0, behind:0 }`, a `let refreshing = false` guard, and `const gitCwd = ctx.sessionManager?.getCwd?.() || ctx.cwd || process.cwd()`.
3. Implement refreshGit(): if refreshing return; set refreshing=true; run two execFile git calls with { cwd: gitCwd, timeout: 1500 } — `git --no-optional-locks status --porcelain=v1` (staged = lines where line[0] not ' ' and not '?'; unstaged = lines where line[1] not ' '), and `git --no-optional-locks rev-list --left-right --count HEAD...@{upstream}` (parse '<ahead>\t<behind>'; on error/no-upstream set 0). On completion set refreshing=false and, only if any of the 4 numbers changed, update cache and call tui.requestRender(). Swallow all errors (zeros, never throw).
4. Start the poll inside the factory: call refreshGit() once immediately, then `const gitTimer = setInterval(refreshGit, 2500)`. Also call refreshGit() inside the existing onBranchChange callback (in addition to the existing tui.requestRender()).
5. Update dispose() to clearInterval(gitTimer) AND keep the existing onBranchChange unsub cleanup.
6. In render(): add session name — `const name = ctx.sessionManager?.getSessionName?.()`; when truthy, unshift/prepend theme.fg("accent", `\u270e ${name}`) so it is FIRST in leftParts.
7. In render(): extend the branch section — keep theme.fg("dim", `\u2387 ${branch}`); build indicators[] (unstaged as `${n}`, staged as `+${n}`, ahead as `${n}\u2191`, behind as `${n}\u2193`, push only when >0); if indicators.length append ' ' + theme.fg("warning", `(${indicators.join(", ")})`).
8. In render(): add working-dir after branch — resolve home from process.env.HOME || process.env.USERPROFILE || ''; cwd from ctx.sessionManager?.getCwd?.() || ctx.cwd || ''; if home && cwd.startsWith(home) replace prefix with '~'; when truthy push theme.fg("dim", cwd) AFTER branch and BEFORE cost.
9. In render(): replace the plain right side with thinking-level — `const modelId = ctx.model?.id || "no-model"`; if (ctx.model?.reasoning) { const lvl = pi.getThinkingLevel() || "off"; rightText = lvl === "off" ? `${modelId} \u2022 thinking off` : `${modelId} \u2022 ${lvl}`; } else rightText = modelId; then right = theme.fg("dim", rightText). Keep the existing pad + truncateToWidth right-alignment.
10. Confirm final left group order present-only joined by two spaces: [session-name][context bar][branch(+indicators)][cwd][cost]; confirm Line 2+ extension-statuses block is byte-for-byte unchanged.
11. Update README.md: extend Overview to list session name, working dir, git dirty/ahead/behind, and thinking level; add a '## Performance: git polling' section explaining render() is synchronous/per-frame so git runs in a 2.5s background execFile poll that caches counts and calls tui.requestRender() on change (never in render), mirroring pi's footer-data-provider, and that dispose() clears the interval; keep the existing Foreman integration (future) section.
12. Run the statusline module-eval verify (jiti load + assert default export is a function) and confirm it prints STATUSLINE OK; the module-eval does not invoke the extension so no git spawns during verify.

## Files likely
- `extensions/statusline/index.ts`
- `extensions/statusline/README.md`

## Risks
- render() must never throw and must stay synchronous: a regression here would break the whole footer. Mitigation: all new reads use optional chaining, git only reads cached numbers, and execFile errors are swallowed to zeros.
- dispose() leak: forgetting clearInterval(gitTimer) leaves a 2.5s timer running after the footer is torn down. Both gitTimer and the onBranchChange unsub must be cleaned up.
- No-regression on the 3 existing sections + Line 2+ extension-statuses preservation: keep that block identical and only insert new leftParts in the specified order.
- thinking-level depends on capturing `pi` (the default-export arg) in the closure since the footer factory only receives ctx; if pi is referenced incorrectly it throws — gated behind ctx.model?.reasoning and pi.getThinkingLevel() with an 'off' fallback.
- The resolved per-round 'verify' gate runs the foreman test suite (planner/gates/reviewer/etc.), which does NOT exercise statusline; the task's real acceptance check is the statusline module-eval that prints STATUSLINE OK (verified passing against the current file). These are separate verifications.
- git porcelain parsing edge cases (renamed/untracked entries): spec counts staged via line[0] (not ' '/'?') and unstaged via line[1] (not ' '); follow it exactly. No upstream → rev-list non-zero exit → ahead/behind 0.
- No repo-root package.json found (each extension has its own); harness style is ESM + tabs — preserve tabs and ESM exactly.

## Requirements
- (none detected)

## Proposed gates
- verify (per-round command) — command: `grep -q "claude-opus-4-8:xhigh" extensions/foreman/crew/planner.md && bash extensions/foreman/test/planner_timeout_test.sh && bash extensions/foreman/test/planner_test.sh && bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/reviewer_test.sh && bash extensions/foreman/test/docer_test.sh && bash extensions/foreman/test/guard_test.sh && bash extensions/foreman/test/fallback_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/dashboard/test/reader_test.sh`
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
