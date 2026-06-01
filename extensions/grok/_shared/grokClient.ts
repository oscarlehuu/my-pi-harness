/**
 * Grok proxy client — reverse-engineered from the authorized `grok` CLI.
 *
 * The grok CLI signs in via OIDC (`grok login`) and stores its credentials in
 * ~/.grok/auth.json. Its built-in `web_search` / `x_search` tools are NOT run
 * locally: the CLI forwards the turn to xAI's subscription-backed proxy
 *
 *     POST https://cli-chat-proxy.grok.com/v1/responses
 *
 * which is the OpenAI **Responses API** shape with xAI server-side search tools
 * (`{"type":"web_search"}`, `{"type":"x_search"}`). This proxy is billed against
 * the Grok subscription tied to the login — NOT the pay-as-you-go api.x.ai
 * credits — so it keeps working even when the team's API credits are exhausted.
 *
 * We replicate exactly what the CLI sends on the wire:
 *   Authorization: Bearer <auth.json key>        (the OIDC access token)
 *   X-XAI-Token-Auth: xai-grok-cli               (validate as a CLI session token)
 *   x-grok-model-override: grok-4.20-multi-agent (route to the search model)
 *   x-grok-client-version: <version>             (proxy rejects unknown versions, 426)
 *
 * Auth precedence — by default we do exactly what the grok CLI does: use the
 * subscription session token from `grok login`. That endpoint is billed against
 * the Grok subscription, so it keeps working even when pay-as-you-go api.x.ai
 * credits are exhausted (which is the common case). The API-key path is a
 * fallback for boxes that only have a key.
 *
 *   1. ~/.grok/auth.json OIDC token -> cli-chat-proxy (subscription)   [default]
 *   2. GROK_API_KEY / XAI_API_KEY     -> public api.x.ai (pay-as-you-go) [fallback]
 *
 * Override with GROK_SEARCH_AUTH=subscription|api-key to force one path. The
 * model and server-side tool wiring are identical either way; only the base URL
 * and auth headers differ. The whole point: when "Grok is authorised" (i.e.
 * `grok login` has run) web/x search Just Work.
 */

import {
	type GrokAuth,
	GrokAuthError,
	buildAuthHeaders,
	resolveGrokAuth,
} from "./grokAuth.ts";

export { GrokAuthError, resolveGrokAuth } from "./grokAuth.ts";

/** Search model the grok CLI routes web_search / x_search through. */
export const GROK_SEARCH_MODEL = "grok-4.20-multi-agent";

/** One server-side search tool entry in the Responses `tools` array. */
export type SearchTool =
	| { type: "web_search"; allowed_domains?: string[]; excluded_domains?: string[] }
	| {
			type: "x_search";
			allowed_x_handles?: string[];
			excluded_x_handles?: string[];
			from_date?: string;
			to_date?: string;
	  };

export interface Citation {
	url: string;
	title?: string;
}

/** A single server-side search action the model took (for transparency). */
export interface SearchAction {
	tool: "web_search" | "x_search";
	/** "search" | "open_page" | ... as reported by the proxy. */
	action?: string;
	query?: string;
	url?: string;
}

export interface GrokSearchResult {
	text: string;
	citations: Citation[];
	actions: SearchAction[];
	toolCalls: { web: number; x: number };
	model: string;
	mode: GrokAuth["mode"];
}

/** Lightweight progress signal so callers can show a live status line. */
export interface SearchProgress {
	/** "searching" while server-side tools run; "retrying" between attempts. */
	phase: "searching" | "retrying";
	webCalls: number;
	xCalls: number;
	/** 1-based attempt number this progress belongs to. */
	attempt: number;
}

export interface RunSearchOptions {
	input: string;
	tools: SearchTool[];
	signal?: AbortSignal;
	/** Called with incremental answer text as it streams in. */
	onText?: (fullText: string) => void;
	/** Called as server-side searches complete / between retries (no answer text yet). */
	onProgress?: (progress: SearchProgress) => void;
}

interface ResponsesEvent {
	type?: string;
	delta?: string;
	/** Present on top-level `type:"error"` events. */
	message?: string;
	code?: string | null;
	item?: {
		type?: string;
		action?: { type?: string; query?: string; url?: string };
		content?: Array<{ type?: string; text?: string; annotations?: RawAnnotation[] }>;
	};
	response?: {
		output?: Array<{
			type?: string;
			action?: { type?: string; query?: string; url?: string };
			content?: Array<{ type?: string; text?: string; annotations?: RawAnnotation[] }>;
		}>;
		usage?: { server_side_tool_usage_details?: { web_search_calls?: number; x_search_calls?: number } };
		error?: unknown;
	};
	error?: unknown;
}

