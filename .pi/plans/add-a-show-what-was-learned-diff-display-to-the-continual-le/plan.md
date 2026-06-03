# Plan: Add a "show what was learned" diff display to the continual-learning extension. Today, after a learning pass updates AGENTS.md, the only feedback is an ephemeral notify() that reports a transcript COUNT (e.g. "Continual learning: updated AGENTS.md from 3 transcript(s)."). The founder wants to actually SEE the bullets that were written/changed/removed, surfaced in the same transient zone above the editor, and it must AUTO-DISMISS (not persist for the rest of the session).

Context / mechanics (already investigated):
- AGENTS.md is NOT tracked by git in this repo, so there is no diff trail otherwise.
- The learned content lives in three sections parsed by extensions/continual-learning/memory.ts: "## Learned Corrections", "## Learned User Preferences", "## Learned Workspace Facts". memory.ts exports parseLearnedSections(markdown), LEARNED_HEADINGS, and LearnedSections.
- The pass runs in extensions/continual-learning/learn.ts runLearningPass(): it calls ensureLearnedScaffold(paths.agentsMd) then runs the updater subagent which edits AGENTS.md in place. To capture a before/after, read AGENTS.md text right BEFORE the updater runs (after ensureLearnedScaffold) and right AFTER a clean (exitCode 0) updater exit, and include both snapshots on the LearnRunOutcome (e.g. add optional fields like beforeMarkdown/afterMarkdown, or a precomputed diff). Keep the existing deltaCount/updaterText fields intact.
- The toast is fired from extensions/continual-learning/index.ts in the pi.on("agent_end") handler (and also the registerCommand("continual-learning") manual path). ctx.ui exposes setWidget(key, string[] | undefined, { placement }) — placement "aboveEditor" renders just above the editor (the transient zone where the founder saw the status line). Host caps widgets at 10 lines and clears them when called with undefined. ctx.ui also has notify() and setStatus(). The widget is the right surface because it renders multi-line and can be cleared programmatically; notify("info") writes a PERMANENT dim line into chat scrollback (wrong — does not auto-dismiss).
- Auto-dismiss requirement: after showing the diff widget, clear it with ctx.ui.setWidget(key, undefined) on a timer (e.g. ~30s) AND also clear it on the next agent_start (so it disappears the moment the founder sends another message / continues the chat). Use a stable widget key like "continual-learning-diff". Guard all ctx.ui calls with optional chaining (ctx.ui?.setWidget?.()) since RPC/print modes may not implement it.
- Color: theme exposes fg() with valid foreground tokens including "toolDiffAdded" (green), "toolDiffRemoved" (red), "dim", "accent". fg() THROWS on unknown tokens (like bg() does), so only use known tokens. Added bullets in green (toolDiffAdded), removed in red (toolDiffRemoved), changed shown as a red "- old" then green "+ new" pair, section sub-headings dim, title dim. The widget receives (tui, theme) when you pass a component factory, OR you can pass a pre-colored string[]; prefer building colored string[] lines via ctx.ui.theme.fg(...).

I have ALREADY WRITTEN a complete diff module that should be used as the basis — create extensions/continual-learning/diff.ts with this exact content:

---BEGIN diff.ts---
/**
 * Learned-section diff — turn a before/after AGENTS.md snapshot into the actual bullets that changed,
 * so a pass can SHOW what it wrote (not just a transcript count). AGENTS.md is not tracked by git here,
 * so this is the only audit trail of what continual learning learned.
 *
 * Node-free so it can be unit-tested headlessly. Pairing is best-effort: identical bullets cancel out,
 * and a removed/added pair that is clearly a reword of the same bullet is shown as a single "changed".
 */

import { LEARNED_HEADINGS, type LearnedSections, parseLearnedSections } from "./memory.ts";

export interface SectionDelta {
	heading: string;
	added: string[];
	removed: string[];
	/** Reworded bullets shown as before→after pairs (a removal + addition judged to be the same item). */
	changed: { from: string; to: string }[];
}

export interface LearnedDiff {
	sections: SectionDelta[];
	addedCount: number;
	removedCount: number;
	changedCount: number;
}

