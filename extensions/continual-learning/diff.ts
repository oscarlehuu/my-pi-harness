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