/** Thrown for errors that are worth retrying (rate limits, transient proxy 5xx). */
class TransientGrokError extends Error {}

const TRANSIENT_PATTERNS = [
	/temporarily unavailable/i,
	/too many requests/i,
	/resource has been exhausted/i,
	/rate.?limit/i,
	/\b(429|502|503|504)\b/,
];

function isTransientMessage(msg: string): boolean {
	return TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

const MAX_ATTEMPTS = Number(process.env.GROK_SEARCH_MAX_ATTEMPTS ?? 4);
const BASE_BACKOFF_MS = Number(process.env.GROK_SEARCH_BACKOFF_MS ?? 1500);
/**
 * Hard wall-clock ceiling for a whole search (across all retries). A clean,
 * fast error beats a long silent tail. 0 disables. Heavy multi-search answers
 * (30+ server-side calls) can legitimately take ~40s, so the default is roomy.
 */
const DEADLINE_MS = Number(process.env.GROK_SEARCH_DEADLINE_MS ?? 90000);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

interface RawAnnotation {
	type?: string;
	url?: string;
	title?: string;
}

/**
 * Run a search turn against the Grok proxy. The proxy intermittently returns a
 * transient "Service temporarily unavailable" / 429 (the same throttling the
 * grok CLI retries through), so we retry with exponential backoff before giving
 * up. A hard wall-clock deadline caps the whole operation so a clean error
 * surfaces fast instead of a long silent tail. Returns the answer + citations.
 */
export async function runGrokSearch(opts: RunSearchOptions): Promise<GrokSearchResult> {
	const attempts = Math.max(1, MAX_ATTEMPTS);

	// Link the caller's signal with our own deadline timer into one signal.
	const deadlineController = new AbortController();
	let deadlineHit = false;
	const timer =
		DEADLINE_MS > 0
			? setTimeout(() => {
					deadlineHit = true;
					deadlineController.abort();
				}, DEADLINE_MS)
			: null;
	const onOuterAbort = () => deadlineController.abort();
	opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
	const signal = deadlineController.signal;

	try {
		let lastErr: Error | undefined;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			try {
				return await runGrokSearchOnce(opts, signal, attempt);
			} catch (err) {
				if ((err as Error)?.name === "AbortError") {
					if (deadlineHit) throw new Error(`Grok search timed out after ${DEADLINE_MS}ms.`);
					throw err;
				}
				if (err instanceof GrokAuthError) throw err;
				lastErr = err as Error;
				const transient = err instanceof TransientGrokError || isTransientMessage((err as Error).message);
				if (!transient || attempt === attempts) throw err;
				opts.onProgress?.({ phase: "retrying", webCalls: 0, xCalls: 0, attempt });
				// Exponential backoff with jitter, mirroring the CLI's retry behaviour.
				const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 400);
				await sleep(delay, signal);
			}
		}
		throw lastErr ?? new Error("Grok search failed");
	} finally {
		if (timer) clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onOuterAbort);
	}
}

