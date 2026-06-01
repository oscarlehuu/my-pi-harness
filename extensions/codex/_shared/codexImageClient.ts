/**
 * Codex image client for pi.
 *
 * Uses the ChatGPT/Codex subscription-backed Responses endpoint directly via
 * Codex OAuth credentials. This intentionally does NOT use pay-as-you-go API keys.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const CODEX_IMAGE_RESPONSES_URL =
	process.env.CODEX_IMAGE_RESPONSES_URL ?? "https://chatgpt.com/backend-api/codex/responses";
export const DEFAULT_CODEX_IMAGE_BASE_MODEL = "gpt-5.4-mini";

const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_USER_AGENT = "codex_cli_rs/0.0.0";
const EXPIRY_SKEW_MS = 120_000;
const MAX_ATTEMPTS = Number(process.env.CODEX_IMAGE_MAX_ATTEMPTS ?? 4);
const BASE_BACKOFF_MS = Number(process.env.CODEX_IMAGE_BACKOFF_MS ?? 1500);
const DEADLINE_MS = Number(process.env.CODEX_IMAGE_DEADLINE_MS ?? 180_000);

export type CodexImageSize = "1024x1024" | "1536x1024" | "1024x1536" | "auto";
export type CodexImageOutputFormat = "png" | "jpeg" | "webp";

export interface CodexImageProgress {
	phase: "partial_image" | "retrying";
	attempt: number;
	partialImageCount?: number;
	partialImage?: string;
}

export interface CodexImageRequestOptions {
	prompt: string;
	size?: CodexImageSize;
	outputFormat?: CodexImageOutputFormat;
	outputPath?: string;
	cwd?: string;
	signal?: AbortSignal;
	onProgress?: (progress: CodexImageProgress) => void;
}

export interface CodexImageEditOptions extends CodexImageRequestOptions {
	images: string[];
}

export interface CodexImageResult {
	base64: string;
	bytes: number;
	mimeType: string;
	savedPath: string;
	model: string;
	size: CodexImageSize;
	outputFormat: CodexImageOutputFormat;
	revisedPrompt?: string;
	usage?: unknown;
	partialImageCount: number;
}

interface CodexAuth {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	accountId: string;
	source: AuthSource;
}

type AuthSource =
	| { kind: "primary"; path: string; raw: Record<string, unknown> }
	| { kind: "fallback"; path: string; raw: Record<string, unknown> };

export class CodexAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodexAuthError";
	}
}

class TransientCodexImageError extends Error {}

const TRANSIENT_PATTERNS = [
	/temporarily unavailable/i,
	/too many requests/i,
	/resource has been exhausted/i,
	/rate.?limit/i,
	/overloaded/i,
	/service.?unavailable/i,
	/\b(429|502|503|504)\b/,
];

function isTransientMessage(msg: string): boolean {
	return TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

function primaryAuthPath(): string {
	return process.env.CODEX_AUTH_PATH || path.join(os.homedir(), ".pi", "agent", "auth.json");
}

function fallbackAuthDir(): string {
	return path.join(os.homedir(), ".cli-proxy-api");
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseTimeMs(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		// Primary auth uses ms epoch. Be tolerant of second epochs in refresh payloads.
		return value > 0 && value < 10_000_000_000 ? value * 1000 : value;
	}
	if (typeof value === "string" && value.trim()) {
		const numeric = Number(value);
		if (Number.isFinite(numeric)) return parseTimeMs(numeric);
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return 0;
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function buildAuthFromPrimary(strict: boolean): CodexAuth | null {
	const filePath = primaryAuthPath();
	const raw = readJsonObject(filePath);
	if (!raw) return null;

	// "openai-codex" is the auth-key name pi/`codex login` writes; keep it verbatim.
	const entry = raw["openai-codex"];
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
	const obj = entry as Record<string, unknown>;
	if (obj.type !== undefined && obj.type !== "oauth") {
		if (!strict) return null;
		throw new CodexAuthError(
			`Codex auth entry in ${filePath} is not an OAuth entry. Run \`codex login\` to re-authorise.`,
		);
	}

	const accessToken = asString(obj.access);
	const refreshToken = asString(obj.refresh);
	const accountId = asString(obj.accountId);
	if (!accessToken || !refreshToken || !accountId) {
		if (!strict) return null;
		throw new CodexAuthError(
			`Codex auth entry in ${filePath} is incomplete. Run \`codex login\` to re-authorise.`,
		);
	}

	return {
		accessToken,
		refreshToken,
		expiresAt: parseTimeMs(obj.expires),
		accountId,
		source: { kind: "primary", path: filePath, raw },
	};
}

function fallbackAuthFiles(): string[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(fallbackAuthDir());
	} catch {
		return [];
	}

	return entries
		.filter((name) => /^codex-.*\.json$/.test(name))
		.map((name) => path.join(fallbackAuthDir(), name))
		.map((filePath) => {
			try {
				return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
			} catch {
				return null;
			}
		})
		.filter((entry): entry is { filePath: string; mtimeMs: number } => Boolean(entry))
		.sort((a, b) => b.mtimeMs - a.mtimeMs)
		.map((entry) => entry.filePath);
}

function buildAuthFromFallback(strict: boolean): CodexAuth | null {
	for (const filePath of fallbackAuthFiles()) {
		const raw = readJsonObject(filePath);
		if (!raw) continue;
		const accessToken = asString(raw.access_token);
		const refreshToken = asString(raw.refresh_token);
		const accountId = asString(raw.account_id);
		if (!accessToken || !refreshToken || !accountId) {
			if (strict) {
				throw new CodexAuthError(
					`Codex fallback auth file ${filePath} is incomplete. Run \`codex login\` to re-authorise.`,
				);
			}
			continue;
		}
		return {
			accessToken,
			refreshToken,
			expiresAt: parseTimeMs(raw.expired),
			accountId,
			source: { kind: "fallback", path: filePath, raw },
		};
	}
	return null;
}

function loadCodexAuthSource(strict = true): CodexAuth | null {
	return buildAuthFromPrimary(strict) ?? buildAuthFromFallback(strict);
}

export function hasCodexAuthSync(): boolean {
	try {
		return Boolean(loadCodexAuthSource(false));
	} catch {
		return false;
	}
}

export async function resolveCodexAuth(): Promise<CodexAuth> {
	const auth = loadCodexAuthSource(true);
	if (!auth) {
		throw new CodexAuthError(
			`Codex is not authorised: no openai-codex OAuth entry found in ${primaryAuthPath()} and no usable ${fallbackAuthDir()}/codex-*.json fallback. Run \`codex login\` to log in via Codex.`,
		);
	}
	if (auth.expiresAt > Date.now() + EXPIRY_SKEW_MS) return auth;
	return refreshCodexAuth(auth);
}

function refreshExpiryMs(payload: Record<string, unknown>, currentExpiresAt: number): number {
	const expiresIn = payload.expires_in;
	if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
		return Date.now() + expiresIn * 1000;
	}
	for (const key of ["expires_at", "expires", "expired"] as const) {
		const parsed = parseTimeMs(payload[key]);
		if (parsed > 0) return parsed;
	}
	return currentExpiresAt > Date.now() ? currentExpiresAt : Date.now() + 60 * 60 * 1000;
}

async function refreshCodexAuth(auth: CodexAuth): Promise<CodexAuth> {
	let response: Response;
	try {
		response = await fetch(CODEX_OAUTH_TOKEN_URL, {
			method: "POST",
			headers: {
				accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				client_id: CODEX_OAUTH_CLIENT_ID,
				grant_type: "refresh_token",
				refresh_token: auth.refreshToken,
				scope: "openid profile email",
			}),
		});
	} catch (err) {
		throw new CodexAuthError(
			`Codex OAuth token refresh failed: ${(err as Error).message}. Run \`codex login\` to re-authorise.`,
		);
	}

	if (!response.ok) {
		const detail = await safeReadError(response);
		throw new CodexAuthError(
			`Codex OAuth token refresh failed (${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}). Run \`codex login\` to re-authorise.`,
		);
	}

	let payload: Record<string, unknown>;
	try {
		payload = (await response.json()) as Record<string, unknown>;
	} catch (err) {
		throw new CodexAuthError(
			`Codex OAuth token refresh returned invalid JSON: ${(err as Error).message}. Run \`codex login\` to re-authorise.`,
		);
	}

	const refreshed: CodexAuth = {
		...auth,
		accessToken: asString(payload.access_token) ?? asString(payload.access) ?? auth.accessToken,
		refreshToken: asString(payload.refresh_token) ?? asString(payload.refresh) ?? auth.refreshToken,
		expiresAt: refreshExpiryMs(payload, auth.expiresAt),
		accountId: asString(payload.account_id) ?? asString(payload.accountId) ?? auth.accountId,
	};
	if (!refreshed.accessToken || !refreshed.refreshToken || !refreshed.accountId) {
		throw new CodexAuthError("Codex OAuth token refresh response was incomplete. Run `codex login` to re-authorise.");
	}

	await persistRefreshedAuth(refreshed);
	return refreshed;
}

async function persistRefreshedAuth(auth: CodexAuth): Promise<void> {
	const { source } = auth;
	if (source.kind === "primary") {
		const current =
			source.raw["openai-codex"] && typeof source.raw["openai-codex"] === "object" && !Array.isArray(source.raw["openai-codex"])
				? (source.raw["openai-codex"] as Record<string, unknown>)
				: {};
		source.raw["openai-codex"] = {
			...current,
			type: current.type ?? "oauth",
			access: auth.accessToken,
			refresh: auth.refreshToken,
			expires: auth.expiresAt,
			accountId: auth.accountId,
		};
	} else {
		source.raw.access_token = auth.accessToken;
		source.raw.refresh_token = auth.refreshToken;
		source.raw.expired = new Date(auth.expiresAt).toISOString();
		source.raw.account_id = auth.accountId;
	}
	await fs.promises.writeFile(source.path, `${JSON.stringify(source.raw, null, 2)}\n`, "utf-8");
}

function normalizeOutputFormat(format: CodexImageOutputFormat | undefined): CodexImageOutputFormat {
	const value = (format ?? "png").toLowerCase();
	if (value === "png" || value === "jpeg" || value === "webp") return value;
	throw new Error(`Unsupported output_format "${format}". Use png, jpeg, or webp.`);
}

function normalizeSize(size: CodexImageSize | undefined): CodexImageSize {
	const value = size ?? "1024x1024";
	if (value === "1024x1024" || value === "1536x1024" || value === "1024x1536" || value === "auto") return value;
	throw new Error(`Unsupported size "${size}". Use 1024x1024, 1536x1024, 1024x1536, or auto.`);
}

export function mimeTypeForOutputFormat(format: CodexImageOutputFormat): string {
	return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}

function resolveUserPath(rawPath: string, cwd: string): string {
	if (rawPath === "~") return os.homedir();
	if (rawPath.startsWith(`~${path.sep}`) || rawPath.startsWith("~/")) {
		return path.join(os.homedir(), rawPath.slice(2));
	}
	return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

function mimeTypeForInputImage(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".png") return "image/png";
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".webp") return "image/webp";
	throw new Error(`Unsupported input image type for ${filePath}. Use png, jpg/jpeg, or webp.`);
}

async function loadInputImages(imagePaths: string[] | undefined, cwd: string): Promise<Array<{ type: "input_image"; image_url: string }>> {
	const result: Array<{ type: "input_image"; image_url: string }> = [];
	for (const rawPath of imagePaths ?? []) {
		const filePath = resolveUserPath(rawPath, cwd);
		const mimeType = mimeTypeForInputImage(filePath);
		const bytes = await fs.promises.readFile(filePath);
		result.push({ type: "input_image", image_url: `data:${mimeType};base64,${bytes.toString("base64")}` });
	}
	return result;
}

function modelName(): string {
	return process.env.CODEX_IMAGE_BASE_MODEL || DEFAULT_CODEX_IMAGE_BASE_MODEL;
}

function buildRequestBody(
	prompt: string,
	inputImages: Array<{ type: "input_image"; image_url: string }>,
	size: CodexImageSize,
	outputFormat: CodexImageOutputFormat,
) {
	const tool: Record<string, unknown> = { type: "image_generation", output_format: outputFormat };
	if (size !== "auto") tool.size = size;

	return {
		model: modelName(),
		instructions: "You are an image generation assistant.",
		input: [
			{
				role: "user",
				content: [{ type: "input_text", text: prompt }, ...inputImages],
			},
		],
		stream: true,
		store: false,
		reasoning: { effort: "low", summary: "auto" },
		include: ["reasoning.encrypted_content"],
		parallel_tool_calls: true,
		tools: [tool],
		tool_choice: { type: "image_generation" },
	};
}

function buildHeaders(auth: CodexAuth): Record<string, string> {
	return {
		Authorization: `Bearer ${auth.accessToken}`,
		"chatgpt-account-id": auth.accountId,
		"OpenAI-Beta": "responses=experimental",
		originator: "codex_cli_rs",
		session_id: crypto.randomUUID(),
		accept: "text/event-stream",
		"Content-Type": "application/json",
		"user-agent": process.env.CODEX_IMAGE_USER_AGENT || DEFAULT_USER_AGENT,
	};
}

function stripDataUrl(base64OrDataUrl: string): string {
	const trimmed = base64OrDataUrl.trim();
	const match = trimmed.match(/^data:[^;]+;base64,(.*)$/s);
	return (match ? match[1] : trimmed).replace(/\s+/g, "");
}

async function saveImage(bytes: Buffer, outputFormat: CodexImageOutputFormat, outputPath: string | undefined, cwd: string): Promise<string> {
	const targetPath = outputPath
		? resolveUserPath(outputPath, cwd)
		: path.join(
				resolveUserPath(process.env.CODEX_IMAGE_OUTPUT_DIR || "generated-images", cwd),
				`img-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}.${outputFormat}`,
			);
	await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
	await fs.promises.writeFile(targetPath, bytes);
	return targetPath;
}

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

async function safeReadError(response: Response): Promise<string> {
	try {
		const raw = await response.text();
		try {
			const parsed = JSON.parse(raw);
			const err = parsed.error;
			if (typeof err === "string") return err.slice(0, 500);
			if (err && typeof err === "object") {
				const message = (err as Record<string, unknown>).message;
				if (typeof message === "string") return message.slice(0, 500);
			}
			if (typeof parsed.message === "string") return parsed.message.slice(0, 500);
		} catch {
			/* raw text fallback */
		}
		return raw.slice(0, 500);
	} catch {
		return "";
	}
}

