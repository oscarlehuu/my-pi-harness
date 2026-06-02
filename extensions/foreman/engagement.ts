/**
 * Persisted per-repo Foreman engagement store.
 *
 * Pure / node-builtin-only: stores only out-of-tree OFF overrides at
 * <agentDir>/foreman/engagement.json while default engagement stays ON. No pi imports live here,
 * so engagement resolution stays headlessly unit-testable.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface RepoEngagement {
	active: boolean;
	source: "default" | "repo";
}

interface EngagementEntry {
	active: false;
	path: string;
	updatedAt: string;
}

interface EngagementStore {
	repos: Record<string, EngagementEntry>;
}

function emptyStore(): EngagementStore {
	return { repos: {} };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStore(value: unknown): EngagementStore {
	if (!isObject(value) || !isObject(value.repos)) return emptyStore();
	const repos: Record<string, EngagementEntry> = {};
	for (const [key, entry] of Object.entries(value.repos)) {
		if (!isObject(entry) || entry.active !== false || typeof entry.path !== "string" || typeof entry.updatedAt !== "string") continue;
		repos[key] = {
			active: false,
			path: path.resolve(entry.path),
			updatedAt: entry.updatedAt,
		};
	}
	return { repos };
}

function readStore(): EngagementStore {
	try {
		return normalizeStore(JSON.parse(fs.readFileSync(engagementStorePath(), "utf-8")));
	} catch {
		return emptyStore();
	}
}

function writeStore(store: EngagementStore): boolean {
	const storePath = engagementStorePath();
	const dir = path.dirname(storePath);
	const tmpPath = path.join(dir, `.engagement.${process.pid}.${Date.now()}.tmp`);
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(tmpPath, storePath);
		return true;
	} catch {
		try {
			fs.rmSync(tmpPath, { force: true });
		} catch {
			// best effort cleanup only
		}
		return false;
	}
}

export function engagementStorePath(): string {
	const seam = process.env.FOREMAN_ENGAGEMENT_STORE?.trim();
	if (seam) return path.resolve(seam);
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
	return path.resolve(agentDir, "foreman", "engagement.json");
}

export function repoEngagementKey(root: string): string {
	const resolvedRoot = path.resolve(root);
	const tail = path.basename(resolvedRoot) || "repo";
	const safeTail = tail.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
	const hash = crypto.createHash("sha256").update(resolvedRoot).digest("hex").slice(0, 12);
	return `${safeTail}-${hash}`;
}

export function readRepoEngagement(root: string): RepoEngagement {
	const key = repoEngagementKey(root);
	const entry = readStore().repos[key];
	return entry?.active === false ? { active: false, source: "repo" } : { active: true, source: "default" };
}

export function repoEngagementActive(root: string): boolean {
	return readRepoEngagement(root).active;
}

/**
 * Persist the repo engagement choice and return the freshly-read RepoEngagement so callers can
 * reflect the post-write state without doing their own second read.
 */
export function setRepoEngagement(root: string, active: boolean): RepoEngagement {
	const resolvedRoot = path.resolve(root);
	const key = repoEngagementKey(resolvedRoot);
	const store = readStore();
	if (active) {
		delete store.repos[key];
	} else {
		store.repos[key] = { active: false, path: resolvedRoot, updatedAt: new Date().toISOString() };
	}
	writeStore(store);
	return readRepoEngagement(resolvedRoot);
}