async function runGrokSearchOnce(
	opts: RunSearchOptions,
	signal: AbortSignal,
	attempt: number,
): Promise<GrokSearchResult> {
	const auth = resolveGrokAuth();
	const body = JSON.stringify({
		model: GROK_SEARCH_MODEL,
		input: opts.input,
		tools: opts.tools,
		stream: true,
	});

	let response: Response;
	try {
		response = await fetch(`${auth.baseUrl}/responses`, {
			method: "POST",
			headers: buildAuthHeaders(auth, { "x-grok-model-override": GROK_SEARCH_MODEL }),
			body,
			signal,
		});
	} catch (err) {
		if ((err as Error)?.name === "AbortError") throw err;
		throw new Error(`Grok proxy request failed: ${(err as Error).message}`);
	}

	if (!response.ok || !response.body) {
		const detail = await safeReadError(response);
		const msg = `Grok proxy returned ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`;
		if (response.status === 429 || response.status >= 500 || isTransientMessage(detail)) {
			throw new TransientGrokError(msg);
		}
		throw new Error(msg);
	}

	const state = {
		text: "",
		citations: [] as Citation[],
		actions: [] as SearchAction[],
		web: 0,
		x: 0,
	};
	const seenCitations = new Set<string>();

	const ingestAnnotations = (annotations?: RawAnnotation[]) => {
		if (!annotations) return;
		for (const ann of annotations) {
			if (ann.type !== "url_citation" || !ann.url || seenCitations.has(ann.url)) continue;
			seenCitations.add(ann.url);
			state.citations.push({ url: ann.url, title: ann.title });
		}
	};

	const raiseProxyError = (msg: string): never => {
		if (isTransientMessage(msg)) throw new TransientGrokError(`Grok proxy busy: ${msg}`);
		throw new Error(`Grok proxy error: ${msg}`);
	};

	const handleEvent = (event: ResponsesEvent) => {
		// Top-level streamed error event: {"type":"error","message":"..."}.
		if (event.type === "error") {
			raiseProxyError(event.message || event.code || "unknown error");
		}
		const err = event.error ?? event.response?.error;
		if (err) {
			const msg =
				typeof err === "string" ? err : ((err as Record<string, unknown>)?.message as string) || JSON.stringify(err);
			raiseProxyError(msg);
		}

		switch (event.type) {
			case "response.output_text.delta":
				if (typeof event.delta === "string") {
					state.text += event.delta;
					opts.onText?.(state.text);
				}
				break;
			case "response.output_item.done": {
				const item = event.item;
				if (item?.type === "web_search_call" || item?.type === "x_search_call") {
					const isX = item.type === "x_search_call";
					state.actions.push({
						tool: isX ? "x_search" : "web_search",
						action: item.action?.type,
						query: item.action?.query,
						url: item.action?.url,
					});
					if (isX) state.x++;
					else state.web++;
					opts.onProgress?.({ phase: "searching", webCalls: state.web, xCalls: state.x, attempt });
				}
				for (const part of item?.content ?? []) ingestAnnotations(part.annotations);
				break;
			}
			case "response.completed": {
				const usage = event.response?.usage?.server_side_tool_usage_details;
				// Usage details are authoritative (they include internal sub-searches),
				// but never report fewer than the calls we observed live.
				if (usage) {
					state.web = Math.max(state.web, usage.web_search_calls ?? 0);
					state.x = Math.max(state.x, usage.x_search_calls ?? 0);
				}
				// Final, authoritative output — prefer it over accumulated deltas.
				for (const item of event.response?.output ?? []) {
					if (item.type === "message") {
						const finalText = (item.content ?? [])
							.filter((p) => p.type === "output_text" && typeof p.text === "string")
							.map((p) => p.text as string)
							.join("");
						if (finalText) state.text = finalText;
						for (const part of item.content ?? []) ingestAnnotations(part.annotations);
					}
				}
				break;
			}
		}
	};

	await consumeSSE(response.body, handleEvent, signal);

	return {
		text: state.text.trim(),
		citations: state.citations,
		actions: state.actions,
		toolCalls: { web: state.web, x: state.x },
		model: GROK_SEARCH_MODEL,
		mode: auth.mode,
	};
}

async function safeReadError(response: Response): Promise<string> {
	try {
		const raw = await response.text();
		try {
			const parsed = JSON.parse(raw);
			return parsed.error || parsed.message || raw.slice(0, 400);
		} catch {
			return raw.slice(0, 400);
		}
	} catch {
		return "";
	}
}

/**
 * Parse an SSE stream of `event:`/`data:` lines, decoding each `data:` JSON
 * payload and dispatching it. Tolerates multi-line data and CRLF.
 */
async function consumeSSE(
	body: ReadableStream<Uint8Array>,
	onEvent: (event: ResponsesEvent) => void,
	signal?: AbortSignal,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const flushBlock = (block: string) => {
		const dataLines: string[] = [];
		for (const line of block.split("\n")) {
			const trimmed = line.replace(/\r$/, "");
			if (trimmed.startsWith("data:")) dataLines.push(trimmed.slice(5).trimStart());
		}
		if (!dataLines.length) return;
		const payload = dataLines.join("\n");
		if (!payload || payload === "[DONE]") return;
		let event: ResponsesEvent;
		try {
			event = JSON.parse(payload);
		} catch {
			return;
		}
		onEvent(event);
	};

	try {
		while (true) {
			if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let sep: number;
			// SSE event blocks are separated by a blank line.
			while ((sep = buffer.indexOf("\n\n")) !== -1) {
				const block = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				flushBlock(block);
			}
		}
		buffer += decoder.decode();
		if (buffer.trim()) flushBlock(buffer);
	} finally {
		reader.releaseLock();
	}
}

/** Render the answer + numbered citations as Markdown for tool content. */
export function formatSearchMarkdown(result: GrokSearchResult): string {
	const lines = [result.text || "(no answer returned)"];
	if (result.citations.length) {
		lines.push("", "Sources:");
		result.citations.forEach((c, i) => {
			lines.push(`${i + 1}. ${c.url}`);
		});
	}
	return lines.join("\n");
}