function errorMessage(value: unknown): string {
	if (typeof value === "string") return value;
	if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		if (typeof obj.message === "string") return obj.message;
		if (typeof obj.code === "string") return obj.code;
		try {
			return JSON.stringify(obj);
		} catch {
			return String(obj);
		}
	}
	return String(value ?? "unknown error");
}

interface ImageResponsesEvent {
	type?: string;
	message?: string;
	code?: string | null;
	delta?: string;
	partial_image?: unknown;
	partialImage?: unknown;
	item?: Record<string, unknown>;
	response?: {
		output?: Array<Record<string, unknown>>;
		usage?: unknown;
		error?: unknown;
		status?: string;
	};
	error?: unknown;
	[key: string]: unknown;
}

interface ImageRunState {
	base64?: string;
	revisedPrompt?: string;
	usage?: unknown;
	partialImageCount: number;
}

function extractString(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		for (const key of ["b64", "base64", "data", "image", "image_base64"] as const) {
			const nested = obj[key];
			if (typeof nested === "string" && nested.length > 0) return nested;
		}
	}
	return undefined;
}

function extractPartialImage(event: ImageResponsesEvent): string | undefined {
	return (
		extractString(event.partial_image) ??
		extractString(event.partialImage) ??
		extractString(event.image) ??
		extractString(event.data) ??
		extractString(event.item?.partial_image)
	);
}

