# Plan: Add a Pimote phone-bridge to the AskUserQuestion extension (extensions/AskUserQuestion/index.ts), committed and tested as a proper harness change. A reference implementation already exists in git stash@{0} of THIS repo (run `git stash show -p stash@{0}` to read it) — reproduce that work cleanly, adapting to harness conventions. Do NOT pop/drop the stash; treat it as read-only reference. Final code must be a deliberate, reviewed reimplementation, not a blind `git stash apply`.

BACKGROUND: pi's AskUserQuestion tool renders a multi-question dialog via ctx.ui.custom(), which returns undefined in `pi --mode rpc`. The companion Pimote project (a phone client + daemon, already shipped on its side) speaks a WebSocket protocol to a local daemon. We want AskUserQuestion to ALSO offer its questions to the phone so they can be answered remotely, while keeping the existing local terminal dialog and headless fallback fully intact.

WHAT TO BUILD (mirrors stash@{0}; verify against it):
1) In execute(): after the existing guards (empty questions, signal.aborted), start a REMOTE dialog (startRemoteDialog) in parallel with the local one. 
   - If ctx.hasUI: race local (ctx.ui.custom) vs remote via Promise.race; whichever answers first wins, tear down the loser; if remote returns "unavailable", fall back to awaiting the local dialog. 
   - If NOT hasUI: await remote; on answered → answeredResult; on dismissed → cancelledResult; otherwise the existing nonInteractiveResult headless fallback.
2) startRemoteDialog/connectRemoteDialog: read the Pimote daemon handshake at ~/.pi/pimote/daemon.json ({ port, token }); open ws://127.0.0.1:<port>/?token=<token> using the runtime global WebSocket (guard if absent). On open, send { op: "ext_register", role: "ask", sessionFile } then { op: "ask_start", sessionFile, requestId, questions } where sessionFile = ctx.sessionManager.getSessionFile() (if undefined, treat remote as unavailable). Apply a connect timeout (~1.5s) so a missing/unreachable daemon degrades to local/headless quickly. Resolve "answered" on { op: "ask_answer" } with matching sessionFile+requestId, "dismissed" on { op: "ask_dismiss" }, "unavailable" on handshake/ws/timeout failure. Abort cleanly on signal. NEVER throw out of execute(): every failure path must fall back to existing behavior.
3) Map the remote answer back into logic.ts SelectionState[] (remoteAnswerToStates): for each question in order, resolve selected option labels → indexes, custom free-text → the custom option index + customText, per-choice notes by label; pass through normalizeSelectionState / createInitialSelectionState / getCustomOptionIndex / buildStructuredResult from ./logic.ts. logic.ts stays the SINGLE source of truth — do not fork or duplicate result-shaping. Do NOT modify logic.ts.
4) Keep all new networking types LOCAL to index.ts (SocketLike, RemoteDialog* types, handshake reader, helpers). Keep the change additive and defensive; the existing AskUserQuestionDialog (local TUI) and its behavior must be unchanged. Do not add new npm deps (use node:fs/promises, node:os, node:path, and the global WebSocket only).

CONVENTIONS: Match the existing file style. Respect test/logic_test.sh constraints — notably it lints theme.bg("…") calls to an allowlist (selectedBg, userMessageBg, customMessageBg, toolPendingBg, toolSuccessBg, toolErrorBg); the bridge code must not introduce disallowed theme.bg names (it shouldn't use theme at all). The harness installs via symlink, so editing extensions/AskUserQuestion/index.ts updates the live extension automatically.

VERIFICATION: the extension is loaded by pi at runtime (no local tsc/types for @earendil-works/pi-* — that's expected). Validate by (a) running the existing bash test extensions/AskUserQuestion/test/logic_test.sh and (b) a TypeScript type-strip/transpile syntactic check of index.ts (0 syntactic diagnostics), since full typecheck can't resolve pi's modules. Both are in the verifyCommand.

## Summary (fallback)
Implement the requested task in /Users/a1241968/Desktop/Oscar/my-pi-harness using the backend track, then verify it through Foreman's deterministic dev/test loop.

## Steps
1. Confirm the relevant files and constraints before editing.
2. Developer implements the smallest scoped change and records a structured handoff.
3. Controller runs the resolved per-round command gates and treats their exit codes as ground truth.
4. Tester judges intent, catches cheats, and sends failures back for another bounded fix round.
5. If verification succeeds, pause at Gate 2 for founder ship approval.

## Files likely
- (not identified by planner)

## Risks
- Planner model output was unavailable or invalid, so this deterministic template plan was used.
- Repo-specific edge cases may still be discovered by the developer/tester loop.

## Requirements
- (none detected)

## Proposed gates
- verify (per-round command) — command: `grep -q "claude-opus-4-8:xhigh" extensions/foreman/crew/planner.md && bash extensions/foreman/test/planner_timeout_test.sh && bash extensions/foreman/test/planner_test.sh && bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/reviewer_test.sh && bash extensions/foreman/test/guard_test.sh && bash extensions/foreman/test/fallback_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/dashboard/test/reader_test.sh`
- review (pre-ship judge) — agent: reviewer
- commit (release action) — action: `commit`

## Proposed manifest
- Existing .pi/foreman.json is present and will be preserved.

## Execution
- Working directory: /Users/a1241968/Desktop/Oscar/my-pi-harness
- Track: backend
- Developer: openai-codex/gpt-5.5:xhigh implements; controller-owned gates remain ground truth.
- Tester: cliproxy/claude-opus-4-8:high judges intent and catches cheats.
- Up to 3 fix rounds, then escalate.
