# Plan: Phase B of the Foreman Dashboard (full spec at extensions/foreman/docs/DASHBOARD-SPEC.md, section "Phase B — The dashboard"). Phase A is already shipped: foreman now writes .pi/plans/<slug>/transcripts/*.jsonl (one JSON event per line: agent_start, tool_call, tool_result, text, usage, agent_end) and .pi/plans/<slug>/activity.json ({updatedAt, round, phase, activeTranscript, note, pid}). Build the navigable TUI dashboard that reads these.

ARCHITECTURE (mirror the AskUserQuestion extension's split — pure logic vs TUI):
1. NEW FILE extensions/foreman/dashboard/reader.ts — PURE functions over the ledger files, NO pi/TUI imports (so it's unit-testable headless, exactly like extensions/AskUserQuestion/logic.ts). Export:
   - listTasks(cwd): scan .pi/plans/*/state.json, return [{slug, task, state, round, maxRounds, gate1Approved, gate2Approved, updatedAt, verifyCommand}] sorted by updatedAt desc (include done tasks).
   - readActivity(cwd, slug): parse activity.json or null.
   - listRuns(cwd, slug): list transcripts/*.jsonl as [{file, role, round, sessionId}] parsed from the filename, sorted chronologically.
   - readTranscript(cwd, slug, file): parse a transcript .jsonl into an array of typed events (tolerate partial/last-line-truncated files — skip unparseable lines).
   - buildRootRows(cwd, slug): merge log.jsonl + handoffs/ + activity.json into ordered rows [{round, kind: "developer"|"verify"|"tester", status, summary, live:boolean, transcriptFile?}] for the orchestrator view; the row matching activity.activeTranscript while phase!="idle" is live=true.
   Keep these pure and defensive (missing files => empty/null, never throw).

2. NEW FILE extensions/foreman/dashboard/view.ts — the TUI component (a Container subclass implementing Focusable). It manages a NAVIGATION STACK with three levels: "picker" (list tasks) -> "root" (orchestrator mission control for one task) -> "agent" (one transcript, full). Keys:
   - picker: up/down select task, right/enter -> root, esc -> done() (minimize/close).
   - root: up/down select row, right/enter -> push agent view for that row's transcript, left/esc -> back to picker, r -> force refresh.
   - agent: up/down + pageUp/pageDown scroll, g/G top/bottom, left/esc -> pop to root.
   Use viewport height from tui.terminal.rows (and width passed to render) for scrolling math. Re-render via tui.requestRender(). Render tool-call lines in the agent view similarly to how extensions/subagent/index.ts formats them (a formatToolCall-style helper) and assistant text as plain/markdown. Show a running indicator on live rows/runs.

3. LIVE TAILING: the component polls the ledger on a setInterval (e.g. 600ms) while mounted, rebuilds the current view's model via reader.ts, and calls tui.requestRender() if content changed. Clear the interval in a dispose()/close path so it never leaks after done() is called.

4. WIRE IT UP in extensions/foreman/index.ts: register a keyboard shortcut via pi.registerShortcut("alt+t", { description: "Foreman dashboard", handler }). The handler mounts the component with ctx.ui.custom((tui, theme, keybindings, done) => new ForemanDashboard(...)) — DEFAULT mode (full editor takeover, NOT overlay). Guard: if !ctx.hasUI, do nothing. If a dashboard is already open, the shortcut is a no-op (track an isOpen flag). The component reads tasks from ctx.cwd.

PI TUI API FACTS (verified — use these, don't reinvent):
- ctx.ui.custom(factory) is async/blocking; factory signature is (tui, theme, keybindings, done) => Component; call done(value) to close and restore the editor.
- Component interface: render(width:number):string[] (each line <= width — use truncateToWidth/visibleWidth from @earendil-works/pi-tui), handleInput(data:string), invalidate().
- Input: import { matchesKey, Key } from "@earendil-works/pi-tui"; e.g. matchesKey(data, Key.up), Key.pageUp, Key.left, Key.escape, Key.enter. Plain letters: data === "r" / "g" / "G".
- Dimensions: tui.terminal.rows and tui.terminal.columns. Re-render: tui.requestRender().
- Building blocks: Container, Text, Spacer, Markdown from @earendil-works/pi-tui; getMarkdownTheme from @earendil-works/pi-coding-agent. theme.fg(color,text) for color (success/error/warning/accent/muted/dim/toolTitle/toolOutput/text). theme.bg only with allowed names (selectedBg, etc.).
- The shortcut "alt+t" is confirmed free in pi's default keybindings.

CONSTRAINTS: Do NOT modify the foreman loop control flow, gate logic, verdict parsing, runAgent capture, or ledger writers from Phase A — Phase B is READ-ONLY over the ledger plus the shortcut registration. Keep reader.ts free of pi/TUI imports. Build only what the spec describes; no extra features.

TESTS: Add extensions/foreman/dashboard/test/reader_test.sh following the exact pattern of extensions/AskUserQuestion/test/logic_test.sh (a bash script that runs `node --input-type=module` importing reader.ts via pathToFileURL and asserts with node:assert/strict). It must: seed a temp .pi/plans/<slug>/ with a state.json, a log.jsonl, a handoffs/ file, an activity.json, and a transcripts/*.jsonl containing a few events; then assert listTasks, readActivity, listRuns, readTranscript (including that it skips a deliberately truncated final line), and buildRootRows (including that the live row is flagged from activity.json). Pure functions only — no TTY.

Verify command: bash extensions/foreman/dashboard/test/reader_test.sh && bash extensions/foreman/test/gate_flow_test.sh (both must exit 0 — the existing gate-flow acceptance must still pass unchanged).

- Working directory: /Users/a1241968/Desktop/Oscar/my-pi-harness
- Verify command: bash extensions/foreman/dashboard/test/reader_test.sh && bash extensions/foreman/test/gate_flow_test.sh
- Developer: openai-codex/gpt-5.5:xhigh implements; controller runs verify (exit code = ground truth).
- Tester: cliproxy/claude-opus-4-8:high judges intent and catches cheats.
- Up to 3 fix rounds, then escalate.