function ingestImageItem(item: Record<string, unknown> | undefined, state: ImageRunState): void {
	if (!item || item.type !== "image_generation_call") return;
	const result = item.result;
	if (typeof result === "string" && result.trim()) state.base64 = stripDataUrl(result);
	const revisedPrompt = item.revised_prompt ?? item.revisedPrompt;
	if (typeof revisedPrompt === "string" && revisedPrompt.trim()) state.revisedPrompt = revisedPrompt;
}

function raiseImageError(message: string): never {
	if (isTransientMessage(message)) throw new TransientCodexImageError(`Codex image backend busy: ${message}`);
	throw new Error(`Codex image backend error: ${message}`);
}

function handleImageEvent(event: ImageResponsesEvent, state: ImageRunState, opts: CodexImageRequestOptions, attempt: number): void {
	if (event.type === "error") raiseImageError(event.message || event.code || "unknown error");
	const err = event.error ?? event.response?.error;
	if (err) raiseImageError(errorMessage(err));
	if (event.type === "response.failed") raiseImageError("response failed");

	if (event.type === "response.output_item.done") {
		ingestImageItem(event.item, state);
		return;
	}

	if (event.type === "response.image_generation_call.partial_image") {
		state.partialImageCount++;
		opts.onProgress?.({
			phase: "partial_image",
			attempt,
			partialImageCount: state.partialImageCount,
			partialImage: extractPartialImage(event),
		});
		return;
	}

	if (event.type === "response.completed" || event.type === "response.done") {
		if (event.response?.usage) state.usage = event.response.usage;
		for (const item of event.response?.output ?? []) ingestImageItem(item, state);
	}
}

