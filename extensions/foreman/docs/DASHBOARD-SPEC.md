# Dashboard Spec — Foreman Mission Control (v1, for approval)

A live, navigable view of the foreman loop: watch the orchestrator drive developer/tester,
see what each agent is doing right now, drill into one agent in its own full view, and
press `←` to come back. Open/minimize anytime via a keyboard shortcut.

Founder decisions locked (do not relitigate without asking):
1. Surface = **full navigable dashboard** (not just an inline block).
2. **Live** — reflects work as it happens, not only post-hoc replay.
3. Entry point = a **keyboard shortcut**: **Ctrl+B** (open / minimize); **Ctrl+F** jumps straight to
   the live agent. An always-on **footer statusline** (Phase C) shows live progress without opening.
4. Capture = **full transcript** per agent (every tool call + args + output, persisted).
5. v1 includes a **task picker** (root lists tasks → enter mission control).
6. Transcripts are **machine-local** (not committed) for now.

Key choice rationale (the hard-won version, verified in pi source):
- **Alt+T** — dropped. Alt = the macOS Option key; Mac terminals don't send it as Meta by default
  (⌥T types `†`, not the `ESC t` bytes pi matches at `keys.ts:1164`).
- **Ctrl+T** — dropped. pi's extension runner classifies built-ins by a
  `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` list (`core/extensions/runner.ts:62`). A key bound
  to a reserved action is a **hard block** (`runner.ts:434` — "conflicts with built-in shortcut.
  Skipping."); a key bound to a non-reserved built-in is overridable but logs a startup warning;
  a key bound to **no** default action registers freely. `ctrl+t` = `app.thinking.toggle`, which is
  reserved → hard-blocked. (Note: this contradicts the earlier assumption that
  `custom-editor.ts:31` dispatch order lets extensions win — that only governs runtime dispatch of
  *successfully registered* shortcuts, not registration itself.)
- **Ctrl+B** — chosen. It has **no** app-level default binding in pi (`core/keybindings.ts` binds
  ctrl+a,c,d,g,l,n,o,p,r,s,t,u,v,x,z — no `b`), so it is neither reserved nor a built-in: it
  registers with no conflict and no warning. It is the editor's emacs "cursor-left" at the tui
  level, but extension shortcuts are dispatched before the editor sees the key
  (`custom-editor.ts:31`), so the dashboard wins. Works in every terminal, no macOS setup.

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

- Shortcut **Ctrl+B** (no default app binding → registers cleanly, no warning). Same key toggles:
  open when closed, no-op when already open.
- Picker: `↑/↓` select task, `→`/`Enter` enter root, `Esc` minimize.
- Root: `↑/↓` select row, `→`/`Enter` push agent view, `←`/`Esc` back to picker, `r` force refresh.
- Agent view: `↑/↓`/`PgUp`/`PgDn` scroll, `g/G` top/bottom, `←`/`Esc` pop to root.
- The component never blocks the loop: it's read-only over the ledger. Closing it leaves the
  headless foreman subprocess running untouched.

### B4. Which task does it open?

**v1 ships the task picker.** On open, the dashboard lists all tasks in `cwd` (scan
`.pi/plans/*/state.json`, including done ones, newest-updated first) as the first screen; selecting
one enters its mission-control root view. `←`/`Esc` from the root returns to the picker; `Esc` from
the picker minimizes. (So the nav stack is: picker → root → agent view.)

## Phase C — Footer statusline (always-on, no dashboard needed)

The ctrl+b dashboard is a deliberate, full-screen drill-down. Phase C surfaces the same live
signal **without opening anything**, on pi's footer status bar (`ctx.ui.setStatus(key, text)` —
renders extension statuses as one line, ANSI preserved, no-op when `hasUI` is false).

```
foreman  ⠋ Pimote daemon · R2 dev   ✓ AskUserQuestion parity · done
```

- **Scoped to the calling session.** The foreman tool runs inside the session's own process, so
  the line shows only tasks this session owns (`ownerSessionId`), newest-first. Two sessions in
  one repo each see their own work — never each other's.
- **One segment per task:** `<glyph> <label> · <Rn> <detail>`. The label keeps the task's title
  head (the part before the first `—`/`:`/`.`) so it reads as words, not a mid-word `…`. The
  actively-running task shows its round and the crew agent spawning now (`dev` / `verify` / `test`,
  from `activity.json`); finished/gated tasks show `done` / `ship?` / `plan?` / `stuck`.
- **Live spinner:** while an agent is spawning, the running task's glyph is an animated braille
  spinner (driven by a ~120ms ticker in `index.ts`, accent-colored). Non-live glyphs: `◆` at a gate
  (warning) · `✓` done (success, the green tick) · `⚠` escalated · `·` idle. Overflow past 3 tasks
  collapses into a `+N more` suffix.
- Pushed on every phase transition and at each gate/terminal return (`done()`), plus the spinner
  ticker during agent runs. Stale `activity.json` (older than ~20s — a crashed run) is not live.
- **Pure model + format** live in `dashboard/reader.ts` (`buildStatuslineModel`, `formatStatusline`
  with an injectable colorizer + spinner `frame`) so they unit-test headlessly; `index.ts` reads
  `ctx.ui.theme` and calls `setStatus`.

**Why not an interactive statusline?** pi's footer/widgets are render-only — keyboard focus goes to
the editor or a `custom()` takeover, never the footer (verified in `interactive-mode`). So you can't
arrow-key "on" the statusline. Instead, **Ctrl+F jumps straight into the live agent** transcript
(skips picker→root), and the agent view now **follows the live run**: it retargets to the current
phase/round's transcript as the loop advances and auto-tails new output (press `G` to re-follow
after scrolling up). That removes the old "Esc and re-enter to see updates" friction. The full
developer/tester/verify drill-down still lives in the ctrl+b dashboard.

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

(All resolved with the founder: Ctrl+B shortcut — Alt+T dropped (macOS Option ≠ Alt), Ctrl+T dropped
(reserved built-in, hard-blocked); task picker in v1; transcripts machine-local.)

## Out of scope (v1)
Cross-project global dashboard; editing/steering agents from the view (read-only only);
rendering live in the *headless* process (it has no TTY — interactive session only); overlay/
floating mode (explicitly rejected in favor of a real view switch).
