# Plan: Create a new self-contained pi extension at extensions/statusline/ that replaces the pi footer via ctx.ui.setFooter(), per the harness conventions (jiti-loaded TS, no build step, installed by symlink via the existing install.sh glob over extensions/*/).

CONTEXT / WHY
- pi's footer is a live TUI component, NOT a Claude Code-style stdin script. Customize via ctx.ui.setFooter((tui, theme, footerData) => ({ render, invalidate, dispose? })).
- Reference pattern: /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/custom-footer.ts
- The default footer (dist/modes/interactive/components/footer.js) renders: (1) pwd+branch line, (2) stats line (tokens/cost/context% left, model right), (3) a line of extension statuses from footerData.getExtensionStatuses() sorted by key. setFooter() REPLACES ALL OF IT, so we MUST re-render the extension-statuses line ourselves or foreman's setStatus output disappears (regression).

FILES
1. extensions/statusline/package.json — { "name": "statusline", "version": "1.0.0", "private": true, "type": "module", "description": "...", "pi": { "extensions": ["index.ts"] } }. Mirror extensions/session-namer/package.json.
2. extensions/statusline/index.ts — default export function (pi: ExtensionAPI). On pi.on("session_start", (_event, ctx) => { ... }) call ctx.ui.setFooter(...). Sections:
   a) Context bar + %: ctx.getContextUsage() -> { tokens: number|null, contextWindow: number, percent: number|null }. Render a 12-cell bar "▰"*filled + "▱"*rest + " NN%". Color via theme.fg: percent>90 -> "error", >70 -> "warning", else "success". If percent==null, show "?" with no bar color. If contextWindow falsy, omit the section.
   b) Git branch: footerData.getGitBranch() (string|null, may be "detached"). Show "⎇ <branch>" when truthy. Subscribe unsub = footerData.onBranchChange(() => tui.requestRender()); return it as `dispose`.
   c) Cost/tokens: loop ctx.sessionManager.getBranch(); for entry.type === "message" && entry.message.role === "assistant" accumulate (m as AssistantMessage).usage.input, .output, .cost.total. Render "↑<in> ↓<out> $<cost>"; fmt = n<1000 ? `${n}` : `${(n/1000).toFixed(1)}k`; cost.toFixed(3).
   LAYOUT:
   - Line 1: left group = [context bar, "⎇ branch", cost/tokens] present-only, joined by "  "; wrap muted parts in theme.fg("dim", ...). right = theme.fg("dim", ctx.model?.id || "no-model"). pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right))). push truncateToWidth(left + pad + right, width).
   - Line 2+ (CRITICAL no-regression): const m = footerData.getExtensionStatuses(); if (m.size > 0) sort [...m.entries()] by key alphabetically, map to the status text, join by " ", push truncateToWidth(line, width, theme.fg("dim","…")). Preserve EXACTLY so foreman/continual-learning setStatus still appears.
   - invalidate() {} no-op; compute everything fresh each render so theme changes apply (no pre-baked themed strings cached).
   Imports: import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"; import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"; import type { AssistantMessage } from "@earendil-works/pi-ai";
   Add a top-of-file comment block documenting the FOREMAN INTEGRATION SEAM (see item 3).
3. extensions/statusline/README.md — document: what it renders; the "setFooter replaces the whole footer" caveat; the preserved extension-statuses seam; and a "Foreman integration (future)" section: a foreman "stage + agents-alive" section can be surfaced WITHOUT modifying this extension — foreman calls ctx.ui.setStatus("foreman", <text>) and it appears automatically via the preserved extension-statuses line. The rejected alternative (a dedicated inline section reading foreman state) would require a hard cross-extension dependency, which violates the harness rule "compose through substrate (session transcript → AGENTS.md), no hard cross-extension imports".

CONSTRAINTS
- No new deps. ESM, TS. Bare package imports for the three @earendil-works packages.
- Match harness style (tabs; see extensions/session-namer/index.ts).
- Do NOT edit install.sh. Single self-contained extension; no imports from other extensions.
- Field access defensive where cheap (getContextUsage may return undefined; usage fields may be missing).

VERIFY (module-eval): the verifyCommand loads index.ts through pi's bundled jiti with the SAME alias map pi's loader.js uses (so pi-tui/pi-ai value imports resolve without repo node_modules) and asserts default export is a function. Must print "STATUSLINE OK".

