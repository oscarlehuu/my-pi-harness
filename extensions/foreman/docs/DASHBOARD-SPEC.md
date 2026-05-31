# Dashboard Spec — Foreman Mission Control (v1, for approval)

A live, navigable view of the foreman loop: watch the orchestrator drive developer/tester,
see what each agent is doing right now, drill into one agent in its own full view, and
press `←` to come back. Open/minimize anytime via a keyboard shortcut.

Founder decisions locked (do not relitigate without asking):
1. Surface = **full navigable dashboard** (not just an inline block).
2. **Live** — reflects work as it happens, not only post-hoc replay.
3. Entry point = a **keyboard shortcut** (open / minimize).
4. Capture = **full transcript** per agent (every tool call + args + output, persisted).

---

## The one hard constraint that shapes everything

The founder runs foreman in a **headless subprocess** (verified, from the founder's own
invocation): `pi --mode json -p --no-session "Call the foreman tool ..."`. That process has
`hasUI: false` and its **own memory**, isolated from the interactive pi session the founder is
watching. In-process streaming (`onUpdate`) cannot cross that boundary.

Two further facts, verified from pi source:
- `ctx.ui.custom()` is **blocking** and **takes over the editor** until `done()` is called
  (`coding-agent/src/core/extensions/types.ts:188`). A tool's `execute()` that hosts the view
  could not also run the loop — and in headless mode there is no UI at all.
- Keyboard shortcuts dispatch via `onExtensionShortcut`, run async, and **fire even while the
  agent is streaming** (`components/custom-editor.ts:31`, `interactive-mode.ts:1692`). So a
  shortcut *can* mount a full-screen component mid-run.

**Conclusion: the ledger on disk is the only channel that works across the two processes.**
The design is therefore: **foreman (any process) writes a rich, live ledger; a shortcut in the
interactive session reads/tails that ledger and renders the dashboard.** This also gives
cross-session replay for free, and degrades gracefully in headless mode (no UI, just files).

```
┌ headless foreman subprocess ┐         ┌ interactive pi session (founder) ┐
│ runAgent() streams subproc  │         │ Ctrl+G shortcut                  │
│   → live transcript files   │  disk   │   → mount Dashboard (ui.custom)  │
│   → events.jsonl (append)   │ ──────► │   → tail files, re-render        │
└─────────────────────────────┘         └──────────────────────────────────┘
```

---

## Phase A — Capture the work (make the data exist)

Today `foreman`'s `runAgent` (index.ts:88) discards the agent stream: it keeps only final
`message_end` text. The `subagent` extension already captures the full stream correctly
(tool calls + args, tool results, usage, stop reason). **Port that capture into foreman**, then
persist it live so a reader process can see partial progress.

### A1. Rich transcript per agent run

New ledger artifact, one file per agent run, written **incrementally** (not just at the end):

```
.pi/plans/<slug>/transcripts/<ts>__<role>-r<n>__<uuid>.jsonl
```

Append-only JSONL; each line is one event captured from the subprocess stream:

```
{ t, kind: "agent_start", role, round, model, task }
{ t, kind: "tool_call",   name, args }            # e.g. read/edit/bash with args
{ t, kind: "tool_result", name, ok, preview }     # truncated observation
{ t, kind: "text",        text }                   # assistant prose chunks
{ t, kind: "usage",       input, output, cost, contextTokens }
{ t, kind: "agent_end",   stopReason, exitCode }
```

- Written by the controller as stdout lines arrive (we already parse `message_end` /
  `tool_result_end` line-by-line; extend `onLine` to also emit `tool_call` and `text`).