async function consumeSSE(
	body: ReadableStream<Uint8Array>,
	onEvent: (event: ImageResponsesEvent) => void,
	signal?: AbortSignal,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const findSeparator = (): { index: number; length: number } | null => {
		const candidates = [
			{ index: buffer.indexOf("\r\n\r\n"), length: 4 },
			{ index: buffer.indexOf("\n\n"), length: 2 },
			{ index: buffer.indexOf("\r\r"), length: 2 },
		].filter((candidate) => candidate.index !== -1);
		if (!candidates.length) return null;
		return candidates.sort((a, b) => a.index - b.index)[0];
	};

	const flushBlock = (block: string) => {
		const dataLines: string[] = [];
		for (const line of block.split(/\r?\n/)) {
			const trimmed = line.replace(/\r$/, "");
			if (trimmed.startsWith("data:")) dataLines.push(trimmed.slice(5).trimStart());
		}
		if (!dataLines.length) return;
		const payload = dataLines.join("\n").trim();
		if (!payload || payload === "[DONE]") return;
		try {
			onEvent(JSON.parse(payload) as ImageResponsesEvent);
		} catch {
			// Ignore malformed non-JSON keepalive/comment payloads.
		}
	};

	try {
		while (true) {
			if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let sep: { index: number; length: number } | null;
			while ((sep = findSeparator())) {
				const block = buffer.slice(0, sep.index);
				buffer = buffer.slice(sep.index + sep.length);
				flushBlock(block);
			}
		}
		buffer += decoder.decode();
		if (buffer.trim()) flushBlock(buffer);
	} finally {
		reader.releaseLock();
	}
}

