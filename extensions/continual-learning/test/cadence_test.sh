#!/usr/bin/env bash
# Headless unit test for the continual-learning cadence gate + memory mechanics.
# Pure data-layer (no pi, no agents, no TTY) — mirrors Cursor's stop-hook truth table.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export ROOT_DIR

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const root = process.env.ROOT_DIR;
const cad = await import(pathToFileURL(`${root}/extensions/continual-learning/cadence.ts`).href);
const mem = await import(pathToFileURL(`${root}/extensions/continual-learning/memory.ts`).href);

const MIN = 60_000;
function opts(over = {}) {
  return { minTurns: 10, minMinutes: 120, trialEnabled: false, trialMinTurns: 3, trialMinMinutes: 15, trialDurationMinutes: 1440, ...over };
}

// ---- cadence: fires only when turns AND minutes AND mtime advanced ----
{
  const t0 = 1_000_000_000_000;
  let state = cad.createInitialState();
  // 9 turns, plenty of time, transcript advancing — should NOT fire (need 10 turns)
  for (let i = 0; i < 9; i++) {
    const d = cad.decideCadence({ turnCounted: true, generationKey: `g${i}`, transcriptMtimeMs: t0 + i }, state, opts(), t0 + i);
    assert.equal(d.trigger, false, `turn ${i + 1} must not fire before min turns`);
    state = d.state;
  }
  assert.equal(state.turnsSinceLastRun, 9, "9 counted turns accumulated");
  // 10th turn, first run (minutes since last = Infinity), mtime advanced -> FIRE
  const fire = cad.decideCadence({ turnCounted: true, generationKey: "g9", transcriptMtimeMs: t0 + 100 }, state, opts(), t0 + 100);
  assert.equal(fire.trigger, true, "10th turn with advanced transcript fires");
  assert.equal(fire.state.turnsSinceLastRun, 0, "counter resets on fire");
  state = fire.state;
}

// ---- cadence: minutes gate blocks a too-soon second run ----
{
  const t0 = 2_000_000_000_000;
  let state = { ...cad.createInitialState(), lastRunAtMs: t0, turnsSinceLastRun: 0, lastTranscriptMtimeMs: t0 };
  // 10 turns but only 5 minutes later -> minutes gate blocks
  for (let i = 0; i < 10; i++) {
    state = cad.decideCadence({ turnCounted: true, generationKey: `m${i}`, transcriptMtimeMs: t0 + 5 * MIN + i }, state, opts(), t0 + 5 * MIN + i).state;
  }
  const tooSoon = cad.decideCadence({ turnCounted: true, generationKey: "m10", transcriptMtimeMs: t0 + 5 * MIN + 50 }, state, opts(), t0 + 5 * MIN + 50);
  assert.equal(tooSoon.trigger, false, "minutes gate blocks within window");
  // same turns, 121 minutes later -> fires
  const later = cad.decideCadence({ turnCounted: true, generationKey: "m11", transcriptMtimeMs: t0 + 121 * MIN }, state, opts(), t0 + 121 * MIN);
  assert.equal(later.trigger, true, "fires once minutes threshold met");
}

// ---- cadence: transcript must advance ----
{
  const t0 = 3_000_000_000_000;
  let state = { ...cad.createInitialState(), turnsSinceLastRun: 9, lastRunAtMs: 0, lastTranscriptMtimeMs: 5000 };
  const stale = cad.decideCadence({ turnCounted: true, generationKey: "s1", transcriptMtimeMs: 5000 }, state, opts(), t0);
  assert.equal(stale.trigger, false, "no fire when transcript mtime did not advance");
}

// ---- cadence: aborted turn is not counted ----
{
  const t0 = 4_000_000_000_000;
  let state = { ...cad.createInitialState(), turnsSinceLastRun: 9, lastRunAtMs: 0, lastTranscriptMtimeMs: null };
  const aborted = cad.decideCadence({ turnCounted: false, generationKey: "a1", transcriptMtimeMs: t0 }, state, opts(), t0);
  assert.equal(aborted.trigger, false, "aborted/no-turn never fires");
  assert.equal(aborted.state.turnsSinceLastRun, 9, "turn counter unchanged on no-turn");
}

// ---- cadence: duplicate generation is ignored ----
{
  const t0 = 5_000_000_000_000;
  let state = { ...cad.createInitialState(), turnsSinceLastRun: 20, lastProcessedGenerationId: "dup", lastTranscriptMtimeMs: null };
  const dup = cad.decideCadence({ turnCounted: true, generationKey: "dup", transcriptMtimeMs: t0 }, state, opts(), t0);
  assert.equal(dup.trigger, false, "duplicate generation never fires");
  assert.equal(dup.state.turnsSinceLastRun, 20, "duplicate does not increment counter");
}

