#!/usr/bin/env node
/**
 * Live smoke test for the Antigravity image client.
 *
 * Imports antigravityClient.ts and both tool modules via jiti (same loader pi
 * uses; no build step), then runs one cheap image generation through the local
 * cli-proxy-api on :8317. Skips gracefully (exit 0) when the proxy or key is
 * unavailable.
 */

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.resolve(__dirname, "../_shared/antigravityClient.ts");
const toolPaths = [
	path.resolve(__dirname, "../imagegen/index.ts"),
	path.resolve(__dirname, "../imageedit/index.ts"),
];

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

function errorText(err) {
	return [
		err?.message,
		err?.cause?.message,
		err?.cause?.code,
		err?.code,
	]
		.filter(Boolean)
		.join(" ");
}

function isUnavailableError(err) {
	if (err?.constructor?.name === "AntigravityAuthError") return true;
	return /cli-proxy-api key not found|Antigravity proxy auth failed|\b(401|403)\b|unauthori[sz]ed|forbidden|invalid api key|fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EADDRNOTAVAIL/i.test(
		errorText(err),
	);
}

function isValidImage(bytes) {
	const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
	return jpeg || png;
}

async function main() {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-antigravity-image-"));
	process.env.PI_IMAGINE_OUTPUT_DIR = tempDir;
	process.env.PI_IMAGINE_MAX_ATTEMPTS ||= "1";
	process.env.PI_IMAGINE_BACKOFF_MS ||= "100";
	process.env.ANTIGRAVITY_BASE_URL ||= "http://localhost:8317/v1";

	const client = await jiti.import(clientPath);
	try {
		client.resolveAntigravityAuth();
	} catch (err) {
		if (isUnavailableError(err)) {
			console.log(`SKIP: Antigravity cli-proxy-api not available (${err.message}).`);
			process.exit(0);
		}
		throw err;
	}

	for (const toolPath of toolPaths) await jiti.import(toolPath);

	const { generateImage, ANTIGRAVITY_IMAGE_MODEL } = client;
	console.log(`Using model: ${ANTIGRAVITY_IMAGE_MODEL}`);
	console.log(`Output dir: ${tempDir}\n`);

	console.log("image generation: 1 tiny acceptance image");
	let image;
	try {
		image = await generateImage({
			prompt: "Generate an image: a tiny red circle icon centered on a plain white background. No text.",
			n: 1,
			output: "acceptance-image",
		});
	} catch (err) {
		if (isUnavailableError(err)) {
			console.log(`SKIP: Antigravity cli-proxy-api not available (${err.message}).`);
			process.exit(0);
		}
		throw err;
	}

	assert(image.images.length === 1, "image generation returned exactly one image");
	const imagePath = image.images[0].path;
	assert(imagePath.startsWith(tempDir + path.sep), "image landed in PI_IMAGINE_OUTPUT_DIR");
	assert(fs.existsSync(imagePath), "image file exists on disk");
	const imageBytes = fs.readFileSync(imagePath);
	assert(isValidImage(imageBytes), "image decodes as JPEG or PNG by magic bytes");
	console.log(`  saved: ${imagePath}\n`);

	console.log("PASS: Antigravity image generation works via the local cli-proxy-api.");
}

main().catch((err) => {
	if (isUnavailableError(err)) {
		console.log(`SKIP: Antigravity cli-proxy-api not available (${err.message}).`);
		process.exit(0);
	}
	console.error(`ERROR: ${err.stack || err.message}`);
	process.exit(1);
});