## Summary (planner)
Create a self-contained pi extension at extensions/statusline/ (package.json, index.ts, README.md) that calls ctx.ui.setFooter() on session_start to render a custom footer: a colored 12-cell context-usage bar, git branch, and cumulative cost/tokens on line 1 (model right-aligned), and—critically—re-renders the extension-statuses line (sorted by key, joined by space) so foreman/continual-learning setStatus output is preserved. jiti-loaded TS, no build step, auto-installed by install.sh's extensions/*/ glob (no install.sh edit). Acceptance is a module-eval that loads index.ts via pi's bundled jiti alias map and asserts default export is a function (prints STATUSLINE OK).

## Steps
1. Add extensions/statusline/package.json mirroring extensions/session-namer/package.json: { name: statusline, version 1.0.0, private, type module, description, pi.extensions: [index.ts] }.
2. Write extensions/statusline/index.ts: default export function(pi: ExtensionAPI) that on pi.on('session_start', (_event, ctx) => ctx.ui.setFooter((tui, theme, footerData) => ({ render, invalidate, dispose }))). Imports: type ExtensionAPI from @earendil-works/pi-coding-agent; value { truncateToWidth, visibleWidth } from @earendil-works/pi-tui; type AssistantMessage from @earendil-works/pi-ai. Use tabs.
3. render(width): build line 1 left group from present-only sections joined by two spaces: (a) context bar from ctx.getContextUsage() — 12-cell '▰'*filled+'▱'*rest+' NN%', color via theme.fg success/warning/error by percent>70/>90, '?' with no bar color when percent==null, omit section when contextWindow falsy or getContextUsage() undefined; (b) '⎇ <branch>' from footerData.getGitBranch() when truthy; (c) '↑in ↓out $cost' summed over ctx.sessionManager.getBranch() assistant messages (fmt k-suffix, cost.toFixed(3)), defensive on missing usage fields. Wrap muted parts in theme.fg('dim',...). right = theme.fg('dim', ctx.model?.id || 'no-model'); pad = ' '.repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right))); push truncateToWidth(left+pad+right, width).
4. render line 2+ (no-regression): const m = footerData.getExtensionStatuses(); if (m.size>0) push truncateToWidth([...m.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,t])=>t).join(' '), width, theme.fg('dim','…')). invalidate(){} no-op; compute everything fresh each render (no cached themed strings). dispose = footerData.onBranchChange(()=>tui.requestRender()).
5. Add a top-of-file comment block documenting the FOREMAN INTEGRATION SEAM (foreman surfaces stage+agents-alive via ctx.ui.setStatus('foreman', text), appearing automatically through the preserved extension-statuses line; no cross-extension import).
6. Write extensions/statusline/README.md: what it renders; the 'setFooter replaces the whole footer' caveat; the preserved extension-statuses seam; and a 'Foreman integration (future)' section explaining the setStatus seam and why a dedicated inline section reading foreman state is rejected (hard cross-extension dependency violates compose-through-substrate).
7. Verify: run the module-eval that loads ./extensions/statusline/index.ts through pi's bundled jiti with the loader's alias map and asserts default is a function, expecting STATUSLINE OK (alias harness already proven green against the reference custom-footer.ts).
8. Sanity: confirm no new deps added and no other extension is imported; rely on install.sh's existing extensions/*/ glob (do not edit install.sh).

## Files likely
- `extensions/statusline/package.json (new)`
- `extensions/statusline/index.ts (new)`
- `extensions/statusline/README.md (new)`

## Risks
- setFooter REPLACES the entire default footer; failing to re-render the extension-statuses line would silently drop foreman/continual-learning setStatus output (regression). Mitigation: replicate footer.js:204-212 (sort by localeCompare, join ' ', truncateToWidth with dim ellipsis).
- Default footer applies sanitizeStatusText to each status before joining; the spec maps raw status text + join ' ' (no sanitize), a minor fidelity gap vs default rendering — intentional per task spec.
- Theme switching: if themed strings were cached, color wouldn't update; spec requires computing fresh per render with invalidate() no-op — must be followed.
- Defensive access required: ctx.getContextUsage() may return undefined and AssistantMessage.usage subfields may be missing; omit/zero-default rather than throw inside render.
- Module-eval verify depends on pi being installed and resolvable via `command -v pi` (PKG derived from readlink); jiti is bundled under pi's node_modules (confirmed). Alias map must match pi's loader (confirmed loader.js:36-39/76-79) and was proven to resolve value imports against the reference example.
- The foreman `verify` gate runs the foreman test suite, not statusline; the statusline acceptance is the module-eval STATUSLINE OK command, kept out of proposedGates to avoid overwriting the shared .pi/foreman.json (per instructions).
- Assumption: pi fires session_start with (event, ctx) where ctx.ui.setFooter is available in interactive mode (matches example + types.d.ts:809); in non-interactive/print mode setFooter is a no-op, which is acceptable.

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
