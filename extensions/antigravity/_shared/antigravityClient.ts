/**
 * Antigravity image client — reverse-engineered from the `agy` CLI.
 *
 * Antigravity CLI v1.0.3 exposes an internal `generate_image` tool with
 * `Prompt` and optional `ImagePaths` parameters. The planner model shown by
 * agy ("Gemini 3.5 Flash") only decides when to call that tool; the actual
 * image backend is Gemini flash-image, currently `gemini-3.1-flash-image`
 * (nano-banana). We do not call agy directly here. Instead we use the user's
 * already-running cli-proxy-api on localhost:8317, which holds the Antigravity
 * Google OAuth credentials and exposes an OpenAI-compatible
 * `/v1/chat/completions` endpoint.
 *
 * The image bytes are returned in `choices[].message.images[].image_url.url` as
 * data URIs. Image edits send reference images as standard OpenAI multimodal
 * `image_url` content parts; local files are encoded to data URIs, while data:
 * URIs and http(s) URLs pass through unchanged.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const ANTIGRAVITY_IMAGE_MODEL = "gemini-3.1-flash-image";

const DEFAULT_IMAGE_PREFIX = "antigravity-image";
const DEFAULT_BASE_URL = "http://localhost:8317/v1";
const MISSING_KEY_MESSAGE = "cli-proxy-api key not found: set ANTIGRAVITY_API_KEY or run cli-proxy-api on :8317";
const MAX_ATTEMPTS = Number(process.env.PI_IMAGINE_MAX_ATTEMPTS ?? 4);
const BASE_BACKOFF_MS = Number(process.env.PI_IMAGINE_BACKOFF_MS ?? 1500);

type ReasoningEffort = "low" | "medium" | "high";

export interface AntigravityAuth {
	baseUrl: string;
	apiKey: string;
}

export class AntigravityAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AntigravityAuthError";
	}
}

export interface AntigravityProgress {
	phase: "requesting" | "retrying";
	attempt?: number;
}

export interface GeneratedImageAsset {
	b64: string;
	bytes: Buffer;
	mimeType: string;
	ext: string;
	path: string;
}

export interface ImageGenerationResult {
	images: GeneratedImageAsset[];
	usage?: unknown;
	model: string;
	baseUrl: string;
}

export interface GenerateImageOptions {
	prompt: string;
	n?: number;
	model?: string;
	reasoningEffort?: ReasoningEffort;
	output?: string;
	/** Base directory for resolving relative local image paths. */
	cwd?: string;
	signal?: AbortSignal;
	onProgress?: (progress: AntigravityProgress) => void;
}

export interface EditImageOptions extends Omit<GenerateImageOptions, "n"> {
	image: string | string[];
}

interface ChatCompletionImage {
	type?: string;
	image_url?: { url?: string };
	url?: string;
	b64_json?: string;
	mime_type?: string;
}

interface ChatCompletionResponse {
	choices?: Array<{
		message?: {
			content?: unknown;
			images?: ChatCompletionImage[];
		};
	}>;
	usage?: unknown;
}

interface ParsedImageData {
	b64: string;
	bytes: Buffer;
	mimeType: string;
	ext: string;
}

interface ParsedImageResponse {
	response: ChatCompletionResponse;
	images: ParsedImageData[];
}

class TransientAntigravityError extends Error {}

const TRANSIENT_PATTERNS = [
	/temporarily unavailable/i,
	/too many requests/i,
	/resource has been exhausted/i,
	/rate.?limit/i,
	/timeout/i,
	/overloaded/i,
	/service.?unavailable/i,
	/\b(429|502|503|504)\b/,
];

function isTransientMessage(msg: string): boolean {
	return TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

export function resolveAntigravityAuth(): AntigravityAuth {
	const baseUrl = stripTrailingSlash(process.env.ANTIGRAVITY_BASE_URL || process.env.PI_CLIPROXY_BASE_URL || DEFAULT_BASE_URL);
	const apiKey =
		trimNonEmpty(process.env.ANTIGRAVITY_API_KEY) ??
		trimNonEmpty(process.env.CLIPROXY_API_KEY) ??
		readCliProxyApiKey() ??
		readPiCliproxyApiKey();

	if (!apiKey) throw new AntigravityAuthError(MISSING_KEY_MESSAGE);
	return { baseUrl, apiKey };
}

/** Resolve the configured output directory shared with Grok Imagine tools. */
export function outputDir(): string {
	return expandHome(process.env.PI_IMAGINE_OUTPUT_DIR || path.join(os.homedir(), ".pi", ".generated"));
}

function stripTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "") || DEFAULT_BASE_URL;
}

function trimNonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function readCliProxyApiKey(): string | undefined {
	const configPath = path.join(os.homedir(), "cliproxyapi", "config.yaml");
	let raw: string;
	try {
		raw = fs.readFileSync(configPath, "utf-8");
	} catch {
		return undefined;
	}
	return firstYamlApiKey(raw);
}

function firstYamlApiKey(raw: string): string | undefined {
	const lines = raw.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const top = line.match(/^(\s*)api-keys\s*:\s*(.*)$/);
		if (!top) continue;

		const inline = top[2].replace(/\s+#.*$/, "").trim();
		const inlineList = inline.match(/^\[(.*)\]$/);
		if (inlineList) return unquote(inlineList[1].split(",")[0]);
		if (inline && inline !== "[]") return unquote(inline);

		const baseIndent = top[1].length;
		for (let j = i + 1; j < lines.length; j++) {
			const candidate = lines[j];
			if (!candidate.trim() || candidate.trimStart().startsWith("#")) continue;
			const indent = candidate.match(/^\s*/)?.[0].length ?? 0;
			if (indent <= baseIndent) break;

			const item = candidate.match(/^\s*-\s*(.*)$/);
			if (!item) continue;
			const value = item[1].replace(/\s+#.*$/, "").trim();
			if (!value) continue;
			const keyValue = value.match(/^(?:key|apiKey|api_key)\s*:\s*(.+)$/);
			return unquote(keyValue?.[1] ?? value);
		}
	}
	return undefined;
}

function unquote(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const unquoted = trimmed.replace(/^["']|["']$/g, "").trim();
	return unquoted || undefined;
}

function readPiCliproxyApiKey(): string | undefined {
	const modelsPath = path.join(os.homedir(), ".pi", "agent", "models.json");
	try {
		const parsed = JSON.parse(fs.readFileSync(modelsPath, "utf-8"));
		return trimNonEmpty(parsed?.providers?.cliproxy?.apiKey);
	} catch {
		return undefined;
	}
}

function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith(`~${path.sep}`) || p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
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

/**
 * Resolve an image reference for Antigravity image editing. data: and http(s)
 * URLs pass through untouched; local filesystem paths are read and encoded as
 * data URIs.
 */
export async function resolveImageRef(pathOrDataUriOrUrl: string, cwd = process.cwd()): Promise<string> {
	const ref = pathOrDataUriOrUrl.trim();
	if (!ref) throw new Error("image reference is empty");
	if (/^data:[^,]+,/i.test(ref)) return ref;
	if (/^https?:\/\//i.test(ref)) return ref;

	const filePath = path.isAbsolute(expandHome(ref)) ? expandHome(ref) : path.resolve(cwd, expandHome(ref));
	const bytes = await fsp.readFile(filePath);
	const mimeType = inferImageMimeType(filePath, bytes);
	return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Save generated bytes to the configured output directory. */
export async function saveAsset(bytes: Uint8Array, ext: string, name?: string): Promise<string> {
	const dir = outputDir();
	await fsp.mkdir(dir, { recursive: true });
	const normalizedExt = normalizeExt(ext);
	const filename = name ? sanitizeOutputName(name, normalizedExt) : defaultName(DEFAULT_IMAGE_PREFIX, normalizedExt);
	const dest = path.join(dir, filename);
	await fsp.writeFile(dest, bytes);
	return dest;
}

/** Download a generated asset URL to disk. */
export async function downloadToFile(url: string, dest: string, signal?: AbortSignal): Promise<string> {
	const response = await fetch(url, { signal });
	if (!response.ok) {
		const detail = await safeReadError(response);
		throw new Error(`download failed: ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`);
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	await fsp.mkdir(path.dirname(dest), { recursive: true });
	await fsp.writeFile(dest, bytes);
	return dest;
}

export async function generateImage(opts: GenerateImageOptions): Promise<ImageGenerationResult> {
	const prompt = opts.prompt?.trim();
	if (!prompt) throw new Error("prompt is required");
	const n = normalizeCount(opts.n);
	const model = normalizeModel(opts.model);
	const reasoningEffort = normalizeReasoningEffort(opts.reasoningEffort);
	const auth = resolveAntigravityAuth();
	const images: GeneratedImageAsset[] = [];
	let usage: unknown;

	while (images.length < n) {
		const { response, images: parsed } = await fetchImagesWithRetry(auth, {
			model,
			reasoning_effort: reasoningEffort,
			messages: [{ role: "user", content: prompt }],
		}, opts.signal, opts.onProgress);
		usage = response.usage ?? usage;
		for (const image of parsed) {
			if (images.length >= n) break;
			const name = opts.output ? indexedName(opts.output, images.length, n, image.ext) : undefined;
			const filePath = await saveAsset(image.bytes, image.ext, name);
			images.push({ ...image, path: filePath });
		}
	}

	return { images, usage, model, baseUrl: auth.baseUrl };
}

export async function editImage(opts: EditImageOptions): Promise<ImageGenerationResult> {
	const prompt = opts.prompt?.trim();
	if (!prompt) throw new Error("prompt is required");
	const refs = Array.isArray(opts.image) ? opts.image : [opts.image];
	if (!refs.length) throw new Error("at least one image is required");
	if (refs.length > 3) throw new Error("antigravity-image-edit accepts at most 3 input images");

	const model = normalizeModel(opts.model);
	const reasoningEffort = normalizeReasoningEffort(opts.reasoningEffort);
	const imageRefs = await Promise.all(refs.map((ref) => resolveImageRef(ref, opts.cwd)));
	const auth = resolveAntigravityAuth();
	const content = [
		{ type: "text", text: prompt },
		...imageRefs.map((url) => ({ type: "image_url", image_url: { url } })),
	];
	const { response, images: parsed } = await fetchImagesWithRetry(auth, {
		model,
		reasoning_effort: reasoningEffort,
		messages: [{ role: "user", content }],
	}, opts.signal, opts.onProgress);
	const images: GeneratedImageAsset[] = [];
	for (let i = 0; i < parsed.length; i++) {
		const image = parsed[i];
		const name = opts.output ? indexedName(opts.output, i, parsed.length, image.ext) : undefined;
		const filePath = await saveAsset(image.bytes, image.ext, name);
		images.push({ ...image, path: filePath });
	}

	return { images, usage: response.usage, model, baseUrl: auth.baseUrl };
}

async function fetchImagesWithRetry(
	auth: AntigravityAuth,
	body: unknown,
	signal?: AbortSignal,
	onProgress?: (progress: AntigravityProgress) => void,
): Promise<ParsedImageResponse> {
	return fetchJsonWithRetry<ChatCompletionResponse, ParsedImageResponse>(auth, body, signal, onProgress, (response, _attempt, attempts) => {
		const images = parseChatCompletionImages(response);
		if (!images.length) throw new TransientAntigravityError(noImageAfterAttemptsMessage(attempts));
		return { response, images };
	});
}

async function fetchJsonWithRetry<T, R = T>(
	auth: AntigravityAuth,
	body: unknown,
	signal?: AbortSignal,
	onProgress?: (progress: AntigravityProgress) => void,
	transform?: (json: T, attempt: number, attempts: number) => R,
): Promise<R> {
	const attempts = Math.max(1, MAX_ATTEMPTS);
	let lastErr: Error | undefined;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			onProgress?.({ phase: "requesting", attempt });
			const response = await fetch(`${auth.baseUrl}/chat/completions`, {
				method: "POST",
				headers: buildAuthHeaders(auth),
				body: JSON.stringify(body),
				signal,
			});
			if (!response.ok) {
				const detail = await safeReadError(response);
				const msg = `Antigravity proxy returned ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`;
				if (response.status === 401 || response.status === 403) throw new AntigravityAuthError(`Antigravity proxy auth failed: ${msg}`);
				if (response.status === 429 || response.status >= 500 || isTransientMessage(detail)) {
					throw new TransientAntigravityError(msg);
				}
				throw new Error(msg);
			}
			const json = (await response.json()) as T;
			return transform ? transform(json, attempt, attempts) : (json as unknown as R);
		} catch (err) {
			if ((err as Error)?.name === "AbortError") throw err;
			if (err instanceof AntigravityAuthError) throw err;
			lastErr = err instanceof TypeError ? new TransientAntigravityError(`Antigravity proxy request failed: ${err.message}`) : (err as Error);
			const transient = lastErr instanceof TransientAntigravityError || isTransientMessage(lastErr.message);
			if (!transient || attempt === attempts) throw lastErr;
			onProgress?.({ phase: "retrying", attempt });
			const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 400);
			await sleep(delay, signal);
		}
	}
	throw lastErr ?? new Error("Antigravity proxy request failed");
}

function buildAuthHeaders(auth: AntigravityAuth): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${auth.apiKey}`,
	};
}

function parseChatCompletionImages(response: ChatCompletionResponse): ParsedImageData[] {
	const items = response.choices?.flatMap((choice) => choice.message?.images ?? []) ?? [];
	if (!items.length) return [];

	return items.map((item, index) => {
		const dataUri = item.image_url?.url ?? item.url;
		if (dataUri) return parseDataUriImage(dataUri, index);
		if (item.b64_json) {
			const mimeType = item.mime_type || "image/jpeg";
			const ext = extFromMime(mimeType);
			const b64 = item.b64_json.replace(/\s+/g, "");
			const bytes = Buffer.from(b64, "base64");
			if (!bytes.length) throw new Error(`Antigravity image item ${index + 1} returned empty b64_json`);
			return { b64, bytes, mimeType, ext };
		}
		throw new Error(`Antigravity image item ${index + 1} missing image_url data URI`);
	});
}

function parseDataUriImage(dataUri: string, index: number): ParsedImageData {
	const match = dataUri.trim().match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/is);
	if (!match) throw new Error(`Antigravity image item ${index + 1} was not a base64 data URI`);
	const mimeType = match[1].trim().toLowerCase() || "image/jpeg";
	const b64 = match[2].replace(/\s+/g, "");
	const bytes = Buffer.from(b64, "base64");
	if (!bytes.length) throw new Error(`Antigravity image item ${index + 1} returned empty image bytes`);
	return { b64, bytes, mimeType, ext: extFromMime(mimeType) };
}

async function safeReadError(response: Response): Promise<string> {
	try {
		const raw = await response.text();
		try {
			const parsed = JSON.parse(raw);
			const err = parsed.error || parsed.message;
			return typeof err === "string" ? err : JSON.stringify(err || parsed).slice(0, 400);
		} catch {
			return raw.slice(0, 400);
		}
	} catch {
		return "";
	}
}

function normalizeCount(n: number | undefined): number {
	const value = n ?? 1;
	if (!Number.isInteger(value) || value < 1 || value > 10) throw new Error("n must be an integer from 1 to 10");
	return value;
}

function normalizeModel(model: string | undefined): string {
	return model?.trim() || ANTIGRAVITY_IMAGE_MODEL;
}

function normalizeReasoningEffort(reasoningEffort: ReasoningEffort | undefined): ReasoningEffort {
	const value = reasoningEffort ?? "low";
	if (value === "low" || value === "medium" || value === "high") return value;
	throw new Error("reasoning_effort must be low, medium, or high");
}

function noImageAfterAttemptsMessage(attempts: number): string {
	return `Antigravity returned no image after ${attempts} attempt${attempts === 1 ? "" : "s"} (model may have only returned reasoning); try a more explicit prompt or reasoning_effort=low`;
}

function normalizeExt(ext: string): string {
	return ext.replace(/^\.+/, "").toLowerCase() || "bin";
}

function sanitizeOutputName(name: string, ext: string): string {
	const base = path.basename(name.trim() || defaultName(DEFAULT_IMAGE_PREFIX, ext));
	const safe = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || defaultName(DEFAULT_IMAGE_PREFIX, ext);
	const withoutExt = safe.replace(/\.[^.]*$/, "");
	return `${withoutExt || defaultName(DEFAULT_IMAGE_PREFIX, ext)}.${normalizeExt(ext)}`;
}

function indexedName(name: string, index: number, total: number, ext: string): string {
	const sanitized = sanitizeOutputName(name, ext);
	if (total <= 1) return sanitized;
	const stem = sanitized.replace(/\.[^.]*$/, "");
	return `${stem}-${index + 1}.${normalizeExt(ext)}`;
}

function defaultName(prefix: string, ext: string): string {
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const rand = Math.random().toString(36).slice(2, 8);
	return `${prefix}-${ts}-${rand}.${normalizeExt(ext)}`;
}

function extFromMime(mimeType: string): string {
	const normalized = mimeType.split(";")[0].trim().toLowerCase();
	switch (normalized) {
		case "image/jpeg":
		case "image/jpg":
			return "jpg";
		case "image/png":
			return "png";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		case "video/mp4":
			return "mp4";
		default:
			return normalized.split("/").pop()?.replace(/[^a-z0-9]/g, "") || "bin";
	}
}

function inferImageMimeType(filePath: string, bytes: Uint8Array): string {
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
	if (
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return "image/webp";
	}

	switch (path.extname(filePath).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".png":
			return "image/png";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		default:
			throw new Error(`unsupported image file type for ${filePath}; expected jpg, png, gif, or webp`);
	}
}
