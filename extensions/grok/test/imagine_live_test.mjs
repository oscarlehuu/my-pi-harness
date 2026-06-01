#!/usr/bin/env node
/**
 * Live smoke test for the Grok Imagine client.
 *
 * Loads imagineClient.ts and the three tool modules via jiti (same loader pi
 * uses; no build step), then runs a real image generation and a real short
 * text→video generation against cli-chat-proxy.grok.com/v1. Skips gracefully
 * (exit 0) when no valid `grok login` subscription token is available.
 */

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authPath = path.resolve(__dirname, "../_shared/grokAuth.ts");
const clientPath = path.resolve(__dirname, "../_shared/imagineClient.ts");
const toolPaths = [
	path.resolve(__dirname, "../imagegen/index.ts"),
	path.resolve(__dirname, "../imageedit/index.ts"),
	path.resolve(__dirname, "../videogen/index.ts"),
];

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

const piPkgJson = resolvePiPackageJson();
if (!piPkgJson) {
	console.log("SKIP: could not locate @earendil-works/pi-coding-agent (set PI_PACKAGE_JSON to its package.json).");
	process.exit(0);
}
const requireFromPi = createRequire(piPkgJson);
const NodeModule = requireFromPi("node:module");
const piDir = path.dirname(piPkgJson);
process.env.NODE_PATH = [
	path.resolve(piDir, "../.."),
	path.join(piDir, "node_modules"),
	process.env.NODE_PATH,
]
	.filter(Boolean)
	.join(path.delimiter);
NodeModule.Module?._initPaths?.();
NodeModule._initPaths?.();
const { createJiti } = requireFromPi("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true });

function assert(cond, msg) {
	if (!cond) {
		console.error(`  ✗ ${msg}`);
		process.exitCode = 1;
		throw new Error(msg);
	}
	console.log(`  ✓ ${msg}`);
}

function isAuthError(err) {
	return err?.constructor?.name === "GrokAuthError" || /Grok .*authorised|grok login|session token expired/i.test(err?.message || "");
}

function isValidImage(bytes) {
	const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
	return jpeg || png;
}

function isMp4(bytes) {
	return bytes.length > 1024 && bytes.subarray(0, Math.min(bytes.length, 64)).includes(Buffer.from("ftyp"));
}

async function main() {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-grok-imagine-"));
	process.env.PI_IMAGINE_OUTPUT_DIR = tempDir;
	process.env.PI_IMAGINE_VIDEO_DEADLINE_MS ||= "300000";
	process.env.PI_IMAGINE_VIDEO_POLL_MS ||= "5000";

	const { resolveGrokAuth } = await jiti.import(authPath);
	try {
		resolveGrokAuth("subscription");
	} catch (err) {
		if (isAuthError(err)) {
			console.log(`SKIP: Grok not authorised for subscription proxy (${err.message}). Run \`grok login\`.`);
			process.exit(0);
		}
		throw err;
	}

	// Import tool modules too: this catches loader/syntax/import regressions without
	// having to spin up a full pi runtime.
	for (const toolPath of toolPaths) await jiti.import(toolPath);

	const { generateImage, generateVideo, GROK_IMAGE_MODEL, GROK_VIDEO_MODEL } = await jiti.import(clientPath);
	console.log(`Using models: ${GROK_IMAGE_MODEL}, ${GROK_VIDEO_MODEL}`);
	console.log(`Output dir: ${tempDir}\n`);

	console.log("image generation: 1 tiny acceptance image");
	const image = await generateImage({
		prompt: "A simple red circle icon centered on a plain white background. No text.",
		n: 1,
		resolution: "1k",
		output: "acceptance-image",
	});
	assert(image.images.length === 1, "image generation returned exactly one image");
	const imagePath = image.images[0].path;
	assert(imagePath.startsWith(tempDir + path.sep), "image landed in PI_IMAGINE_OUTPUT_DIR");
	assert(fs.existsSync(imagePath), "image file exists on disk");
	const imageBytes = fs.readFileSync(imagePath);
	assert(isValidImage(imageBytes), "image decodes as JPEG or PNG by magic bytes");
	console.log(`  saved: ${imagePath}\n`);

	console.log("text→video generation: short 480p acceptance mp4");
	const video = await generateVideo({
		prompt: "A minimal blue dot moving slowly left to right on a plain white background, simple animation, no text.",
		duration: 5,
		resolution: "480p",
		output: "acceptance-video.mp4",
		onProgress: (p) => {
			if (p.phase === "polling") console.log(`  status: ${p.status}${typeof p.progress === "number" ? ` ${p.progress}%` : ""}`);
		},
	});
	assert(video.path.startsWith(tempDir + path.sep), "video landed in PI_IMAGINE_OUTPUT_DIR");
	assert(fs.existsSync(video.path), "video file exists on disk");
	const videoBytes = fs.readFileSync(video.path);
	assert(isMp4(videoBytes), "video is a non-empty mp4 (ftyp header present)");
	console.log(`  saved: ${video.path}`);
	console.log(`  source: ${video.url}\n`);

	console.log("PASS: Grok Imagine image + video work via the subscription proxy.");
}

main().catch((err) => {
	if (isAuthError(err)) {
		console.log(`SKIP: Grok not authorised for subscription proxy (${err.message}). Run \`grok login\`.`);
		process.exit(0);
	}
	console.error(`ERROR: ${err.message}`);
	process.exit(1);
});
