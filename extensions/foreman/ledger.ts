/**
 * Ledger — on-disk task state for the loop workflow.
 * Lives in the TARGET repo at <repo>/.pi/plans/<task-slug>/ (committed to git).
 * Resume = read state.json + handoffs/ (cursor-based).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type SuccessState = "success" | "partial" | "blocked" | "fail";
export type ActivityPhase = "developer" | "verify" | "tester" | "idle";

export interface LedgerState {
	task: string;
	slug: string;
	state: "planning" | "in_progress" | "awaiting_ship" | "done" | "escalated";
	workingDirectory: string;
	/** Session that created/owns this task. Lets resume target THIS session's task in a shared repo. */
	ownerSessionId?: string;
	verifyCommand?: string;
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

export interface Activity {
	round: number;
	phase: ActivityPhase;
	activeTranscript?: string | null;
	note?: string;
	pid?: number;
	ownerSessionId?: string;
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

export function transcriptsDir(workingDir: string, slug: string): string {
	return path.join(taskDir(workingDir, slug), "transcripts");
}

/** Ensure .pi/.gitignore exists so only .pi/plans/ is committed. */
function ensureGitignore(workingDir: string): void {
	const piDir = path.join(workingDir, ".pi");
	fs.mkdirSync(piDir, { recursive: true });
	const giPath = path.join(piDir, ".gitignore");
	const requiredLines = [
		"# Only the ledger travels with the code; everything else in .pi is machine-local.",
		"# Ignore everything, then re-include plans/ and recurse into its contents.",
		"*",
		"!.gitignore",
		"!plans/",
		"!plans/**",
		"# ...but keep machine-local noise out of the committed ledger.",
		"plans/*/transcripts/",
		"plans/*/activity.json",
		"plans/**/*.log",
	];
	if (!fs.existsSync(giPath)) {
		fs.writeFileSync(giPath, `${requiredLines.join("\n")}\n`);
		return;
	}

	let content = fs.readFileSync(giPath, "utf-8");
	let changed = false;
	for (const line of ["plans/*/transcripts/", "plans/*/activity.json"]) {
		if (!content.split(/\r?\n/).includes(line)) {
			content = `${content.replace(/\s*$/, "\n")}${line}\n`;
			changed = true;
		}
	}
	if (changed) fs.writeFileSync(giPath, content);
}

function atomicWriteJson(p: string, data: unknown): void {
	const tmp = `${p}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
	fs.renameSync(tmp, p);
}

export function initLedger(
	workingDir: string,
	task: string,
	maxRounds: number,
	verifyCommand?: string,
	ownerSessionId?: string,
): LedgerState {
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
		state: "planning",
		workingDirectory: workingDir,
		ownerSessionId,
		verifyCommand,
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

export function writeActivity(workingDir: string, slug: string, activity: Activity): void {
	ensureGitignore(workingDir);
	atomicWriteJson(path.join(taskDir(workingDir, slug), "activity.json"), {
		updatedAt: nowIso(),
		round: activity.round,
		phase: activity.phase,
		activeTranscript: activity.activeTranscript ?? null,
		note: activity.note ?? "",
		pid: activity.pid ?? process.pid,
		ownerSessionId: activity.ownerSessionId ?? null,
	});
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

/** All non-done tasks in this repo, newest-updated first. */
export function listResumable(workingDir: string): LedgerState[] {
	const root = plansRoot(workingDir);
	if (!fs.existsSync(root)) return [];
	const candidates: LedgerState[] = [];
	for (const slug of fs.readdirSync(root)) {
		const sp = path.join(root, slug, "state.json");
		if (fs.existsSync(sp)) {
			try {
				const st = JSON.parse(fs.readFileSync(sp, "utf-8")) as LedgerState;
				if (st.state !== "done") candidates.push(st);
			} catch {}
		}
	}
	candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	return candidates;
}

export interface ResumeResolution {
	state?: LedgerState;
	error?: string;
}

function ownerLabel(c: LedgerState, me?: string): string {
	if (!c.ownerSessionId) return "";
	return c.ownerSessionId === me ? " (yours)" : ` (owned by session ${c.ownerSessionId.slice(0, 8)})`;
}

function listLines(candidates: LedgerState[], me?: string): string {
	return candidates.map((c) => `  - ${c.slug} [${c.state}]${ownerLabel(c, me)}`).join("\n");
}

/**
 * Resolve WHICH task a `resume` should act on. In a shared repo two sessions may each have an
 * in-flight task; this targets the caller's own task so an approve/reject can't hijack another
 * session's task. Order: explicit slug → owned by this session → lone task (solo/back-compat) →
 * ambiguous error listing the open tasks.
 */
export function resolveResumable(workingDir: string, opts: { slug?: string; sessionId?: string }): ResumeResolution {
	const candidates = listResumable(workingDir);
	if (candidates.length === 0) return { error: "No resumable task found in this repo." };

	// 1. Explicit slug wins.
	if (opts.slug) {
		const match = candidates.find((c) => c.slug === opts.slug);
		if (match) return { state: match };
		return { error: `No resumable task with slug "${opts.slug}". Open tasks:\n${listLines(candidates, opts.sessionId)}` };
	}

	// 2. Tasks owned by THIS session.
	if (opts.sessionId) {
		const mine = candidates.filter((c) => c.ownerSessionId === opts.sessionId);
		if (mine.length === 1) return { state: mine[0] };
		if (mine.length > 1) {
			return { error: `This session owns ${mine.length} resumable tasks; pass \`slug\` to pick one:\n${listLines(mine, opts.sessionId)}` };
		}
	}

	// 3. Solo / back-compat: a single open task in the repo.
	if (candidates.length === 1) return { state: candidates[0] };

	// 4. Multiple tasks, none owned by this session → require an explicit slug.
	return { error: `Multiple resumable tasks and none owned by this session. Pass \`slug\` to choose:\n${listLines(candidates, opts.sessionId)}` };
}
