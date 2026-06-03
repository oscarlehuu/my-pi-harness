/**
 * Cadence gate — pure port of Cursor's `continual-learning-stop.ts` trigger logic.
 *
 * Cursor runs this inside a Bun `stop` hook that prints `{ followup_message }` when it decides a
 * learning pass is due. pi has no external hook process; instead the extension calls `decideCadence`
 * from the `agent_end` event (one completed user prompt = one "turn"). The decision is kept pure and
 * node-free so the truth table can be unit-tested headlessly.
 *
 * The gate fires only when ALL hold (matching Cursor):
 *   - the prompt actually produced an assistant turn (not aborted/errored)
 *   - turns since last run >= min turns
 *   - minutes since last run >= min minutes
 *   - the transcript mtime advanced since the last run
 *   - this generation was not already processed (dedupe)
 */

export interface CadenceState {
	version: 1;
	lastRunAtMs: number;
	turnsSinceLastRun: number;
	lastTranscriptMtimeMs: number | null;
	lastProcessedGenerationId: string | null;
	trialStartedAtMs: number | null;
}

export interface CadenceInput {
	/** True when this prompt produced a non-aborted assistant turn. */
	turnCounted: boolean;
	/** Stable key for this generation; repeats are ignored (dedupe). */
	generationKey: string;
	/** mtime of the transcript being mined, or null when unavailable. */
	transcriptMtimeMs: number | null;
}

export interface CadenceOptions {
	minTurns: number;
	minMinutes: number;
	trialEnabled: boolean;
	trialMinTurns: number;
	trialMinMinutes: number;
	trialDurationMinutes: number;
}

export interface CadenceDecision {
	trigger: boolean;
	state: CadenceState;
	/** Human-readable reason the gate did or did not fire (for logs/notify). */
	reason: string;
}

export const DEFAULT_MIN_TURNS = 10;
export const DEFAULT_MIN_MINUTES = 30;
export const TRIAL_DEFAULT_MIN_TURNS = 3;
export const TRIAL_DEFAULT_MIN_MINUTES = 15;
export const TRIAL_DEFAULT_DURATION_MINUTES = 24 * 60;

