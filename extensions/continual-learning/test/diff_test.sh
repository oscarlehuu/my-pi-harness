#!/usr/bin/env bash
# Headless unit test for the learned-section diff implementation.
# Validates diffLearnedMarkdown and renderDiffLines outputs.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export ROOT_DIR

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.ROOT_DIR;
const diffModule = await import(pathToFileURL(`${root}/extensions/continual-learning/diff.ts`).href);

// Test empty diff
const emptyMarkdown = `
## Learned Corrections
- Correction 1

## Learned User Preferences

## Learned Workspace Facts
`;
const emptyDiff = diffModule.diffLearnedMarkdown(emptyMarkdown, emptyMarkdown);
assert.equal(diffModule.isEmptyDiff(emptyDiff), true, "Identical documents yield an empty diff");

// Test add, remove, and change (reword)
const beforeMarkdown = `
## Learned Corrections
- Always use spaces, not tabs.
- Check inputs.

## Learned User Preferences
- Prefer brief commit messages.

## Learned Workspace Facts
- Repository is node-based.
`;

const afterMarkdown = `
## Learned Corrections
- Always use spaces, not tabs.
- Check inputs carefully.
- Handle edge cases.

## Learned User Preferences

## Learned Workspace Facts
- Repository is node-based.
`;

const diff = diffModule.diffLearnedMarkdown(beforeMarkdown, afterMarkdown);
assert.equal(diffModule.isEmptyDiff(diff), false, "Non-identical documents yield a non-empty diff");

// Verification of counts
assert.equal(diff.addedCount, 1, "Should have 1 added bullet (Handle edge cases.)");
assert.equal(diff.changedCount, 1, "Should have 1 changed bullet (Check inputs. -> Check inputs carefully.)");
assert.equal(diff.removedCount, 1, "Should have 1 removed bullet (Prefer brief commit messages.)");

// Verify sections structure
assert.equal(diff.sections.length, 2, "Should have changes in Corrections and Preferences sections");

const correctionsDelta = diff.sections.find(s => s.heading.includes("Corrections"));
assert.ok(correctionsDelta, "Should find Corrections delta");
assert.deepEqual(correctionsDelta.added, ["Handle edge cases."], "Corrections added list mismatch");
assert.deepEqual(correctionsDelta.removed, [], "Corrections removed list mismatch");
assert.deepEqual(correctionsDelta.changed, [{ from: "Check inputs.", to: "Check inputs carefully." }], "Corrections changed list mismatch");

const preferencesDelta = diff.sections.find(s => s.heading.includes("Preferences"));
assert.ok(preferencesDelta, "Should find Preferences delta");
assert.deepEqual(preferencesDelta.added, [], "Preferences added list mismatch");
assert.deepEqual(preferencesDelta.removed, ["Prefer brief commit messages."], "Preferences removed list mismatch");
assert.deepEqual(preferencesDelta.changed, [], "Preferences changed list mismatch");

// Test rendering diff lines
const palette = {
	added: (s) => `[ADD] ${s}`,
	removed: (s) => `[REM] ${s}`,
	heading: (s) => `=== ${s} ===`,
	dim: (s) => `(dim) ${s}`,
};

const lines = diffModule.renderDiffLines(diff, 3, { palette, maxLines: 5, width: 80 });

// title should be the first line
assert.match(lines[0], /updated \(\+1 ~1 -1\) from 3 transcripts/, "Title should contain counts and transcript count");

// body lines: we capped maxLines at 5 (so body has at most 5 lines, including heading and items).
// Let's verify structure
assert.equal(lines.length, 6, "Total lines should be 6 (1 title + 5 body rows)");
assert.ok(lines[1].includes("=== Corrections ==="), "First section heading");
assert.ok(lines[2].includes("[REM] - Check inputs."), "Changed - from");
assert.ok(lines[3].includes("[ADD] + Check inputs carefully."), "Changed - to");
assert.ok(lines[4].includes("[ADD] + Handle edge cases."), "Added bullet");
assert.ok(lines[5].includes("more change"), "Should show overflow line");

console.log("diff_test: ALL PASS");
NODE