- Capped per file (reuse subagent's `PER_TASK_OUTPUT_CAP = 50KB`); truncate `args`/`preview`.
- `.gitignore`: transcripts are **machine-local, not committed** (the existing `.pi/.gitignore`
  already excludes `plans/*/transcripts/` — matches PHASE2-SPEC decision). The committed ledger
  stays the summary (`state.json`, `handoffs/`, `log.jsonl`).

### A2. Live activity signal (the "what's working now")

A single small file the controller rewrites atomically at each step transition, so a reader can
render the live row without scanning every transcript:

```
.pi/plans/<slug>/activity.json
{ updatedAt, round, phase: "developer"|"verify"|"tester"|"idle",
  activeTranscript: "<filename>", note: "running…|exit 1|FAIL …", pid }
```

`events.jsonl` already exists as `log.jsonl` (gates, rounds, verdicts) — reuse it as the
high-level timeline; `activity.json` is just the cheap "current pointer."

### A3. Handoff stays the summary

No change to `handoffs/` schema. The transcript is the *full* record; the handoff is the
*distilled* one the loop already depends on. Dashboard links a handoff row → its transcript file.

**Phase A is independently shippable**: even before the dashboard, it upgrades the inline tool
output and the committed ledger. Acceptance: run a task, confirm `transcripts/` + `activity.json`
populate live (tail while running).

---

## Phase B — The dashboard (navigable view-stack)

A single component mounted by a shortcut via `ctx.ui.custom(factory)` (default mode — full
takeover, **not** overlay; that satisfies "another process/view, not an overlay"). It manages an
internal **navigation stack**: root = orchestrator; drilling pushes an agent view; `←`/`Esc` pops;
`Esc` at root closes (minimize). It reads the ledger of the most-recent / specified task and
**tails** it (re-render on file change or a short poll while the task is active).

### B1. Root view — orchestrator (mission control)

```
┌ FOREMAN ─────────────────────────── task: add-exec-acceptance-test ┐
  state: in_progress   gate1 ✓   gate2 ·   round 2/3
  verify: bash extensions/foreman/test/gate_flow_test.sh
  ─────────────────────────────────────────────────────────────────────
    R1  ✓ developer  done     8 tools   ↑4.2k ↓1.1k
    R1  ◦ verify     exit 1
    R1  ✗ tester     FAIL     "add() off by one"
  ▶ R2  ● developer  running  3 tools   ↑1.1k …          ← live (activity.json)
  ─────────────────────────────────────────────────────────────────────
  ↑/↓ select   →/Enter open agent   r refresh   Esc minimize
```

- Rows built from `log.jsonl` + `handoffs/` (history) and `activity.json` (the live row).
- Header from `state.json`. Live row pulses while `phase != idle`.

### B2. Agent view — full transcript (pushed onto the stack)

```
┌ ← developer · round 2 ──────────── openai-codex/gpt-5.5   ● running ┐
  → read  math_utils.py
  → edit  math_utils.py   (a - b  →  a + b)
  → $ bash extensions/foreman/test/gate_flow_test.sh    … 1 passed
  ── output ──────────────────────────────────────────────────────────
  Fixed the sign error in add(). Verified locally; verify now exits 0.
  ─────────────────────────────────────────────────────────────────────
  ←/Esc back   ↑/↓ scroll   g/G top/bottom   Esc(at root) minimize
```

- Renders one transcript JSONL file (reuse subagent's `formatToolCall` for tool lines, and
  `Markdown` for assistant prose — keep it visually consistent with subagent output).
- If the run is live (matches `activity.activeTranscript`), tail it; show a running indicator.

### B3. Navigation / keys

- Shortcut (proposed **Ctrl+G** — "go to foreman"; verify no conflict in keybindings.md, fall
  back to Ctrl+T if taken). Same key toggles: open when closed, no-op when already open.
- Root: `↑/↓` select row, `→`/`Enter` push agent view, `Esc` close (minimize), `r` force refresh.
- Agent view: `↑/↓`/`PgUp`/`PgDn` scroll, `g/G` top/bottom, `←`/`Esc` pop to root.
- The component never blocks the loop: it's read-only over the ledger. Closing it leaves the
  headless foreman subprocess running untouched.

### B4. Which task does it open?

Default: the **most-recently-updated** non-done task in `cwd` (reuse `findResumable`, but don't
exclude done — allow inspecting finished tasks too). If multiple, root view can list tasks first
(a task picker) then enter mission control. v1 can start with "latest"; task picker is a small
follow-up.

---

## What gets built (the only new code)

1. **Phase A** — extend `runAgent` capture (tool_call + text events), write `transcripts/*.jsonl`
   incrementally, write/rewrite `activity.json`, on agent end keep writing the existing handoff.
   Small additions to `ledger.ts` (paths + atomic activity writer) and `index.ts` (`onLine`).
2. **Phase B** — `extensions/foreman/dashboard.ts`: the `Dashboard` component (view-stack, two
   views, tailing reader) + a tiny ledger reader (`readActivity`, `readTranscript`, `listRuns`).
   Register the shortcut in `index.ts` (`pi.registerShortcut`).
3. Reuse from `subagent`: `formatToolCall`, `formatUsageStats`, display-item rendering. Consider
   lifting these into a shared helper both extensions import (avoid copy-paste drift).

No change to the loop's control flow, gates, verdict logic, or quota-safe prompt handling.

---

## Acceptance test (extends the existing rig)

1. Seed the broken-task repo (as `gate_flow_test.sh` already does).
2. Start a task; while the loop runs, assert `transcripts/<…>.jsonl` and `activity.json` are
   being written and grow over time (live capture works).
3. Headless-safe: run foreman with `hasUI:false`; assert it still completes and writes files,
   and the shortcut/dashboard code is never invoked (no crash, no UI calls).
4. Reader: from a second process, point the dashboard reader at the ledger mid-run and assert it
   reconstructs the root rows + the live row from `activity.json` (pure function over files —
   unit-testable without a TTY).
5. Replay: after the task is done, reopen and assert full transcripts render for each round.

(UI rendering itself is validated by a logic test over the reader/view-model — same pattern as
`AskUserQuestion/test/logic_test.sh` — not by driving a real terminal.)

---

## Open questions for the founder

- **Shortcut key**: Ctrl+G ok, or prefer another? (Will confirm it's unbound first.)
- **Task picker vs. latest-only** for v1: start with "open latest task," add a picker later — ok?
- **Commit transcripts?** Spec keeps them machine-local (matches PHASE2 decision; committed
  ledger stays the summary). Say so if you'd rather they travel with the repo.

## Out of scope (v1)
Cross-project global dashboard; editing/steering agents from the view (read-only only);
rendering live in the *headless* process (it has no TTY — interactive session only); overlay/
floating mode (explicitly rejected in favor of a real view switch).