export function isEmptyDiff(diff: LearnedDiff): boolean {
	return diff.addedCount === 0 && diff.removedCount === 0 && diff.changedCount === 0;
}

/** Cheap word-overlap similarity in [0,1]; used to pair a removed bullet with its reworded replacement. */
function similarity(a: string, b: string): number {
	const tokens = (s: string) =>
		new Set(
			s
				.toLowerCase()
				.replace(/[^a-z0-9\s]/g, " ")
				.split(/\s+/)
				.filter((w) => w.length > 2),
		);
	const sa = tokens(a);
	const sb = tokens(b);
	if (sa.size === 0 || sb.size === 0) return 0;
	let shared = 0;
	for (const w of sa) if (sb.has(w)) shared++;
	return shared / Math.max(sa.size, sb.size);
}

const REWORD_THRESHOLD = 0.5;

/** Diff one section: drop common bullets, then greedily pair leftovers that look like rewordings. */
function diffSection(heading: string, before: string[], after: string[]): SectionDelta {
	const beforeRemaining = before.filter((b) => !after.includes(b));
	const addedRemaining = after.filter((a) => !before.includes(a));

	const changed: { from: string; to: string }[] = [];
	const removed: string[] = [];
	const usedAdds = new Set<number>();

	for (const from of beforeRemaining) {
		let bestIdx = -1;
		let bestScore = REWORD_THRESHOLD;
		for (let i = 0; i < addedRemaining.length; i++) {
			if (usedAdds.has(i)) continue;
			const score = similarity(from, addedRemaining[i]);
			if (score > bestScore) {
				bestScore = score;
				bestIdx = i;
			}
		}
		if (bestIdx >= 0) {
			usedAdds.add(bestIdx);
			changed.push({ from, to: addedRemaining[bestIdx] });
		} else {
			removed.push(from);
		}
	}
	const added = addedRemaining.filter((_, i) => !usedAdds.has(i));
	return { heading, added, removed, changed };
}

/** Compute the learned-section delta between two AGENTS.md snapshots. */
export function diffLearnedMarkdown(before: string, after: string): LearnedDiff {
	const beforeSections = parseLearnedSections(before);
	const afterSections = parseLearnedSections(after);
	return diffLearnedSections(beforeSections, afterSections);
}

export function diffLearnedSections(before: LearnedSections, after: LearnedSections): LearnedDiff {
	const sections: SectionDelta[] = [];
	let addedCount = 0;
	let removedCount = 0;
	let changedCount = 0;
	for (const { heading, key } of LEARNED_HEADINGS) {
		const delta = diffSection(heading, before[key], after[key]);
		if (delta.added.length || delta.removed.length || delta.changed.length) {
			sections.push(delta);
			addedCount += delta.added.length;
			removedCount += delta.removed.length;
			changedCount += delta.changed.length;
		}
	}
	return { sections, addedCount, removedCount, changedCount };
}

