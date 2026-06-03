/**
 * Learning orchestrator — the glue between the cadence gate, the transcript reader, the incremental
 * index, and the updater subagent. Equivalent to Cursor's `continual-learning` skill body, but it
 * also pre-creates the AGENTS.md learned scaffold (so the updater only ever edits, never bootstraps).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	LEARNED_HEADINGS,
	NO_UPDATES_SENTINEL,
	type TranscriptIndex,
	type TranscriptStat,
	createInitialIndex,
	emptyLearnedSections,
	normalizeIndex,
	refreshIndex,
	renderLearnedDocument,
	selectDeltaTranscripts,
} from "./memory.ts";
import {
	type TranscriptFileStat,
	digestTranscript,
	listSessionTranscripts,
	renderDigest,
	sessionLocationForCwd,
} from "./transcript.ts";
import type { RunUpdaterResult, UpdaterAgentDef } from "./runner.ts";

export interface LearnPaths {
	agentsMd: string;
	stateFile: string;
	indexFile: string;
}

/** Resolve the on-disk paths the extension owns for a repo. */
export function resolveLearnPaths(cwd: string): LearnPaths {
	const stateDir = path.join(cwd, ".pi", "state");
	return {
		agentsMd: path.join(cwd, "AGENTS.md"),
		stateFile: path.join(stateDir, "continual-learning.json"),
		indexFile: path.join(stateDir, "continual-learning-index.json"),
	};
}

export function readJsonFile<T>(file: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
	} catch {
		return null;
	}
}

