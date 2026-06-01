#!/usr/bin/env node
/**
 * Live smoke test for the Grok search client.
 *
 * Loads grokClient.ts via jiti (the same loader pi uses — no build step) and runs
 * a real web search and a real X search against the subscription-backed proxy.
 *
 * Requires Grok to be authorised: either GROK_API_KEY/XAI_API_KEY in the env, or a
 * valid ~/.grok/auth.json (run `grok login`). Skips gracefully (exit 0) if neither
 * is present, so it never fails CI on an unauthenticated box.
 *
 * Usage: node extensions/grok/test/client_live_test.mjs
 */

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.resolve(__dirname, "../_shared/grokClient.ts");

// Resolve jiti from the installed pi package (same engine pi loads extensions with).
function resolvePiPackageJson() {
	if (process.env.PI_PACKAGE_JSON && fs.existsSync(process.env.PI_PACKAGE_JSON)) return process.env.PI_PACKAGE_JSON;
	const candidates = [];
	for (const base of (process.env.NODE_PATH ?? "").split(path.delimiter).filter(Boolean)) {
		candidates.push(path.join(base, "@earendil-works/pi-coding-agent/package.json"));
	}
	for (const prefix of ["/opt/homebrew/lib", "/usr/local/lib", "/usr/lib"]) {
		candidates.push(path.join(prefix, "node_modules/@earendil-works/pi-coding-agent/package.json"));
	}
	// `npm root -g` as a last resort.
	try {
		const root = execSync("npm root -g", { encoding: "utf-8" }).trim();
		if (root) candidates.push(path.join(root, "@earendil-works/pi-coding-agent/package.json"));
	} catch {
		/* ignore */
	}
	return candidates.find((p) => fs.existsSync(p));
}

const piPkgJson = resolvePiPackageJson();
if (!piPkgJson) {
	console.log("SKIP: could not locate @earendil-works/pi-coding-agent (set PI_PACKAGE_JSON to its package.json).");
	process.exit(0);
}
const requireFromPi = createRequire(piPkgJson);
const { createJiti } = requireFromPi("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true });

function hasAuth() {
	if (process.env.GROK_API_KEY || process.env.XAI_API_KEY) return true;
	const authPath = process.env.GROK_AUTH_PATH || path.join(os.homedir(), ".grok", "auth.json");
	try {
		const parsed = JSON.parse(fs.readFileSync(authPath, "utf-8"));
		return Object.values(parsed).some((v) => v && typeof v === "object" && typeof v.key === "string" && v.key);
	} catch {
		return false;
	}
}

function assert(cond, msg) {
	if (!cond) {
		console.error(`  ✗ ${msg}`);
		process.exitCode = 1;
		throw new Error(msg);
	}
	console.log(`  ✓ ${msg}`);
}

function isRateLimited(err) {
	return /\b429\b|too many requests|rate.?limit|requests per minute/i.test(err?.message || "");
}

async function main() {
	if (!hasAuth()) {
		console.log("SKIP: Grok not authorised (no GROK_API_KEY/XAI_API_KEY and no ~/.grok/auth.json). Run `grok login`.");
		process.exit(0);
	}

	const { runGrokSearch, formatSearchMarkdown, GROK_SEARCH_MODEL } = await jiti.import(clientPath);
	console.log(`Using model: ${GROK_SEARCH_MODEL}\n`);

	// --- Web search ---
	console.log("web_search: 'latest stable Node.js LTS version'");
	const web = await runGrokSearch({
		input: "What is the latest stable Node.js LTS version? Answer in one sentence and cite the source.",
		tools: [{ type: "web_search", allowed_domains: ["nodejs.org"] }],
	});
	assert(web.text.length > 0, "web search returned answer text");
	assert(web.toolCalls.web > 0, `web search actually ran server-side web_search (${web.toolCalls.web} calls)`);
	assert(web.citations.length > 0, `web search returned ${web.citations.length} citation(s)`);
	assert(
		web.citations.every((c) => /^https?:\/\//.test(c.url)),
		"all web citations are real URLs",
	);
	console.log("  ── answer ──");
	console.log(
		formatSearchMarkdown(web)
			.split("\n")
			.map((l) => `    ${l}`)
			.join("\n"),
	);
	console.log();

	// --- X search ---
	console.log("x_search: recent posts from @xai");
	const x = await runGrokSearch({
		input: "Find recent posts from the @xai account. Summarize 2 and include their x.com URLs.",
		tools: [{ type: "x_search", allowed_x_handles: ["xai"] }],
	});
	assert(x.text.length > 0, "x search returned answer text");
	assert(x.toolCalls.x > 0, `x search actually ran server-side x_search (${x.toolCalls.x} calls)`);
	const xUrls = x.citations.filter((c) => /x\.com|twitter\.com/.test(c.url));
	// Citations array may be empty if the model inlines URLs in text; assert at least
	// one x.com URL appears somewhere (citation or body).
	const hasXUrl = xUrls.length > 0 || /https?:\/\/(x|twitter)\.com\/\S+/.test(x.text);
	assert(hasXUrl, "x search surfaced at least one x.com post URL");
	console.log("  ── answer ──");
	console.log(
		formatSearchMarkdown(x)
			.split("\n")
			.slice(0, 12)
			.map((l) => `    ${l}`)
			.join("\n"),
	);
	console.log();

	if (process.exitCode) {
		console.error("FAIL: one or more assertions failed.");
	} else {
		console.log("PASS: web + X search both work via the Grok proxy.");
	}
}

main().catch((err) => {
	if (isRateLimited(err)) {
		console.log(`SKIP: Grok search proxy rate-limited (${err.message}). Retry later.`);
		process.exit(0);
	}
	console.error(`ERROR: ${err.message}`);
	process.exit(1);
});