/** Short heading label without the leading "## Learned ". */
function shortHeading(heading: string): string {
	return heading.replace(/^#+\s*/, "").replace(/^Learned\s+/, "");
}

export interface DiffPalette {
	added: (s: string) => string;
	removed: (s: string) => string;
	heading: (s: string) => string;
	dim: (s: string) => string;
}

const PLAIN_PALETTE: DiffPalette = {
	added: (s) => s,
	removed: (s) => s,
	heading: (s) => s,
	dim: (s) => s,
};

/** Clip a bullet to a single line so the widget never blows past its row budget. */
function clip(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export interface RenderDiffOptions {
	palette?: DiffPalette;
	/** Max body rows (excludes the title line). The widget host caps total lines at 10. */
	maxLines?: number;
	/** Max characters per bullet before clipping. */
	width?: number;
}

/**
 * Render the diff as widget lines: a title, then per-section +added / -removed / ~changed bullets.
 * Truncates to a row budget with a "+N more" footer so a large pass never overflows the widget.
 */
export function renderDiffLines(diff: LearnedDiff, transcriptCount: number, options: RenderDiffOptions = {}): string[] {
	const palette = options.palette ?? PLAIN_PALETTE;
	const maxLines = options.maxLines ?? 8;
	const width = options.width ?? 100;

	const parts: string[] = [];
	const counts: string[] = [];
	if (diff.addedCount) counts.push(`+${diff.addedCount}`);
	if (diff.changedCount) counts.push(`~${diff.changedCount}`);
	if (diff.removedCount) counts.push(`-${diff.removedCount}`);
	const tail = transcriptCount ? ` from ${transcriptCount} transcript${transcriptCount === 1 ? "" : "s"}` : "";
	const title = palette.dim(`Continual learning: AGENTS.md updated (${counts.join(" ")})${tail}`);

	const body: string[] = [];
	let overflow = 0;
	const push = (line: string) => {
		if (body.length < maxLines) body.push(line);
		else overflow++;
	};

	for (const section of diff.sections) {
		push(palette.heading(shortHeading(section.heading)));
		for (const item of section.changed) {
			push(`  ${palette.removed(`- ${clip(item.from, width)}`)}`);
			push(`  ${palette.added(`+ ${clip(item.to, width)}`)}`);
		}
		for (const item of section.added) push(`  ${palette.added(`+ ${clip(item, width)}`)}`);
		for (const item of section.removed) push(`  ${palette.removed(`- ${clip(item, width)}`)}`);
	}
	if (overflow > 0) body[body.length - 1] = palette.dim(`  …+${overflow} more change${overflow === 1 ? "" : "s"}`);

	parts.push(title, ...body);
	return parts;
}
---END diff.ts---

Then wire it in:
1. learn.ts: in runLearningPass, capture the AGENTS.md text right after ensureLearnedScaffold (the "before") and, on exitCode 0, re-read AGENTS.md (the "after"). Add optional fields to LearnRunOutcome to carry the diff (compute via diffLearnedMarkdown(before, after) from diff.ts, store the LearnedDiff) — keep it best-effort (wrap reads in try/catch; never throw). Leave existing behavior (index refresh, reason, updaterText, deltaCount) unchanged.
2. index.ts: replace the plain notify() success line with a call that builds colored widget lines via renderDiffLines(outcome.diff, outcome.deltaCount, { palette: built from ctx.ui.theme.fg using toolDiffAdded/toolDiffRemoved/dim/accent }) and shows them with ctx.ui?.setWidget?.("continual-learning-diff", lines, { placement: "aboveEditor" }). If the diff is empty/unavailable, fall back to the existing notify() text so nothing regresses. Clear the widget with ctx.ui?.setWidget?.("continual-learning-diff", undefined) after ~30s (setTimeout, store the timer so a new pass resets it) AND register a pi.on("agent_start") that clears the widget + timer immediately (so it auto-dismisses when the founder continues the chat). Keep the warning/failed paths as notify("warning"). Apply the same widget display to the manual registerCommand("continual-learning") success path.
3. Keep extensions decoupled: diff.ts only imports from memory.ts (node-free), matching the existing module style. No new cross-extension imports.

Add a headless test extensions/continual-learning/test/diff_test.sh modeled on the existing test/learn_test.sh (bash + node --input-type=module, ROOT_DIR resolution, assert/strict). Cover: (a) diffLearnedMarkdown detects an added bullet, a removed bullet, and a reworded bullet surfaced as a single "changed" pair (not separate add+remove); (b) identical before/after yields isEmptyDiff true; (c) renderDiffLines produces a title with the right +/~/- counts and respects the maxLines budget with a "+N more" overflow footer. Make it executable (chmod +x) and ensure it prints a clear "diff_test: ALL PASS" line and exits non-zero on failure.

## Summary (planner)
Add an auto-dismissing 'what was learned' diff widget to the continual-learning extension: a new node-free diff.ts (exact provided content) computes added/removed/reworded learned bullets from before/after AGENTS.md snapshots; learn.ts captures those snapshots around the updater and attaches a LearnedDiff to LearnRunOutcome (best-effort, existing fields intact); index.ts replaces the success notify() with a colored setWidget('continual-learning-diff', lines, {placement:'aboveEditor'}) that clears on a ~30s timer and on the next agent_start, with notify() fallback when the diff is empty; a new headless diff_test.sh verifies the diff and renderer.

## Steps
1. Create extensions/continual-learning/diff.ts verbatim from the task (imports only memory.ts; exports diffLearnedMarkdown, diffLearnedSections, isEmptyDiff, renderDiffLines, types).
2. learn.ts/runLearningPass: after ensureLearnedScaffold read AGENTS.md as 'before' and on exitCode===0 re-read as 'after', each wrapped in try/catch (never throw); add optional diff?: LearnedDiff (and optionally beforeMarkdown/afterMarkdown) to LearnRunOutcome computed via diffLearnedMarkdown; keep deltaCount/updaterText/reason/index-refresh unchanged.
3. index.ts agent_end success path: build a DiffPalette from ctx.ui.theme.fg using toolDiffAdded/toolDiffRemoved/dim/accent, render with renderDiffLines(outcome.diff, outcome.deltaCount, {palette}); when diff present/non-empty call ctx.ui?.setWidget?.('continual-learning-diff', lines, {placement:'aboveEditor'}), else fall back to the existing notify('info'); keep warning/failed paths on notify('warning').
4. index.ts auto-dismiss: module-scoped timer handle; setTimeout(~30s) -> ctx.ui?.setWidget?.('continual-learning-diff', undefined), clearing/resetting any prior timer on a new pass; add pi.on('agent_start') that clears the widget and the timer immediately; guard every ctx.ui call with optional chaining.
5. index.ts manual registerCommand('continual-learning') success path: apply the same widget display + auto-dismiss as agent_end; preserve nothing-to-do / no-high-signal notify() messages.
6. Create executable extensions/continual-learning/test/diff_test.sh (bash + node --input-type=module, ROOT_DIR resolution, node:assert/strict) covering: added/removed bullets, a reworded bullet surfaced as one 'changed' pair (not add+remove), isEmptyDiff true on identical input, and renderDiffLines title +/~/- counts plus maxLines budget with '+N more' footer; print 'diff_test: ALL PASS'; chmod +x.
7. Run bash extensions/continual-learning/test/diff_test.sh and bash extensions/continual-learning/test/learn_test.sh and the smoke import to confirm green.

## Files likely
- `extensions/continual-learning/diff.ts`
- `extensions/continual-learning/learn.ts`
- `extensions/continual-learning/index.ts`
- `extensions/continual-learning/test/diff_test.sh`

## Risks
- setWidget/aboveEditor/placement and theme tokens toolDiffAdded/toolDiffRemoved are NOT present anywhere in the repo (the pi host @earendil-works/pi-coding-agent is external, no node_modules); their signatures are assumed from the task contract. Mitigate with ctx.ui?.setWidget?.() optional chaining so RPC/print modes degrade silently.
- fg() throws on unknown tokens (like bg()); the palette must use only dim/accent/toolDiffAdded/toolDiffRemoved, all guarded so a missing theme falls back to PLAIN_PALETTE/notify().
- Auto-dismiss correctness: the ~30s timer and agent_start handler must share one module-scoped handle so a new pass resets (not stacks) timers and agent_start clears both widget and timer; widget host caps at 10 lines (renderDiffLines maxLines default 8 + title stays within budget).
- diff.ts and diff_test.sh do not exist yet, so the legacy/controller fallback command cannot be verified end-to-end until created; only its learn_test.sh half is currently green (verified).
- Existing foreman.json 'verify' gate runs only foreman tests and does not exercise continual-learning; this task's verification relies on the new diff_test.sh + learn_test.sh + smoke import being run (controller fallback) rather than the standing gate.

## Requirements
- (none detected)

## Proposed gates
- verify (per-round command) — command: `grep -q "claude-opus-4-8:xhigh" extensions/foreman/crew/planner.md && bash extensions/foreman/test/planner_timeout_test.sh && bash extensions/foreman/test/planner_test.sh && bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/reviewer_test.sh && bash extensions/foreman/test/guard_test.sh && bash extensions/foreman/test/fallback_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/dashboard/test/reader_test.sh`
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
