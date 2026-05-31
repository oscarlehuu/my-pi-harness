/**
 * Ledger — on-disk task state for the loop workflow.
 * Lives in the TARGET repo at <repo>/.pi/plans/<task-slug>/ (committed to git).
 * Resume = read state.json + handoffs/ (cursor-based).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type SuccessState = "success" | "partial" | "blocked" | "fail";

export interface LedgerState {
	task: string;
	slug: string;
	state: "planning" | "in_progress" | "done" | "escalated";
	workingDirectory: string;
	round: number;
	maxRounds: number;
	lastReviewedHandoffCount: number;
	gate1Approved: boolean;
	gate2Approved: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface Handoff {
	timestamp: string;
	role: "developer" | "tester";
	round: number;
	sessionId: string;
	successState?: SuccessState;
	summary: string;
	verification?: { commandsRun: Array<{ command: string; exitCode: number; observation: string }> };
	discoveredIssues?: Array<{ severity: string; description: string; suggestedFix: string }>;
	filesChanged?: string[];
	howToVerify?: string;
	raw: string; // always captured, even if structured parse failed
}

function nowIso(): string {
	return new Date().toISOString();
}

export function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60) || "task";
}

export function plansRoot(workingDir: string): string {
	return path.join(workingDir, ".pi", "plans");
}

export function taskDir(workingDir: string, slug: string): string {
	return path.join(plansRoot(workingDir), slug);
}

/** Ensure .pi/.gitignore exists so only .pi/plans/ is committed. */
function ensureGitignore(workingDir: string): void {
	const piDir = path.join(workingDir, ".pi");
	fs.mkdirSync(piDir, { recursive: true });
	const giPath = path.join(piDir, ".gitignore");
	if (!fs.existsSync(giPath)) {
		fs.writeFileSync(
			giPath,
			[
				"# Only the ledger travels with the code; everything else in .pi is machine-local.",
				"*",
				"!.gitignore",
				"!plans/",
				"plans/*/transcripts/",
				"plans/*/**/*.log",
				"",
			].join("\n"),
		);
	}
}

function atomicWriteJson(p: string, data: unknown): void {
	const tmp = `${p}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
	fs.renameSync(tmp, p);
}

export function initLedger(workingDir: string, task: string, maxRounds: number): LedgerState {
	ensureGitignore(workingDir);
	const slug = slugify(task);
	const dir = taskDir(workingDir, slug);
	fs.mkdirSync(path.join(dir, "handoffs"), { recursive: true });

	const statePath = path.join(dir, "state.json");
	if (fs.existsSync(statePath)) {
		return readState(workingDir, slug);
	}
	const state: LedgerState = {
		task,
		slug,
		state: "in_progress",
		workingDirectory: workingDir,
		round: 0,
		maxRounds,
		lastReviewedHandoffCount: 0,
		gate1Approved: false,
		gate2Approved: false,
		createdAt: nowIso(),
		updatedAt: nowIso(),
	};
	atomicWriteJson(statePath, state);
	fs.writeFileSync(path.join(dir, "plan.md"), `# ${task}\n\n(plan)\n`);
	appendLog(workingDir, slug, { type: "task_started", task });
	return state;
}

export function readState(workingDir: string, slug: string): LedgerState {
	return JSON.parse(fs.readFileSync(path.join(taskDir(workingDir, slug), "state.json"), "utf-8"));
}

export function writeState(workingDir: string, state: LedgerState): void {
	state.updatedAt = nowIso();
	atomicWriteJson(path.join(taskDir(workingDir, state.slug), "state.json"), state);
}

export function appendLog(workingDir: string, slug: string, entry: Record<string, unknown>): void {
	const p = path.join(taskDir(workingDir, slug), "log.jsonl");
	fs.appendFileSync(p, `${JSON.stringify({ timestamp: nowIso(), ...entry })}\n`);
}

/** Controller ALWAYS writes a handoff file (decision #11), even if parsing failed. */
export function writeHandoff(workingDir: string, slug: string, h: Handoff): string {
	const ts = h.timestamp.replace(/[:.]/g, "-");
	const fname = `${ts}__${h.role}-r${h.round}__${h.sessionId}.json`;
	const fpath = path.join(taskDir(workingDir, slug), "handoffs", fname);
	atomicWriteJson(fpath, h);
	appendLog(workingDir, slug, {
		type: h.role === "tester" ? "tester_verdict" : "developer_handoff",
		round: h.round,
		successState: h.successState,
		summary: h.summary,
	});
	return fpath;
}

export function listHandoffs(workingDir: string, slug: string): string[] {
	const dir = path.join(taskDir(workingDir, slug), "handoffs");
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort();
}

/** Find an existing in-progress task to resume in this workingDir. */
export function findResumable(workingDir: string): LedgerState | null {
	const root = plansRoot(workingDir);
	if (!fs.existsSync(root)) return null;
	const candidates: LedgerState[] = [];
	for (const slug of fs.readdirSync(root)) {
		const sp = path.join(root, slug, "state.json");
		if (fs.existsSync(sp)) {
			try {
				const st = JSON.parse(fs.readFileSync(sp, "utf-8")) as LedgerState;
				if (st.state === "in_progress" || st.state === "escalated") candidates.push(st);
			} catch {}
		}
	}
	candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	return candidates[0] ?? null;
}