async function runCodexImageOnce(
	opts: CodexImageRequestOptions & { images?: string[] },
	signal: AbortSignal,
	attempt: number,
): Promise<CodexImageResult> {
	const cwd = opts.cwd ?? process.cwd();
	const prompt = opts.prompt?.trim();
	if (!prompt) throw new Error("Codex image generation requires a non-empty prompt.");
	const outputFormat = normalizeOutputFormat(opts.outputFormat);
	const size = normalizeSize(opts.size);
	const inputImages = await loadInputImages(opts.images, cwd);
	const auth = await resolveCodexAuth();
	const body = JSON.stringify(buildRequestBody(prompt, inputImages, size, outputFormat));

	let response: Response;
	try {
		response = await fetch(CODEX_IMAGE_RESPONSES_URL, {
			method: "POST",
			headers: buildHeaders(auth),
			body,
			signal,
		});
	} catch (err) {
		if ((err as Error)?.name === "AbortError") throw err;
		throw new TransientCodexImageError(`Codex image request failed: ${(err as Error).message}`);
	}

	if (!response.ok || !response.body) {
		const detail = await safeReadError(response);
		const msg = `Codex image backend returned ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`;
		if (response.status === 401 || response.status === 403) {
			throw new CodexAuthError(`${msg}. Run \`codex login\` to re-authorise.`);
		}
		if (response.status === 429 || response.status >= 500 || isTransientMessage(detail)) {
			throw new TransientCodexImageError(msg);
		}
		throw new Error(msg);
	}

	const state: ImageRunState = { partialImageCount: 0 };
	await consumeSSE(response.body, (event) => handleImageEvent(event, state, opts, attempt), signal);
	if (!state.base64) throw new Error("Codex image backend completed without an image_generation_call result.");

	const bytes = Buffer.from(state.base64, "base64");
	if (bytes.length === 0) throw new Error("Codex image backend returned an empty image result.");
	const savedPath = await saveImage(bytes, outputFormat, opts.outputPath, cwd);

	return {
		base64: state.base64,
		bytes: bytes.length,
		mimeType: mimeTypeForOutputFormat(outputFormat),
		savedPath,
		model: modelName(),
		size,
		outputFormat,
		revisedPrompt: state.revisedPrompt,
		usage: state.usage,
		partialImageCount: state.partialImageCount,
	};
}

