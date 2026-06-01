/**
 * UI-developer fallback detection (frontend track).
 *
 * Gemini 3.5 Flash has frontend taste but is unreliable at tool-calling: it can crash mid-tooling,
 * skip the machine block, or "finish" without ever editing a file. When that happens the controller
 * re-runs the SAME round once with a stronger model (Opus 4.8 xhigh) using the same frontend prompt.
 *
 * These helpers are pure / node-builtin-only (no pi imports) so they can be unit-tested headlessly.
 */

import { spawnSync } from "node:child_process";

export interface DevRunLike {
	exitCode: number;
}

/**
 * Snapshot of the working tree's dirty state (`git status --porcelain`), or null when the directory
 * is not a git repo / git is unavailable. Comparing a before/after snapshot detects "made no edits"
 * even when the repo started dirty.
 */
export function workingTreeSnapshot(cwd: string): string | null {
	try {
		const r = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
		if (r.error || r.status !== 0) return null;
		return r.stdout ?? "";
	} catch {
		return null;
	}
}

/**
 * Why the UI developer's run should fall back to the stronger model, or null if it did real work.
 * Any one signal triggers fallback: the process errored, it emitted no DEV-JSON machine block, or it
 * changed nothing on disk. This captures "Gemini failed to drive the tools" — it does NOT judge the
 * quality of the work (that's the tester's job).
 */
export function devFallbackReason(
	run: DevRunLike,
	hasMachineBlock: boolean,
	treeBefore: string | null,
	treeAfter: string | null,
): string | null {
	if (run.exitCode !== 0) return `process exited ${run.exitCode}`;
	if (!hasMachineBlock) return "no DEV-JSON machine block";
	if (treeBefore !== null && treeAfter !== null && treeBefore === treeAfter) return "no file changes on disk";
	return null;
}
