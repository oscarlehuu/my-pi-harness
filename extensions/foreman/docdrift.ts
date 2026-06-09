/**
 * Documentation drift helpers for Foreman.
 *
 * Pure / node-builtin-only: detects docs that reference changed code paths but were not refreshed by
 * the soft doc-er stage. The orchestrator owns filesystem/agent I/O; this module consumes plain data.
 */

export interface DocumentationFile {
	path: string;
	content: string;
}

export interface DocDriftInput {
	changedCodePaths: string[];
	docFiles: DocumentationFile[];
	updatedDocPaths?: string[];
}

function normalizePath(value: string): string {
	return value
		.trim()
		.replace(/^[`'"<]+/g, "")
		.replace(/[`'">.,;]+$/g, "")
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/[?#].*$/, "")
		.replace(/(?::\d+){1,2}$/, "")
		.replace(/[`'">.,;:]+$/g, "")
		.trim();
}

function uniqueNormalized(values: string[] | undefined): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values ?? []) {
		if (typeof value !== "string") continue;
		const normalized = normalizePath(value);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

export function isForemanDocumentationPath(value: string): boolean {
	const normalized = normalizePath(value);
	return normalized.startsWith("docs/") || /^extensions\/[^/]+\/docs\//.test(normalized);
}

function referencesChangedPath(content: string, changedPath: string): boolean {
	const normalizedContent = content.replace(/\\/g, "/");
	return normalizedContent.includes(changedPath) || normalizedContent.includes(`./${changedPath}`);
}

export function detectLikelyStaleDocs(input: DocDriftInput): string[] {
	const changed = uniqueNormalized(input.changedCodePaths).filter((p) => p && !isForemanDocumentationPath(p));
	if (!changed.length) return [];

	const updatedDocs = new Set(uniqueNormalized(input.updatedDocPaths));
	const stale: string[] = [];
	const seen = new Set<string>();
	for (const doc of input.docFiles ?? []) {
		if (!doc || typeof doc.path !== "string" || typeof doc.content !== "string") continue;
		const docPath = normalizePath(doc.path);
		if (!docPath || updatedDocs.has(docPath) || seen.has(docPath)) continue;
		if (changed.some((changedPath) => referencesChangedPath(doc.content, changedPath))) {
			seen.add(docPath);
			stale.push(docPath);
		}
	}
	return stale;
}