// ---- cadence: trial mode lowers thresholds ----
{
  const t0 = 6_000_000_000_000;
  let state = cad.createInitialState();
  const o = opts({ trialEnabled: true });
  // 3 turns, 16 minutes apart, first run -> fires under trial
  for (let i = 0; i < 2; i++) {
    state = cad.decideCadence({ turnCounted: true, generationKey: `t${i}`, transcriptMtimeMs: t0 + i }, state, o, t0 + i).state;
  }
  const fire = cad.decideCadence({ turnCounted: true, generationKey: "t2", transcriptMtimeMs: t0 + 100 }, state, o, t0 + 100);
  assert.equal(fire.trigger, true, "trial mode fires at 3 turns / first run");
}

// ---- env parsing: primary + legacy names ----
{
  const a = cad.parseEnvOptions({ CONTINUAL_LEARNING_MIN_TURNS: "5", CONTINUOUS_LEARNING_MIN_MINUTES: "30", CONTINUAL_LEARNING_TRIAL_MODE: "true" });
  assert.equal(a.minTurns, 5, "primary env name parsed");
  assert.equal(a.minMinutes, 30, "legacy env name parsed");
  assert.equal(a.trialEnabled, true, "trial mode boolean parsed");
  const b = cad.parseEnvOptions({});
  assert.equal(b.minTurns, 10, "default min turns");
  assert.equal(b.minMinutes, 30, "default min minutes");
}

// ---- memory: delta selection (new + changed only) ----
{
  const index = { version: 1, entries: { "/a.jsonl": { mtimeMs: 100, processedAtMs: 1 } } };
  const stats = [
    { path: "/a.jsonl", mtimeMs: 100 }, // unchanged -> skip
    { path: "/b.jsonl", mtimeMs: 50 },  // new -> include
    { path: "/a.jsonl", mtimeMs: 200 }, // changed dup path (later wins in real data); include
  ];
  const deltas = mem.selectDeltaTranscripts(stats, index);
  assert.ok(deltas.find((d) => d.path === "/b.jsonl"), "new transcript selected");
  assert.ok(!deltas.find((d) => d.path === "/a.jsonl" && d.mtimeMs === 100), "unchanged transcript skipped");
}

// ---- memory: index refresh drops deleted, updates processed ----
{
  const index = { version: 1, entries: { "/old.jsonl": { mtimeMs: 1, processedAtMs: 1 }, "/keep.jsonl": { mtimeMs: 2, processedAtMs: 2 } } };
  const processed = [{ path: "/keep.jsonl", mtimeMs: 9 }];
  const existing = ["/keep.jsonl"]; // /old.jsonl deleted
  const next = mem.refreshIndex(index, processed, existing, 1234);
  assert.ok(!next.entries["/old.jsonl"], "deleted transcript pruned from index");
  assert.equal(next.entries["/keep.jsonl"].mtimeMs, 9, "processed transcript mtime updated");
  assert.equal(next.entries["/keep.jsonl"].processedAtMs, 1234, "processedAt stamped");
}

// ---- memory: parse all THREE learned sections back out of AGENTS.md ----
{
  const md = [
    "# Project",
    "Some hand-written intro.",
    "",
    "## Learned Corrections",
    "- Ask before changing keybindings",
    "",
    "## Learned User Preferences",
    "- Prefers tabs over spaces",
    "- Wants concise commits",
    "",
    "## Learned Workspace Facts",
    "- Tests run via `npm test`",
    "",
    "## Other",
    "- not a learned bullet",
  ].join("\n");
  const sec = mem.parseLearnedSections(md);
  assert.deepEqual(sec.corrections, ["Ask before changing keybindings"], "corrections parsed");
  assert.deepEqual(sec.preferences, ["Prefers tabs over spaces", "Wants concise commits"], "preferences parsed");
  assert.deepEqual(sec.facts, ["Tests run via `npm test`"], "facts parsed; other section excluded");
}

// ---- memory: render fresh document has all three headings in order ----
{
  const doc = mem.renderLearnedDocument(mem.emptyLearnedSections());
  assert.ok(doc.includes(mem.CORRECTIONS_HEADING), "fresh doc has corrections heading");
  assert.ok(doc.includes(mem.PREFERENCES_HEADING), "fresh doc has preferences heading");
  assert.ok(doc.includes(mem.FACTS_HEADING), "fresh doc has facts heading");
  // Corrections lead (highest-priority guidance read first).
  assert.ok(doc.indexOf(mem.CORRECTIONS_HEADING) < doc.indexOf(mem.PREFERENCES_HEADING), "corrections precede preferences");
  assert.ok(doc.indexOf(mem.PREFERENCES_HEADING) < doc.indexOf(mem.FACTS_HEADING), "preferences precede facts");
}

// ---- memory: round-trip parse->render is stable ----
{
  const sections = { corrections: ["Esc must abort the turn"], preferences: ["Concise commits"], facts: ["npm test runs the suite"] };
  const doc = mem.renderLearnedDocument(sections);
  const reparsed = mem.parseLearnedSections(doc);
  assert.deepEqual(reparsed, sections, "render->parse round-trips all three sections");
}

console.log("continual-learning cadence_test: ALL PASS");
NODE
echo "cadence_test exit: $?"
