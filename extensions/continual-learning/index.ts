/**
 * Continual Learning — pi port of Cursor's `continual-learning` plugin.
 *
 * Cursor wires this as: a Bun `stop` hook (cadence gate) -> a skill -> the `agents-memory-updater`
 * subagent that mines transcript deltas into AGENTS.md. pi exposes the same shape natively:
 *
 *   Cursor stop hook            -> pi.on("agent_end")  (one completed user prompt = one "turn")
 *   followup_message            -> a background learning pass (no need to nag the main agent)
 *   continual-learning skill    -> skills/continual-learning/SKILL.md (manual/explicit path)
 *   agents-memory-updater       -> crew/agents-memory-updater.md, spawned headless via runner.ts
 *   .cursor/hooks/state/*.json  -> .pi/state/continual-learning{,-index}.json
 *
 * High-signal source = the MAIN session transcript (founder<->CTO chat), not crew/tool transcripts.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type CadenceState, createInitialState, decideCadence, normalizeState, parseEnvOptions } from "./cadence.ts";
import { type LearnRunOutcome, readJsonFile, resolveLearnPaths, runLearningPass, writeJsonFile } from "./learn.ts";
import { NO_UPDATES_SENTINEL } from "./memory.ts";
import { loadUpdaterAgent } from "./runner.ts";
import { listSessionTranscripts, sessionLocationForCwd } from "./transcript.ts";
import { renderDiffLines, isEmptyDiff } from "./diff.ts";

const STATE_VERSION_NOTE = "continual-learning";
const WIDGET_KEY = "continual-learning-diff";
const DISMISS_TIMEOUT_MS = 30000;

function loadCadenceState(stateFile: string): CadenceState {
	const parsed = readJsonFile<Partial<CadenceState>>(stateFile);
	return parsed ? normalizeState(parsed) : createInitialState();
}

/** mtime of the newest session transcript for this cwd, or null when none exist. */
function newestTranscriptMtime(agentDir: string, cwd: string): number | null {
	const stats = listSessionTranscripts(sessionLocationForCwd(agentDir, cwd).dir);
	return stats.length ? stats[0].mtimeMs : null;
}

/** True when this prompt produced a real assistant turn (not aborted/errored). */
function promptProducedTurn(messages: ReadonlyArray<{ role?: string; stopReason?: string }>): boolean {
	return messages.some((m) => m.role === "assistant" && m.stopReason !== "aborted" && m.stopReason !== "error");
}

/**
 * Run one learning pass and surface a short result. Shared by the cadence-triggered path and the
 * manual command. Never throws — learning is best-effort telemetry.
 */
export async function runLearningPassForCwd(cwd: string, signal?: AbortSignal): Promise<LearnRunOutcome> {
	try {
		const agentDir = getAgentDir();
		const agent = loadUpdaterAgent();
		return await runLearningPass({ cwd, agent, now: Date.now(), signal, agentDir });
	} catch (error) {
		return { ran: true, ok: false, reason: `error: ${String(error)}`, stderr: String(error), deltaCount: 0 };
	}
}