export function writeJsonFile(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export function loadIndex(indexFile: string): TranscriptIndex {
	const parsed = readJsonFile<unknown>(indexFile);
	return parsed ? normalizeIndex(parsed) : createInitialIndex();
}

/**
 * Ensure AGENTS.md exists with the learned headings so the updater only edits, never bootstraps.
 *
 * A missing heading is inserted in CANONICAL position (Corrections → Preferences → Facts), not just
 * appended — so e.g. adding Corrections to a doc that already had the older two sections still leads
 * with Corrections rather than burying it at the bottom. Hand-written content above the learned block
 * is preserved; new headings anchor just before the first existing learned heading that should follow
 * them, falling back to end-of-file when none do.
 */
export function ensureLearnedScaffold(agentsMd: string): void {
	if (!fs.existsSync(agentsMd)) {
		fs.mkdirSync(path.dirname(agentsMd), { recursive: true });
		fs.writeFileSync(agentsMd, renderLearnedDocument(emptyLearnedSections()), "utf-8");
		return;
	}

	let content = fs.readFileSync(agentsMd, "utf-8");
	if (LEARNED_HEADINGS.every(({ heading }) => content.includes(heading))) return;

	for (let i = 0; i < LEARNED_HEADINGS.length; i++) {
		const { heading } = LEARNED_HEADINGS[i];
		if (content.includes(heading)) continue;
		// Anchor before the nearest later learned heading already present, else append at end.
		const anchor = LEARNED_HEADINGS.slice(i + 1)
			.map(({ heading: h }) => content.indexOf(h))
			.filter((idx) => idx >= 0)
			.sort((a, b) => a - b)[0];
		const block = `${heading}\n\n`;
		if (anchor === undefined) {
			const sep = content.endsWith("\n") ? "\n" : "\n\n";
			content = `${content}${sep}${block}`;
		} else {
			content = `${content.slice(0, anchor)}${block}${content.slice(anchor)}`;
		}
	}
	fs.writeFileSync(agentsMd, content, "utf-8");
}

const MAX_TRANSCRIPTS_PER_RUN = 8;
const MAX_DIGEST_CHARS = 60_000;

export interface BuildTaskInput {
	deltas: TranscriptFileStat[];
	agentsMd: string;
	indexFile: string;
}

export interface BuiltUpdaterTask {
	task: string;
	included: TranscriptFileStat[];
}

/** Build the updater subagent task: AGENTS.md/index paths + the rendered transcript delta digest. */
export function buildUpdaterTask(input: BuildTaskInput): BuiltUpdaterTask {
	const digests: string[] = [];
	const included: TranscriptFileStat[] = [];
	let total = 0;
	for (const delta of input.deltas.slice(0, MAX_TRANSCRIPTS_PER_RUN)) {
		const rendered = renderDigest(digestTranscript(delta.path));
		if (included.length > 0 && total + rendered.length > MAX_DIGEST_CHARS) break;
		digests.push(rendered);
		included.push(delta);
		total += rendered.length;
	}
	const task = [
		"Run the continual-learning memory update for this workspace.",
		"",
		`AGENTS.md path: ${input.agentsMd}`,
		`Incremental index path (orchestrator refreshes after clean exit): ${input.indexFile}`,
		"",
		"Mine ONLY the high-signal, durable items from the NEW/CHANGED main-session transcript digest below:",
		"recurring user preferences/corrections and stable workspace facts. Update the three learned sections",
		"in AGENTS.md in place (dedupe, <=12 bullets/section). Plain bullets only — no evidence/metadata.",
		`If nothing durable is present, respond exactly: ${NO_UPDATES_SENTINEL}`,
		"",
		"=== TRANSCRIPT DELTA ===",
		digests.join("\n\n---\n\n") || "(no transcript content)",
	].join("\n");
	return { task, included };
}

export interface LearnRunOutcome {
	ran: boolean;
	ok: boolean;
	reason: string;
	stderr?: string;
	updaterText?: string;
	deltaCount: number;
}

export interface LearnRunDeps {
	cwd: string;
	agent: UpdaterAgentDef;
	now: number;
	signal?: AbortSignal;
	/** Injectable for tests; defaults to the real subprocess runner. */
	run?: (agent: UpdaterAgentDef, task: string, cwd: string, signal?: AbortSignal) => Promise<RunUpdaterResult>;
	/** Injectable for tests; defaults to scanning the agent dir's session store for this cwd. */
	listTranscripts?: (cwd: string) => TranscriptFileStat[];
	agentDir: string;
}

function updaterFailureReason(exitCode: number, stderr = ""): string {
	const tail = stderr.trim().slice(-1000);
	return tail ? `updater exited ${exitCode}: ${tail}` : `updater exited ${exitCode}`;
}

/**
 * Execute one learning pass: pick the transcript delta, pre-create the AGENTS.md scaffold, run the
 * updater subagent, then refresh the index only after a clean updater exit. The cadence decision is
 * made by the caller; this function assumes the gate already fired.
 */
export async function runLearningPass(deps: LearnRunDeps): Promise<LearnRunOutcome> {
	const paths = resolveLearnPaths(deps.cwd);
	const listTranscripts =
		deps.listTranscripts ?? ((cwd: string) => listSessionTranscripts(sessionLocationForCwd(deps.agentDir, cwd).dir));

	const allTranscripts = listTranscripts(deps.cwd);
	const index = loadIndex(paths.indexFile);
	const deltas = selectDeltaTranscripts(
		allTranscripts.map((t) => ({ path: t.path, mtimeMs: t.mtimeMs }) as TranscriptStat),
		index,
	);
	if (deltas.length === 0) {
		return { ran: false, ok: true, reason: "no transcript delta", deltaCount: 0 };
	}

	ensureLearnedScaffold(paths.agentsMd);

	const { task, included } = buildUpdaterTask({ deltas, agentsMd: paths.agentsMd, indexFile: paths.indexFile });
	// Lazy-load the real subprocess runner only when no injectable run is supplied. This keeps the
	// orchestration module free of the pi-package import on the test/inject path.
	const run = deps.run ?? (await import("./runner.ts")).runUpdater;
	let result: RunUpdaterResult;
	try {
		result = await run(deps.agent, task, deps.cwd, deps.signal);
	} catch (error) {
		const stderr = String(error);
		return { ran: true, ok: false, reason: `updater threw: ${stderr.slice(-1000)}`, stderr, deltaCount: included.length };
	}

	if (result.exitCode === 0) {
		const processed: TranscriptStat[] = included.map((d) => ({ path: d.path, mtimeMs: d.mtimeMs }));
		const existingPaths = allTranscripts.map((t) => t.path);
		writeJsonFile(paths.indexFile, refreshIndex(index, processed, existingPaths, deps.now));
	}

	const stderrText = result.stderr ?? "";
	const stderr = stderrText.trim() || undefined;
	return {
		ran: true,
		ok: result.exitCode === 0,
		reason: result.exitCode === 0 ? "updater completed" : updaterFailureReason(result.exitCode, stderrText),
		stderr,
		updaterText: result.text,
		deltaCount: included.length,
	};
}