export function createInitialState(): CadenceState {
	return {
		version: 1,
		lastRunAtMs: 0,
		turnsSinceLastRun: 0,
		lastTranscriptMtimeMs: null,
		lastProcessedGenerationId: null,
		trialStartedAtMs: null,
	};
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function normalizeState(parsed: Partial<CadenceState> | null | undefined): CadenceState {
	const fallback = createInitialState();
	if (!parsed || parsed.version !== 1) return fallback;
	return {
		version: 1,
		lastRunAtMs: isFiniteNumber(parsed.lastRunAtMs) ? parsed.lastRunAtMs : 0,
		turnsSinceLastRun: isFiniteNumber(parsed.turnsSinceLastRun) && parsed.turnsSinceLastRun >= 0 ? parsed.turnsSinceLastRun : 0,
		lastTranscriptMtimeMs: isFiniteNumber(parsed.lastTranscriptMtimeMs) ? parsed.lastTranscriptMtimeMs : null,
		lastProcessedGenerationId: typeof parsed.lastProcessedGenerationId === "string" ? parsed.lastProcessedGenerationId : null,
		trialStartedAtMs: isFiniteNumber(parsed.trialStartedAtMs) ? parsed.trialStartedAtMs : null,
	};
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/** Read a primary env var, falling back to the legacy CONTINUOUS_* name (Cursor parity). */
function readEnvValue(env: Record<string, string | undefined>, primary: string, legacy: string): string | undefined {
	return env[primary] ?? env[legacy];
}

export function parseEnvOptions(env: Record<string, string | undefined>): CadenceOptions {
	return {
		minTurns: parsePositiveInt(readEnvValue(env, "CONTINUAL_LEARNING_MIN_TURNS", "CONTINUOUS_LEARNING_MIN_TURNS"), DEFAULT_MIN_TURNS),
		minMinutes: parsePositiveInt(readEnvValue(env, "CONTINUAL_LEARNING_MIN_MINUTES", "CONTINUOUS_LEARNING_MIN_MINUTES"), DEFAULT_MIN_MINUTES),
		trialEnabled: parseBoolean(readEnvValue(env, "CONTINUAL_LEARNING_TRIAL_MODE", "CONTINUOUS_LEARNING_TRIAL_MODE")),
		trialMinTurns: parsePositiveInt(readEnvValue(env, "CONTINUAL_LEARNING_TRIAL_MIN_TURNS", "CONTINUOUS_LEARNING_TRIAL_MIN_TURNS"), TRIAL_DEFAULT_MIN_TURNS),
		trialMinMinutes: parsePositiveInt(
			readEnvValue(env, "CONTINUAL_LEARNING_TRIAL_MIN_MINUTES", "CONTINUOUS_LEARNING_TRIAL_MIN_MINUTES"),
			TRIAL_DEFAULT_MIN_MINUTES,
		),
		trialDurationMinutes: parsePositiveInt(
			readEnvValue(env, "CONTINUAL_LEARNING_TRIAL_DURATION_MINUTES", "CONTINUOUS_LEARNING_TRIAL_DURATION_MINUTES"),
			TRIAL_DEFAULT_DURATION_MINUTES,
		),
	};
}

/**
 * Decide whether a learning pass is due. Returns the next state to persist regardless of outcome
 * (matching Cursor: turns accumulate on every call; the counter resets only when the gate fires).
 */
export function decideCadence(input: CadenceInput, prev: CadenceState, options: CadenceOptions, now: number): CadenceDecision {
	const state: CadenceState = { ...prev };

	// Dedupe: the same generation must not be counted or triggered twice.
	if (input.generationKey && input.generationKey === state.lastProcessedGenerationId) {
		return { trigger: false, state, reason: "duplicate generation" };
	}
	state.lastProcessedGenerationId = input.generationKey || state.lastProcessedGenerationId;

	const turnIncrement = input.turnCounted ? 1 : 0;
	const turnsSinceLastRun = state.turnsSinceLastRun + turnIncrement;

	if (options.trialEnabled && input.turnCounted && state.trialStartedAtMs === null) {
		state.trialStartedAtMs = now;
	}
	const inTrialWindow =
		options.trialEnabled && state.trialStartedAtMs !== null && now - state.trialStartedAtMs < options.trialDurationMinutes * 60_000;

	const effectiveMinTurns = inTrialWindow ? options.trialMinTurns : options.minTurns;
	const effectiveMinMinutes = inTrialWindow ? options.trialMinMinutes : options.minMinutes;

	const minutesSinceLastRun = state.lastRunAtMs > 0 ? Math.floor((now - state.lastRunAtMs) / 60_000) : Number.POSITIVE_INFINITY;
	const hasTranscriptAdvanced =
		input.transcriptMtimeMs !== null &&
		(state.lastTranscriptMtimeMs === null || input.transcriptMtimeMs > state.lastTranscriptMtimeMs);

	const shouldTrigger =
		input.turnCounted &&
		turnsSinceLastRun >= effectiveMinTurns &&
		minutesSinceLastRun >= effectiveMinMinutes &&
		hasTranscriptAdvanced;

	if (shouldTrigger) {
		state.lastRunAtMs = now;
		state.turnsSinceLastRun = 0;
		state.lastTranscriptMtimeMs = input.transcriptMtimeMs;
		return { trigger: true, state, reason: `due (${turnsSinceLastRun} turns, ${minutesSinceLastRun}m${inTrialWindow ? ", trial" : ""})` };
	}

	state.turnsSinceLastRun = turnsSinceLastRun;
	const why = !input.turnCounted
		? "no counted turn"
		: turnsSinceLastRun < effectiveMinTurns
			? `need ${effectiveMinTurns - turnsSinceLastRun} more turn(s)`
			: minutesSinceLastRun < effectiveMinMinutes
				? `need ${effectiveMinMinutes - minutesSinceLastRun} more minute(s)`
				: !hasTranscriptAdvanced
					? "transcript not advanced"
					: "not due";
	return { trigger: false, state, reason: why };
}
