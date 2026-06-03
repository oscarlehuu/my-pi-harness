# Plan: Fix a hang in the AskUserQuestion extension (extensions/AskUserQuestion/index.ts) that breaks Pimote phone answering for TERMINAL/non-canonical session paths.

ROOT CAUSE (verified live): In connectRemoteDialog's websocket "message" handler, the guard is:
    if (frame.sessionFile !== args.sessionFile || frame.requestId !== args.requestId) return;
The extension sends ask_start with args.sessionFile = the RAW path from ctx.sessionManager.getSessionFile() (e.g. "/tmp/foo.jsonl"). The Pimote daemon NORMALIZES that path (realpathSync → "/private/tmp/foo.jsonl" on macOS, also resolves symlinks/trailing slashes) and echoes the NORMALIZED sessionFile back in its ask_answer / ask_dismiss frames. So frame.sessionFile ("/private/tmp/foo.jsonl") !== args.sessionFile ("/tmp/foo.jsonl"), the guard DROPS the reply, and the tool's remote promise never settles → AskUserQuestion hangs forever (tool_execution_start with no end). Proven: daemon echoes "/private/tmp/..." while the extension compares against "/tmp/...". This is why terminal pi sessions can't be answered from the phone (app-started sessions happened to use already-canonical paths).

FIX (surgical, minimal): The requestId is a locally-generated unique id (createRequestId) that is NEVER transformed by the daemon — it is the reliable correlation key. Change the guard in the connectRemoteDialog "message" handler to match on requestId ONLY, and stop requiring sessionFile string equality. Concretely, replace:
    if (frame.sessionFile !== args.sessionFile || frame.requestId !== args.requestId) return;
with:
    if (frame.requestId !== args.requestId) return;

Rationale: requestId uniquely identifies THIS in-flight ask for THIS tool execution; the daemon round-trips it verbatim. sessionFile is redundant for correlation and is actively harmful here because the daemon canonicalizes it. Do NOT otherwise change the handler — ask_answer still maps via remoteAnswerToStates, ask_dismiss still settles unavailable/dismissed as today.

Also audit the rest of connectRemoteDialog for any OTHER place that compares the daemon-returned sessionFile to args.sessionFile for correlation; if found, switch those to requestId matching too. Do NOT change what the extension SENDS (it still sends sessionFile: args.sessionFile in ext_register/ask_start/ask_cancel — the daemon needs that to route; it just normalizes it internally). Do NOT modify logic.ts. Keep everything else (race with local TUI, timeouts, fallbacks) intact.

This is the live extension symlinked into ~/.pi/agent/extensions/AskUserQuestion, so the fix takes effect for new pi sessions immediately. Commit it (the repo's Foreman gates include reviewer + release commit). Verify: the existing logic_test.sh still passes and a transpile/syntactic check of index.ts shows 0 syntactic diagnostics (full typecheck can't resolve pi's @earendil-works/* modules at rest — that's expected).

## Summary (planner)
Fix the Pimote phone-answering hang in extensions/AskUserQuestion/index.ts by changing the connectRemoteDialog websocket 'message' guard from a combined sessionFile+requestId match to a requestId-only match. The daemon canonicalizes the sessionFile (realpathSync, e.g. /tmp -> /private/tmp) and echoes the normalized path, so the string-equality check drops legitimate ask_answer/ask_dismiss frames for TERMINAL/non-canonical sessions and the remote promise never settles. requestId is locally generated and round-tripped verbatim, making it the reliable correlation key. Single-line surgical change at index.ts:739; logic.ts and all other behavior (local/remote race, timeouts, fallbacks, sends) left intact. Verified there is exactly one correlation comparison to fix.

## Steps
1. Read extensions/AskUserQuestion/index.ts around the connectRemoteDialog 'message' handler (line 739) to confirm the exact guard text before editing.
2. Replace the guard `if (frame.sessionFile !== args.sessionFile || frame.requestId !== args.requestId) return;` with `if (frame.requestId !== args.requestId) return;` at index.ts:739.
3. Confirm the audit result: no other correlation comparison of frame.sessionFile vs args.sessionFile exists (the sends at index.ts:724-725 ext_register/ask_start and the ext_unregister/ask_cancel sends must remain unchanged so the daemon can still route).
4. Do not modify logic.ts and do not alter remoteAnswerToStates, ask_answer/ask_dismiss handling, the local-TUI race, connect timeout, or unavailable/dismissed fallbacks.
5. Run the existing logic test: bash extensions/AskUserQuestion/test/logic_test.sh — expect it to still pass.
6. Run the syntactic transpile check of index.ts using the pimote-bundled typescript to confirm 0 syntax (category 1) diagnostics; a full typecheck cannot resolve @earendil-works/* at rest and is expected to be skipped.
7. Stage ONLY extensions/AskUserQuestion/index.ts to avoid sweeping in pre-existing unrelated working-tree changes, then proceed through the Foreman review (pre-ship judge) and commit (release action) gates.

## Files likely
- `extensions/AskUserQuestion/index.ts`

## Risks
- The working tree already contains unrelated uncommitted changes (extensions/foreman/AGENTS.md, extensions/foreman/docs/CHARTER.md, install.sh, a .pi/plans/.../log.jsonl, and prior race-fix edits in index.ts). The 'commit' release gate could include these; the implementer should stage only extensions/AskUserQuestion/index.ts.
- The legacy task verify command asserts BOTH presence of `if (frame.requestId !== args.requestId) return;` AND absence of `frame.sessionFile !== args.sessionFile`; the edit must remove the old guard line entirely (not leave it commented) or the negative grep will fail.
- The transpile check depends on /Users/a1241968/Desktop/Oscar/pimote/packages/app/node_modules/typescript (confirmed present). If the pimote checkout moves or node_modules is cleaned, the syntactic check must fall back to another tsc; full typecheck still cannot resolve pi's @earendil-works/* modules (expected).
- Only a syntactic transpile is validated at rest; runtime correctness of phone answering for non-canonical session paths is not exercised by logic_test.sh, so a behavioral regression in the message handler would not be caught automatically.
- index.ts already shows as modified in git; ensure the diff applied is exactly the one-line guard change and does not conflict with the pre-existing edits.

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
