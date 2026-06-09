/**
 * Filesystem boundary for Foreman scorer calibration.
 *
 * Thin/node-builtin-only wrapper: walks each task log under .pi/plans/ and delegates parsing/extraction
 * to calibration.ts. Missing or malformed logs are skipped; calibration must never block a gate.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { extractCalibrationObservationsFromLogLines, type FlagObservation } from "./calibration.ts";

function safeTaskSlugs(plansRoot: string): string[] {
	try {
		if (!fs.existsSync(plansRoot)) return [];
		return fs
			.readdirSync(plansRoot)
			.filter((slug) => {
				try {
					return fs.statSync(path.join(plansRoot, slug)).isDirectory();
				} catch {
					return false;
				}
			})
			.sort();
	} catch {
		return [];
	}
}

function safeReadLogLines(logPath: string): string[] {
	try {
		if (!fs.existsSync(logPath)) return [];
		return fs.readFileSync(logPath, "utf-8").split(/\r?\n/);
	} catch {
		return [];
	}
}

export function readCalibrationObservationsFromPlans(workingDir: string): FlagObservation[] {
	const root = path.join(workingDir, ".pi", "plans");
	const taskLogs = safeTaskSlugs(root).map((slug) => ({
		slug,
		lines: safeReadLogLines(path.join(root, slug, "log.jsonl")),
	}));
	return extractCalibrationObservationsFromLogLines(taskLogs);
}
