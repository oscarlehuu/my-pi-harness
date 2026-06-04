# Plan: Fix the AskUserQuestion extension so that opening an agent FROM THE PHONE (a daemon-spawned `pi --mode rpc` subprocess) no longer instantly auto-cancels the question with "User cancelled AskUserQuestion" before the phone can render the interactive picker.

REPO: This extension lives in /Users/a1241968/Desktop/Oscar/my-pi-harness (the file is extensions/AskUserQuestion/index.ts). Make the change THERE, in that repo. (It is symlinked into ~/.pi/agent/extensions/AskUserQuestion, but edit the my-pi-harness source.)

ROOT CAUSE (confirmed by tracing + an empirical probe):
- When the Pocket Pi daemon opens an agent on behalf of the phone, it spawns pi as `node .../pi/dist/cli.js --mode rpc` with piped stdio (no real TTY).
- In `--mode rpc`, pi reports `ctx.hasUI === true` to extensions (it assumes an RPC UI bridge), and pi DOES emit extension_ui_request events. BUT the daemon never actually services a `ctx.ui.custom(...)` request (its handled set is only select/confirm/input/editor; "custom" is not serviced), so pi resolves the local `ctx.ui.custom<DialogResult>()` promise to `null` almost immediately.
- In AskUserQuestion's execute(), because ctx.hasUI is true, it takes the RACE path:
    const local = startLocalDialog(ctx, questions);
    const first = await Promise.race([
      local.promise.then(r => ({source:"local", result:r})),
      remote.promise.then(r => ({source:"remote", result:r})),
    ]);
  The local promise resolves to `null` in ~0ms and WINS the race. The final block then does:
    remote.cancel("Answered in the local terminal.");
    if (!first.result) { return cancelledResult(questions, local.initialStates, "User cancelled AskUserQuestion."); }
  => it cancels the remote phone dialog AND returns "User cancelled AskUserQuestion" in 0.0s. The phone shows raw JSON and the question is gone. This is exactly the founder's repro: open the session ON THE PHONE, the question never renders and is auto-cancelled.

KEY INSIGHT: a `null` local result that arrives effectively instantly is NOT a real user cancellation — a human cannot have cancelled a dialog that mounted 0ms ago. It only means the local `ctx.ui.custom` path is non-interactive in this (daemon/rpc) context. So a null/instant local result must NOT cancel or outrank the remote phone path.

REQUIRED FIX (in execute(), the ctx.hasUI race path ONLY — do not touch the `if (!ctx.hasUI)` branch):
Change the race resolution so that:
1. If the LOCAL dialog wins with a real answer (first.source === "local" && first.result is non-null) -> keep current behavior: remote.cancel("Answered in the local terminal.") and return answeredResult(questions, first.result.states).
2. If the LOCAL dialog "wins" with a null result (first.source === "local" && !first.result) -> do NOT treat this as a user cancel and do NOT cancel the remote. Instead, AWAIT the remote.promise and resolve from it:
   - remote answered -> answeredResult(questions, remoteResult.states)
   - remote dismissed -> cancelledResult(questions, createInitialNavigationState(questions).states, remoteResult.reason)  (this is a real dismissal coming from the phone, e.g. user tapped dismiss)
   - remote unavailable/non-interactive -> nonInteractiveResult(questions)  (genuinely headless: neither local nor remote can serve)
3. If the REMOTE wins first (first.source === "remote"): keep the existing behavior, EXCEPT when remote is unavailable. Currently on remote "unavailable" it does `const localResult = await local.promise; if (!localResult) return cancelledResult(... "User cancelled AskUserQuestion.")`. That also mislabels an instant local null as a user cancel. Fix it so that when remote is unavailable AND the local result is null (non-interactive local), it returns nonInteractiveResult(questions) instead of "User cancelled AskUserQuestion." Keep: if local returned a real answer, return that answer; if remote answered, return it; if remote was a real user dismiss, return the dismiss reason.

NET EFFECT:
- Phone-opened agent (local custom UI non-functional, remote viable): question stays alive and is answered/dismissed by the phone. No more instant "User cancelled".
- Real terminal session with a working local TUI: local answer still wins instantly and is returned (unchanged).
- Genuinely headless (no local TTY AND no phone connected/viewing): returns nonInteractiveResult, NOT a false "User cancelled".
- A real user dismiss from the phone still returns a cancelled/dismissed result with the phone's reason.

