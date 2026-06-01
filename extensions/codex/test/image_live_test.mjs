#!/usr/bin/env node
/**
 * Live smoke test for the CodexImage Codex client.
 *
 * Loads codexImageClient.ts via jiti (the same loader pi uses — no build step).
 * Skips gracefully (exit 0) if no openai-codex auth is present.
 */

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.resolve(__dirname, "../_shared/codexImageClient.ts");

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
	try {
		const root = execSync("npm root -g", { encoding: "utf-8" }).trim();
		if (root) candidates.push(path.join(root, "@earendil-works/pi-coding-agent/package.json"));
	} catch {
		/* ignore */
	}
	return candidates.find((p) => fs.existsSync(p));
}

function readJson(filePath) {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return null;
	}
}

function hasAuth() {
	const primaryPath = process.env.CODEX_AUTH_PATH || path.join(os.homedir(), ".pi", "agent", "auth.json");
	const primary = readJson(primaryPath);
	const entry = primary?.["openai-codex"];
	if (entry && typeof entry === "object" && entry.type === "oauth" && entry.access && entry.refresh && entry.accountId) {
		return true;
	}

	const dir = path.join(os.homedir(), ".cli-proxy-api");
	let files = [];
	try {
		files = fs
			.readdirSync(dir)
			.filter((name) => /^codex-.*\.json$/.test(name))
			.map((name) => path.join(dir, name))
			.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
	} catch {
		return false;
	}
	for (const file of files) {
		const fallback = readJson(file);
		if (fallback?.access_token && fallback?.refresh_token && fallback?.account_id) return true;
	}
	return false;
}

function assert(cond, msg) {
	if (!cond) {
		console.error(`  ✗ ${msg}`);
		process.exitCode = 1;
		throw new Error(msg);
	}
	console.log(`  ✓ ${msg}`);
}

function assertPng(buffer, label) {
	assert(buffer.length > 8, `${label} has bytes`);
	assert(buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47, `${label} has PNG magic bytes`);
}

async function main() {
	const piPkgJson = resolvePiPackageJson();
	if (!piPkgJson) {
		console.log("SKIP: could not locate @earendil-works/pi-coding-agent (set PI_PACKAGE_JSON to its package.json).");
		process.exit(0);
	}
	if (!hasAuth()) {
		console.log("SKIP: Codex not authorised (no openai-codex OAuth auth). Run `codex login`.");
		process.exit(0);
	}

	const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-image-live-"));
	process.env.CODEX_IMAGE_OUTPUT_DIR = outputDir;
	process.env.CODEX_IMAGE_DEADLINE_MS ||= "180000";

	const requireFromPi = createRequire(piPkgJson);
	const { createJiti } = requireFromPi("jiti");
	const jiti = createJiti(import.meta.url, { interopDefault: true });
	const { runCodexImageGenerate, runCodexImageEdit, DEFAULT_CODEX_IMAGE_BASE_MODEL } = await jiti.import(clientPath);

	console.log(`Using model: ${process.env.CODEX_IMAGE_BASE_MODEL || DEFAULT_CODEX_IMAGE_BASE_MODEL}`);
	console.log(`Output dir: ${outputDir}\n`);

	console.log("generate: simple blue dot PNG");
	const generated = await runCodexImageGenerate({
		prompt: "Create a simple clean PNG image: one small blue dot centered on a white background. No text, no border.",
		size: "1024x1024",
		outputFormat: "png",
		cwd: process.cwd(),
	});
	assert(generated.base64.length > 0, "generate returned base64 image data");
	assert(generated.mimeType === "image/png", "generate returned image/png mime type");
	assert(fs.existsSync(generated.savedPath), "generate saved image file to disk");
	assert(generated.savedPath.startsWith(outputDir), "generate used CODEX_IMAGE_OUTPUT_DIR");
	assertPng(Buffer.from(generated.base64, "base64"), "generated inline image");
	assertPng(fs.readFileSync(generated.savedPath), "generated saved image");
	console.log(`  saved: ${generated.savedPath}\n`);

	console.log("edit: turn the dot red");
	const edited = await runCodexImageEdit({
		prompt: "Edit this image so the centered dot is red instead of blue. Keep the white background. No text.",
		images: [generated.savedPath],
		size: "1024x1024",
		outputFormat: "png",
		cwd: process.cwd(),
	});
	assert(edited.base64.length > 0, "edit returned base64 image data");
	assert(edited.mimeType === "image/png", "edit returned image/png mime type");
	assert(fs.existsSync(edited.savedPath), "edit saved image file to disk");
	assert(edited.savedPath.startsWith(outputDir), "edit used CODEX_IMAGE_OUTPUT_DIR");
	assertPng(Buffer.from(edited.base64, "base64"), "edited inline image");
	assertPng(fs.readFileSync(edited.savedPath), "edited saved image");
	console.log(`  saved: ${edited.savedPath}\n`);

	console.log("PASS: CodexImage generate + edit both work via Codex OAuth.");
}

main().catch((err) => {
	console.error(`ERROR: ${err.message}`);
	process.exit(1);
});
