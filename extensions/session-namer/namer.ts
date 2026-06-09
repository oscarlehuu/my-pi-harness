import * as fs from "node:fs";
import * as path from "node:path";

// NOTE: keep the @earendil-works/pi-coding-agent dependency LAZY (dynamic import inside
// loadProxyConfig) so the pure helpers above remain importable by the standalone smoke test
// from the repo root, where the globally-installed pi package does not resolve.

export interface ConvoMessage {
	role?: string;
	content?: unknown;
}

interface ProxyConfig {
	baseUrl: string;
	apiKey?: string;
	model: string;
}

export function messageText(message: ConvoMessage): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text: string } => {
			if (!block || typeof block !== "object") return false;
			const typed = block as { type?: unknown; text?: unknown };
			return typed.type === "text" && typeof typed.text === "string";
		})
		.map((block) => block.text)
		.join("");
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

const EDGE_DECORATION_RE = /^[\s"'“”‘’`*_#]+|[\s"'“”‘’`*_#]+$/g;
const TRAILING_PUNCTUATION_RE = /[.;:,!?]+$/g;

function stripTitleEdges(value: string): string {
	let title = value;
	let previous: string;
	do {
		previous = title;
		title = title.replace(EDGE_DECORATION_RE, "").replace(TRAILING_PUNCTUATION_RE, "").trim();
	} while (title !== previous);
	return title;
}

export function buildConversationPrompt(messages: ReadonlyArray<ConvoMessage>): string | null {
	const userText = messages
		.filter((message) => message.role === "user")
		.map((message) => messageText(message).trim())
		.find((text) => text.length > 0);
	if (!userText) return null;

	const assistantText = messages
		.filter((message) => message.role === "assistant")
		.map((message) => messageText(message).trim())
		.find((text) => text.length > 0);

	const parts = [`First user message:\n${clip(userText, 1200)}`];
	if (assistantText) parts.push(`Assistant reply:\n${clip(assistantText, 800)}`);
	return parts.join("\n\n");
}

export function sanitizeTitle(raw: string): string | null {
	let title = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!title) return null;

	title = stripTitleEdges(title).replace(/\s+/g, " ").trim();
	if (!title) return null;

	if (title.length > 60) {
		let cut = title.slice(0, 60).trimEnd();
		const lastSpace = cut.lastIndexOf(" ");
		if (lastSpace > 0) cut = cut.slice(0, lastSpace);
		title = stripTitleEdges(cut);
	}

	return title || null;
}

function modelId(model: unknown): string | null {
	if (typeof model === "string") return model;
	if (!model || typeof model !== "object") return null;
	const id = (model as { id?: unknown }).id;
	return typeof id === "string" && id.trim() ? id.trim() : null;
}

function providerList(modelsConfig: unknown): Array<Record<string, unknown>> {
	const providers = (modelsConfig as { providers?: unknown } | null)?.providers;
	if (Array.isArray(providers)) return providers.filter((provider) => provider && typeof provider === "object") as Array<Record<string, unknown>>;
	if (!providers || typeof providers !== "object") return [];
	return Object.values(providers).filter((provider) => provider && typeof provider === "object") as Array<Record<string, unknown>>;
}

function hasUsableProvider(provider: Record<string, unknown>): boolean {
	return typeof provider.baseUrl === "string" && provider.baseUrl.trim().length > 0 && Array.isArray(provider.models) && provider.models.length > 0;
}

async function loadProxyConfig(): Promise<ProxyConfig | null> {
	try {
		const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
		const configPath = path.join(getAgentDir(), "models.json");
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
		const providers = providerList(parsed);
		const provider =
			providers.find((candidate) => candidate.api === "openai-completions" && hasUsableProvider(candidate)) ??
			providers.find(hasUsableProvider);
		if (!provider) return null;

		const ids = (provider.models as unknown[]).map(modelId).filter((id): id is string => Boolean(id));
		if (!ids.length) return null;

		const override = process.env.SESSION_NAMER_MODEL?.trim();
		const model = override && ids.includes(override) ? override : ids.find((id) => /flash|mini|haiku|small|low/i.test(id)) ?? ids[0];
		const baseUrl = (provider.baseUrl as string).trim().replace(/\/+$/g, "");
		const apiKey = typeof provider.apiKey === "string" && provider.apiKey.trim() ? provider.apiKey.trim() : undefined;
		return baseUrl && model ? { baseUrl, apiKey, model } : null;
	} catch {
		return null;
	}
}

export async function generateTitle(messages: ReadonlyArray<ConvoMessage>, signal?: AbortSignal): Promise<string | null> {
	try {
		const prompt = buildConversationPrompt(messages);
		if (!prompt) return null;

		const config = await loadProxyConfig();
		if (!config) return null;

		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

		const res = await fetch(`${config.baseUrl}/chat/completions`, {
			method: "POST",
			headers,
			signal,
			body: JSON.stringify({
				model: config.model,
				messages: [
					{
						role: "system",
						content: "Write one meaningful 3-6 word Title Case session display title. Return only the title: no quotes, punctuation, preamble, or explanation.",
					},
					{ role: "user", content: prompt },
				],
				max_tokens: 256,
				temperature: 0.3,
				stream: false,
			}),
		});
		if (!res.ok) return null;

		const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
		const content = data.choices?.[0]?.message?.content;
		return typeof content === "string" ? sanitizeTitle(content) : null;
	} catch {
		return null;
	}
}