CONSTRAINTS:
- Only edit extensions/AskUserQuestion/index.ts in my-pi-harness, only inside execute() (the ctx.hasUI race path and the remote-unavailable sub-branch). Do not change startLocalDialog, startRemoteDialog, connectRemoteDialog, the daemon, or the pimote repo.
- Do not introduce arbitrary time delays/sleeps to "win" the race; fix it by treating a null local result as non-authoritative and deferring to the remote, as described. (You may rely on the fact that startLocalDialog's promise resolves null on a non-interactive/cancelled custom UI.)
- Preserve the existing `if (!ctx.hasUI)` headless branch exactly.
- Keep helper result builders (answeredResult, cancelledResult, nonInteractiveResult, createInitialNavigationState) as the return shapes.

VERIFY: There is a logic test in extensions/AskUserQuestion/test/. Run the repo's existing AskUserQuestion test(s) and typecheck if available; at minimum ensure node can parse/typecheck the file. Describe the before/after race behavior in the summary. After this ships, the founder will reinstall by restarting a pi session so the symlinked extension reloads.

File: /Users/a1241968/Desktop/Oscar/my-pi-harness/extensions/AskUserQuestion/index.ts (execute() ~lines 859-892).

## Summary (planner)
Fix the instant 'User cancelled AskUserQuestion' that occurs when an agent is opened from the phone (daemon-spawned `pi --mode rpc`). In execute()'s ctx.hasUI race path, startLocalDialog's ctx.ui.custom resolves to null in ~0ms (custom UI is non-interactive in rpc), wins the Promise.race, and the final block cancels the remote phone dialog and returns a false user-cancel. Treat a null local result as non-authoritative: when local 'wins' with null, await the remote and resolve from it (answered/dismissed/unavailable); when remote is unavailable AND local is null, return nonInteractiveResult instead of a false cancel. A real local answer still wins instantly (unchanged), a real phone dismiss still returns the phone's reason, and genuinely headless returns nonInteractiveResult. Only extensions/AskUserQuestion/index.ts changes, only inside execute(); the if(!ctx.hasUI) branch, startLocalDialog/startRemoteDialog/connectRemoteDialog, daemon, and pimote are untouched. No sleeps/delays are introduced.

## Steps
1. Re-read execute() race path at index.ts:872-892 and confirm the exact text of the local-null final block (remote.cancel + cancelledResult 'User cancelled AskUserQuestion.') and the remote-unavailable sub-branch (index.ts:877-880).
2. In the remote-unavailable sub-branch: change `if (!localResult) return cancelledResult(questions, local.initialStates, "User cancelled AskUserQuestion.")` to return nonInteractiveResult(questions) when the awaited local result is null; keep `return answeredResult(questions, localResult.states)` when local has a real answer.
3. Replace the trailing local-win block: keep `if (first.result) { remote.cancel("Answered in the local terminal."); return answeredResult(questions, first.result.states); }` for a real local answer; for a null local result do NOT cancel remote — instead `const remoteResult = await remote.promise;` and map answered -> answeredResult(questions, remoteResult.states), dismissed -> cancelledResult(questions, createInitialNavigationState(questions).states, remoteResult.reason), unavailable -> nonInteractiveResult(questions).
4. Confirm createInitialNavigationState is already imported (used at index.ts:864) and that no other helper imports are needed.
5. Syntactic check: `node --check extensions/AskUserQuestion/index.ts` (must exit 0).
6. Run the existing logic suite: `bash extensions/AskUserQuestion/test/logic_test.sh` (expect the two static guards + 'AskUserQuestion pure logic tests passed').
7. Grep to confirm the fix surface: ensure the local-null path no longer yields 'User cancelled AskUserQuestion.', that nonInteractiveResult now appears in the race/unavailable branches, and that 'Answered in the local terminal.' remains only on the real-local-answer path.
8. Write the before/after race-behavior summary (phone-opened: stays alive and answered/dismissed by phone; real terminal: local answer wins instantly, unchanged; headless: nonInteractiveResult; real phone dismiss: cancelled with phone reason).

## Files likely
- `extensions/AskUserQuestion/index.ts`

## Risks
- logic_test.sh does NOT type-check or exercise execute()/the race path — it only greps index.ts (theme.bg allow-list; forbidden whole-question-note literals: question-note|Question note|whole-question|setNote|answer.note|noteParts) and runs logic.ts. Mitigation: keep edits inside execute(), avoid those banned tokens in any new wording, and rely on `node --check` for syntax. Runtime phone behavior is not auto-covered, so describe the before/after manually.
- The .pi/foreman.json `verify` gate runs Foreman's own *_test.sh suite (all present and green-capable) but does NOT run AskUserQuestion's logic_test.sh; the task-relevant checks (logic_test.sh + node --check) are therefore run in-step, not added as a gate. foreman.json is reflected, not overwritten.
- Must preserve exact return shapes: dismissed uses createInitialNavigationState(questions).states (a fresh initial state), NOT local.initialStates — matching the existing !ctx.hasUI dismissed branch; a real local answer must still call remote.cancel('Answered in the local terminal.') to avoid leaking the phone dialog.
- node --check validates TypeScript-as-JS syntax loosely; it will not catch type errors. Acceptable here since the edit only reorders await/branch logic using existing typed helpers and the RemoteDialogResult union (answered|dismissed|unavailable).
- Edit is read-only-planned now; do not touch the if(!ctx.hasUI) branch, startLocalDialog/startRemoteDialog/connectRemoteDialog, the daemon, or the pimote repo per task constraints.

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
