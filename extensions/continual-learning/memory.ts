/**
 * Incremental transcript index + AGENTS.md section contract.
 *
 * Port of Cursor's `continual-learning-index.json` plus the `agents-memory-updater` output rules.
 * Kept node-free where practical so the section parser/merger can be unit-tested headlessly. The
 * updater subagent owns the *semantic* extraction; this module owns the deterministic mechanics:
 * which transcripts are new/changed, and how the two learned sections are parsed back out.
 */

// Corrections lead the document on purpose: they are the highest-priority, action-shaping guidance
// (do/don't rules distilled from mistakes), so the agent reads them first each session.
export const CORRECTIONS_HEADING = "## Learned Corrections";
export const PREFERENCES_HEADING = "## Learned User Preferences";
export const FACTS_HEADING = "## Learned Workspace Facts";
export const MAX_BULLETS_PER_SECTION = 12;
export const NO_UPDATES_SENTINEL = "No high-signal memory updates.";

/** Ordered learned headings -> the LearnedSections key they populate. Order = document order. */
export const LEARNED_HEADINGS: ReadonlyArray<{ heading: string; key: keyof LearnedSections }> = [
	{ heading: CORRECTIONS_HEADING, key: "corrections" },
	{ heading: PREFERENCES_HEADING, key: "preferences" },
	{ heading: FACTS_HEADING, key: "facts" },
];

export interface TranscriptIndexEntry {
	mtimeMs: number;
	processedAtMs: number;
}

export interface TranscriptIndex {
	version: 1;
	entries: Record<string, TranscriptIndexEntry>;
}

export interface TranscriptStat {
	/** Absolute path used as the index key. */
	path: string;
	mtimeMs: number;
}

export function createInitialIndex(): TranscriptIndex {
	return { version: 1, entries: {} };
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function normalizeIndex(parsed: unknown): TranscriptIndex {
	if (!parsed || typeof parsed !== "object") return createInitialIndex();
	const record = parsed as Record<string, unknown>;
	if (record.version !== 1 || typeof record.entries !== "object" || record.entries === null) return createInitialIndex();
	const entries: Record<string, TranscriptIndexEntry> = {};
	for (const [key, value] of Object.entries(record.entries as Record<string, unknown>)) {
		if (!value || typeof value !== "object") continue;
		const entry = value as Record<string, unknown>;
		if (!isFiniteNumber(entry.mtimeMs)) continue;
		entries[key] = { mtimeMs: entry.mtimeMs, processedAtMs: isFiniteNumber(entry.processedAtMs) ? entry.processedAtMs : 0 };
	}
	return { version: 1, entries };
}

/**
 * Select transcripts that are new (not in the index) or changed (mtime advanced). This is the delta
 * the updater should mine — the whole point of "incremental" learning.
 */
export function selectDeltaTranscripts(stats: TranscriptStat[], index: TranscriptIndex): TranscriptStat[] {
	return stats.filter((stat) => {
		const known = index.entries[stat.path];
		return !known || stat.mtimeMs > known.mtimeMs;
	});
}

/**
 * Refresh the index for the transcripts the updater just processed and drop entries for transcripts
 * that no longer exist on disk (Cursor: "remove entries for deleted transcripts").
 */
export function refreshIndex(index: TranscriptIndex, processed: TranscriptStat[], existingPaths: string[], now: number): TranscriptIndex {
	const existing = new Set(existingPaths);
	const entries: Record<string, TranscriptIndexEntry> = {};
	for (const [key, value] of Object.entries(index.entries)) {
		if (existing.has(key)) entries[key] = value;
	}
	for (const stat of processed) {
		entries[stat.path] = { mtimeMs: stat.mtimeMs, processedAtMs: now };
	}
	return { version: 1, entries };
}

export interface LearnedSections {
	/** Do/don't rules distilled from mistakes and corrections — the self-heal core. */
	corrections: string[];
	preferences: string[];
	/** Stable workspace truths, including verified procedures/playbooks. */
	facts: string[];
}

export function emptyLearnedSections(): LearnedSections {
	return { corrections: [], preferences: [], facts: [] };
}

function stripBullet(line: string): string {
	return line.replace(/^[-*]\s+/, "").trim();
}

const HEADING_BY_TEXT = new Map(LEARNED_HEADINGS.map(({ heading, key }) => [heading, key]));

/**
 * Parse the learned sections out of an AGENTS.md body. Tolerant of other headings/content around
 * them (the file is shared with hand-written context). Only `- ` / `* ` bullets directly under a
 * learned heading are captured; nested or non-bullet lines end the section scan.
 */
export function parseLearnedSections(markdown: string): LearnedSections {
	const lines = markdown.split(/\r?\n/);
	const result = emptyLearnedSections();
	let active: keyof LearnedSections | null = null;
	for (const raw of lines) {
		const line = raw.trimEnd();
		const heading = line.trim();
		const matchedKey = HEADING_BY_TEXT.get(heading);
		if (matchedKey) {
			active = matchedKey;
			continue;
		}
		if (/^#{1,6}\s/.test(heading)) {
			active = null;
			continue;
		}
		if (!active) continue;
		if (/^[-*]\s+/.test(line.trimStart()) && !/^\s/.test(raw)) {
			const bullet = stripBullet(line.trim());
			if (bullet) result[active].push(bullet);
		} else if (heading.length > 0) {
			// Non-bullet, non-blank content ends the learned section.
			active = null;
		}
	}
	return result;
}

function renderSection(heading: string, bullets: string[]): string {
	const capped = bullets.slice(0, MAX_BULLETS_PER_SECTION);
	const body = capped.length ? capped.map((b) => `- ${b}`).join("\n") : "";
	return body ? `${heading}\n${body}` : heading;
}

/**
 * Render a fresh AGENTS.md containing only the learned sections, in document order. Used when no
 * AGENTS.md exists yet (Cursor: "If it does not exist, create it with only the headings").
 */
export function renderLearnedDocument(sections: LearnedSections): string {
	return `${LEARNED_HEADINGS.map(({ heading, key }) => renderSection(heading, sections[key])).join("\n\n")}\n`;
}