export default function (pi: ExtensionAPI) {
	let running = false;
	let dismissTimer: NodeJS.Timeout | null = null;

	const clearDiffWidget = (ctx: any) => {
		if (dismissTimer) {
			clearTimeout(dismissTimer);
			dismissTimer = null;
		}
		ctx.ui?.setWidget?.(WIDGET_KEY, undefined);
	};

	const showDiffWidget = (ctx: any, outcome: LearnRunOutcome) => {
		if (dismissTimer) {
			clearTimeout(dismissTimer);
			dismissTimer = null;
		}

		if (outcome.diff && !isEmptyDiff(outcome.diff)) {
			const theme = ctx.ui?.theme;
			// Build palette using known foreground tokens: toolDiffAdded (green), toolDiffRemoved (red), dim, accent.
			// theme.fg is a Theme method (signature fg(token, text): string) — call it on `theme` so its `this`
			// stays bound; fall back to identity only when theme/fg is absent (RPC/print modes).
			const palette = {
				added: (s: string) => (theme?.fg ? theme.fg("toolDiffAdded", s) : s),
				removed: (s: string) => (theme?.fg ? theme.fg("toolDiffRemoved", s) : s),
				heading: (s: string) => (theme?.fg ? theme.fg("accent", s) : s),
				dim: (s: string) => (theme?.fg ? theme.fg("dim", s) : s),
			};
			const lines = renderDiffLines(outcome.diff, outcome.deltaCount, { palette, maxLines: 8, width: 100 });
			ctx.ui?.setWidget?.(WIDGET_KEY, lines, { placement: "aboveEditor" });

			dismissTimer = setTimeout(() => {
				ctx.ui?.setWidget?.(WIDGET_KEY, undefined);
				dismissTimer = null;
			}, DISMISS_TIMEOUT_MS);
		} else {
			// Fallback if diff is empty/unavailable
			const msg = `Continual learning: updated AGENTS.md from ${outcome.deltaCount} transcript(s).`;
			ctx.ui?.notify?.(msg, "info");
		}
	};

	pi.on("agent_start", (_event, ctx) => {
		clearDiffWidget(ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		// Never recurse: the updater runs as crew (FOREMAN_CREW/CONTINUAL_LEARNING_CREW) and must not
		// itself trigger learning. Also serialize: one pass at a time per process.
		if (process.env.CONTINUAL_LEARNING_CREW === "1" || process.env.FOREMAN_CREW === "1") return;
		if (running) return;

		const cwd = ctx.cwd;
		const agentDir = getAgentDir();
		const { stateFile } = resolveLearnPaths(cwd);
		const options = parseEnvOptions(process.env);

		const sessionFile = ctx.sessionManager?.getSessionFile?.();
		const leafId = ctx.sessionManager?.getLeafId?.();
		const generationKey = `${sessionFile ?? "nofile"}:${leafId ?? Date.now()}`;

		const prev = loadCadenceState(stateFile);
		const decision = decideCadence(
			{
				turnCounted: promptProducedTurn(event.messages ?? []),
				generationKey,
				transcriptMtimeMs: newestTranscriptMtime(agentDir, cwd),
			},
			prev,
			options,
			Date.now(),
		);
		writeJsonFile(stateFile, decision.state);
		if (!decision.trigger) return;

		running = true;
		void (async () => {
			try {
				const outcome = await runLearningPassForCwd(cwd, ctx.signal);
				if (outcome.ran && !outcome.ok) {
					ctx.ui?.notify?.(`Continual learning: updater failed (${outcome.reason}).`, "warning");
				} else if (outcome.ran && outcome.ok && outcome.updaterText && !outcome.updaterText.includes(NO_UPDATES_SENTINEL)) {
					showDiffWidget(ctx, outcome);
				}
			} catch {
				// best-effort; swallow
			} finally {
				running = false;
			}
		})();
	});

	pi.registerCommand("continual-learning", {
		description: "Mine recent main-session transcripts and update AGENTS.md learned sections now.",
		handler: async (_args, ctx) => {
			if (running) {
				ctx.ui?.notify?.("Continual learning already running.", "warning");
				return;
			}
			running = true;
			ctx.ui?.notify?.("Continual learning: mining recent transcripts…", "info");
			try {
				const outcome = await runLearningPassForCwd(ctx.cwd, ctx.signal);
				if (outcome.ran && !outcome.ok) {
					ctx.ui?.notify?.(`Continual learning: updater failed (${outcome.reason}).`, "warning");
				} else {
					if (outcome.ran && outcome.ok && outcome.updaterText && !outcome.updaterText.includes(NO_UPDATES_SENTINEL)) {
						showDiffWidget(ctx, outcome);
					} else {
						const msg = !outcome.ran
							? `Continual learning: nothing to do (${outcome.reason}).`
							: outcome.updaterText?.includes(NO_UPDATES_SENTINEL)
								? `Continual learning: no high-signal updates (${outcome.deltaCount} transcript(s) scanned).`
								: `Continual learning: updated AGENTS.md (${outcome.deltaCount} transcript(s)).`;
						ctx.ui?.notify?.(msg, "info");
					}
				}
			} finally {
				running = false;
			}
		},
	});

	void STATE_VERSION_NOTE;
}