async function runWithDeadlineAndRetry(opts: CodexImageRequestOptions & { images?: string[] }): Promise<CodexImageResult> {
	const attempts = Math.max(1, MAX_ATTEMPTS);
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
				return await runCodexImageOnce(opts, signal, attempt);
			} catch (err) {
				if ((err as Error)?.name === "AbortError") {
					if (deadlineHit) throw new Error(`Codex image request timed out after ${DEADLINE_MS}ms.`);
					throw err;
				}
				if (err instanceof CodexAuthError) throw err;
				lastErr = err as Error;
				const transient = err instanceof TransientCodexImageError || isTransientMessage((err as Error).message);
				if (!transient || attempt === attempts) throw err;
				opts.onProgress?.({ phase: "retrying", attempt });
				const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 400);
				await sleep(delay, signal);
			}
		}
		throw lastErr ?? new Error("Codex image request failed");
	} finally {
		if (timer) clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onOuterAbort);
	}
}

export async function runCodexImageGenerate(opts: CodexImageRequestOptions): Promise<CodexImageResult> {
	return runWithDeadlineAndRetry(opts);
}

export async function runCodexImageEdit(opts: CodexImageEditOptions): Promise<CodexImageResult> {
	if (!opts.images?.length) throw new Error("Codex image edit requires at least one input image path.");
	return runWithDeadlineAndRetry({ ...opts, images: opts.images });
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUsage(usage: unknown): string | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const obj = usage as Record<string, unknown>;
	const input = obj.input_tokens ?? obj.prompt_tokens;
	const output = obj.output_tokens ?? obj.completion_tokens;
	const total = obj.total_tokens;
	const parts: string[] = [];
	if (typeof input === "number") parts.push(`input ${input}`);
	if (typeof output === "number") parts.push(`output ${output}`);
	if (typeof total === "number") parts.push(`total ${total}`);
	if (parts.length) return parts.join(", ");
	try {
		return JSON.stringify(usage);
	} catch {
		return undefined;
	}
}

export function formatCodexImageSummary(result: CodexImageResult): string {
	const lines = [
		`Saved image: ${result.savedPath}`,
		`Model: ${result.model}`,
		`Requested size: ${result.size}`,
		`Format: ${result.outputFormat} (${result.mimeType})`,
		`Image bytes: ${formatBytes(result.bytes)}`,
	];
	if (result.revisedPrompt) lines.push(`Revised prompt: ${result.revisedPrompt}`);
	const usage = formatUsage(result.usage);
	if (usage) lines.push(`Token usage: ${usage}`);
	if (result.partialImageCount > 0) lines.push(`Partial image updates: ${result.partialImageCount}`);
	return lines.join("\n");
}
