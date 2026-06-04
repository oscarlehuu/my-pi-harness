/**
 * pi session transcript reader.
 *
 * The high-signal source for continual learning is the MAIN session — the founder<->CTO chat where
 * preferences and corrections surface — stored as JSONL under `~/.pi/agent/sessions/--<cwd>--/`.
 * Each line is a session entry `{ type, message, ... }`; we keep only the conversational substance
 * (user text + assistant text) and drop tool noise, thinking, and images to produce a compact digest
 * the updater subagent can mine cheaply.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface SessionLocation {
	/** Directory holding this cwd's session JSONL files. */
	dir: string;
	/** The cwd-slug pi uses (`/` -> `-`, wrapped in `--`). */
	slug: string;
}

/**
 * Replicate pi's session-dir slug exactly (session-manager.ts `getDefaultSessionDirPath`):
 * resolve cwd, strip a single leading separator, replace `/ \ :` with `-`, wrap in `--`.
 */
export function sessionSlugForCwd(cwd: string): string {
	const normalized = path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	return `--${normalized}--`;
}

export function sessionLocationForCwd(agentDir: string, cwd: string): SessionLocation {
	const slug = sessionSlugForCwd(cwd);
	return { dir: path.join(agentDir, "sessions", slug), slug };
}

export interface TranscriptFileStat {
	path: string;
	mtimeMs: number;
}

/** List every session JSONL for a cwd with its mtime, newest first. Missing dir -> []. */
export function listSessionTranscripts(dir: string): TranscriptFileStat[] {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const stats: TranscriptFileStat[] = [];
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const full = path.join(dir, name);
		try {
			const stat = fs.statSync(full);
			if (stat.isFile()) stats.push({ path: full, mtimeMs: stat.mtimeMs });
		} catch {
			// File vanished between readdir and stat; skip.
		}
	}
	return stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
			const text = (block as Record<string, unknown>).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("\n");
}

export interface DigestTurn {
	role: "user" | "assistant";
	text: string;
}

export interface TranscriptDigest {
	path: string;
	turns: DigestTurn[];
}

const MAX_TURN_CHARS = 4000;

function clip(text: string, max: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max)}…[clipped]`;
}

/**
 * Read one session JSONL into a compact digest of user/assistant text turns. Tool calls, tool
 * results, thinking blocks, images, and system/meta entries are intentionally dropped — they're
 * mechanical noise for preference/fact extraction and balloon the updater's context.
 */
export function digestTranscript(filePath: string): TranscriptDigest {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch {
		return { path: filePath, turns: [] };
	}
	const turns: DigestTurn[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (entry.type && entry.type !== "message") continue;
		const message = (entry.message ?? entry) as Record<string, unknown>;
		const role = message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = clip(textFromContent(message.content), MAX_TURN_CHARS);
		if (text) turns.push({ role, text });
	}
	return { path: filePath, turns };
}

/** Render a digest as plain transcript text for the updater prompt. */
export function renderDigest(digest: TranscriptDigest): string {
	const header = `### Transcript: ${path.basename(digest.path)}`;
	const body = digest.turns.map((turn) => `${turn.role === "user" ? "USER" : "ASSISTANT"}: ${turn.text}`).join("\n\n");
	return `${header}\n${body}`;
}
