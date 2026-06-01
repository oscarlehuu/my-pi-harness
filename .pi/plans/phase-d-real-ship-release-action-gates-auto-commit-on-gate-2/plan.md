# Plan: Phase D — Real ship: release action gates (auto-commit on Gate 2 approval) for the Foreman orchestrator (repo: my-pi-harness, extension: extensions/foreman). SCOPE = MINIMAL: git commit only. NO push, NO branch creation, NO PR.

GOAL: Today when the founder approves Gate 2 (ship), the controller just marks the ledger state "done" and emits "SHIPPED" — it does NOT touch git; the founder still hand-commits. Phase D makes ship REAL: on Gate 2 approval, run declared RELEASE-stage ACTION gates. The one built-in action is "commit": stage a SAFE, SCOPED set of paths and create a conventional commit whose message is synthesized from the task + handoffs. The gate engine already supports kind:"action" and stage:"release" (added in Phase A) but nothing executes them yet.

CONTEXT YOU MUST READ FIRST (do real recon):
- extensions/foreman/index.ts — find the Gate 2 approval path: the block `if (state.state === "awaiting_ship")` with `params.approve` that sets state="done", logs gate2_approved + task_done, emits "SHIPPED. Task done." That is where release action gates must run. Note the `gates` variable (populated by refreshGates()/loadGates) is in scope there. Also study how developer handoffs are stored (writeHandoff / listHandoffs / the handoffs/ dir + Handoff.filesChanged) so the commit message + stage scope can be derived.
- extensions/foreman/gates.ts — Gate type: kind "command"|"judge"|"action", stage "per-round"|"pre-ship"|"release", optional `action?` field. gatesForStage(gates,"release") selects release gates. Do NOT modify gates.ts except — IF strictly necessary — to add an OPTIONAL `paths?: string[]` field to the Gate interface for the commit action's stage scope (optional, backward-compatible; if you add it, update normalizeGate to carry it through for action gates only, and keep all existing gates_test.sh passing). Prefer adding it since the commit action needs an optional path override.
- extensions/foreman/planner.ts / reviewer.ts — the PURE-helper module pattern (node-builtins only, headless-testable). Phase D's pure logic goes in a NEW module extensions/foreman/ship.ts in the same style.
- extensions/foreman/test/gates_test.sh, planner_test.sh — the headless node test style to mirror.

DELIVERABLES:

1) NEW extensions/foreman/ship.ts — PURE helpers (node-builtins only; NO pi imports; no child_process calls inside the pure helpers):
   - buildCommitMessage({ task, slug, track, filesChanged, reviewerSummary }) => string. Produces a conventional-commit message:
       subject: `<type>(foreman-task): <short summary>` where <type> is inferred deterministically from the task text — "fix" if it mentions fix/bug, "feat" if add/implement/feature/new, else "chore"; <short summary> = first meaningful line of the task, trimmed to ~72 chars.
       body: a short bullet list of filesChanged (deduped) + a line noting it shipped via Foreman (slug, track) + reviewerSummary if present. Keep deterministic + testable.
   - inferCommitType(task) => "feat"|"fix"|"chore" (exported; used by buildCommitMessage and tested directly).
   - resolveStagePaths({ gatePaths, filesChanged, ledgerRelDir }) => string[]. SAFETY-CRITICAL: returns the pathspecs to `git add`. If gatePaths (the action gate's optional `paths`) is non-empty, use exactly those. Otherwise derive from filesChanged (parse each handoff entry, which looks like "path - description" or "path", taking the leading path token), de-duplicated, PLUS always include ledgerRelDir (the task's .pi/plans/<slug> dir so the ledger travels with the commit). NEVER return ["-A"], ["."], or anything that stages the whole tree — if nothing resolves, return just [ledgerRelDir]. This is the guard against sweeping in concurrent sessions' files.
   - decideShipCommit({ isGitRepo, hasReleaseCommitGate, stagedCount }) => { commit: boolean, reason: string }. commit only when isGitRepo && hasReleaseCommitGate && stagedCount > 0; otherwise commit:false with a clear reason ("no release commit gate declared" | "not a git repo" | "nothing to stage").

2) WIRE into index.ts at the Gate 2 approval (awaiting_ship + params.approve) path:
   - After the founder approves, BEFORE (or right as) marking done, select release action gates: gatesForStage(gates, "release").filter(kind==="action"). If NONE declared => behavior is IDENTICAL to today (mark done, emit SHIPPED, no git). This is the backward-compatible default.
   - For an action gate with action==="commit": gather filesChanged from this task's developer handoffs (read the handoffs/ dir for role "developer", collect Handoff.filesChanged); compute stagePaths via resolveStagePaths (gate.paths override if present); run `git rev-parse --is-inside-work-tree` to check isGitRepo; `git add -- <stagePaths>`; count staged via `git diff --cached --name-only`; if decideShipCommit says commit, build the message and run `git commit -m <subject> -m <body>` (use spawn with arg arrays — NEVER shell-interpolate the message; no `shell:true` for the commit to avoid injection). Capture the commit SHA (`git rev-parse HEAD`).
   - An UNKNOWN action (action !== "commit") is logged + skipped (do not fail ship). 
   - SAFETY: the commit is BEST-EFFORT and must NEVER block or reverse "done". The founder already approved ship; mark the task done regardless, then report the commit outcome (SHA on success; the decideShipCommit/why-skipped reason otherwise) in the emitted text and via appendLog events (e.g. release_commit_ran with sha/decision). A git error is caught and reported, not thrown.
   - Spawn git from the controller via child_process (this is the orchestrator, not a pi tool call, so the route-through-foreman guard does not intercept it). NO push, NO branch, NO PR in this phase.

STRICT CONSTRAINTS:
- Minimal blast radius: do NOT change the ActivityPhase union, the Handoff/ledger schema (you only READ handoffs), guard.ts, reviewer.ts, planner.ts, the dashboard, or any crew/*.md. The only allowed change outside index.ts + new ship.ts is the OPTIONAL `paths?: string[]` addition to the Gate interface in gates.ts (backward-compatible) if you implement the gate.paths override.
- Backward compatibility (critical): a repo with NO release action gate behaves EXACTLY as today on Gate 2 approval. Existing gate_flow_test.sh must still pass (it approves Gate 2 and expects "done" with no commit side effects in its temp repo — make sure no release gate is implied there).
- Never stage the whole tree (no git add -A/./:); commit message passed as argv (no shell injection); commit failure is non-fatal and never un-does "done".
- Quota safety / read-only posture unchanged for crew.

TEST (create + make this the verify target): extensions/foreman/test/ship_test.sh — headless node test (style of planner_test.sh/gates_test.sh) importing the pure helpers from ship.ts:
- inferCommitType: "Fix the crash..." => "fix"; "Add a reviewer role..." / "implement..." => "feat"; "Refactor docs" => "chore".
- buildCommitMessage: subject is conventional `<type>(foreman-task): ...` ≤ ~72 chars; body includes the filesChanged bullets + the slug; deterministic for fixed input.
- resolveStagePaths: gatePaths override wins; else filesChanged leading tokens + ledgerRelDir, deduped; empty input => [ledgerRelDir]; NEVER returns "-A"/"."/":" .
- decideShipCommit: commit true only when isGitRepo && hasReleaseCommitGate && stagedCount>0; each false branch yields the right reason.
Also run ALL existing suites in the verify command so nothing regressed.

End with the mandatory DEV-JSON machine block.

## Summary (planner)
Phase D makes Gate 2 ship REAL with a minimal git-commit-only action gate. Add a pure ship.ts helper module (inferCommitType, buildCommitMessage, resolveStagePaths, decideShipCommit), an optional backward-compatible paths? field on the Gate interface, and wire RELEASE-stage action gates into the awaiting_ship+approve branch of index.ts so that on approval the controller stages a SAFE scoped pathspec (handoff filesChanged + ledger dir, never the whole tree) and creates a conventional commit via argv (no shell injection). The commit is best-effort and never blocks or reverses 'done'; with no release action gate declared, behavior is byte-identical to today. A new headless ship_test.sh covers the pure helpers and is added to the verify chain alongside all existing suites.

## Steps
1. gates.ts: add optional `paths?: string[]` to the Gate interface and, in normalizeGate's action branch ONLY, carry it through conditionally (spread only when value.paths is a non-empty string array) so gates_test.sh's deepEqual on action gates without paths still passes.
2. Create extensions/foreman/ship.ts (pure, node-builtins only, no pi/child_process): inferCommitType(task) => fix|feat|chore (fix if /fix|bug/i, feat if /add|implement|feature|new/i, else chore); buildCommitMessage({task,slug,track,filesChanged,reviewerSummary}) => `<type>(foreman-task): <summary>` subject (<=72 chars, first meaningful task line) + body with deduped filesChanged bullets, a 'Shipped via Foreman (slug, track)' line, and reviewerSummary if present; resolveStagePaths({gatePaths,filesChanged,ledgerRelDir}) => use gatePaths verbatim if non-empty, else leading path token of each filesChanged entry (split on ' - '/' ') deduped PLUS ledgerRelDir, never '-A'/'.'/':', empty => [ledgerRelDir]; decideShipCommit({isGitRepo,hasReleaseCommitGate,stagedCount}) => commit only when all true & stagedCount>0 else {commit:false, reason}.
3. Wire index.ts at the `state.state==="awaiting_ship"` + `params.approve` branch (index.ts:988-995): after approval select gatesForStage(gates,'release').filter(g=>g.kind==='action'); if empty, keep today's exact behavior. For action==='commit': read developer handoffs (listHandoffs -> JSON.parse each under taskDir/handoffs, role==='developer') and collect filesChanged; compute stagePaths via resolveStagePaths (gate.paths override); add a local async git runner using spawn(arg-array, shell:false); run `git rev-parse --is-inside-work-tree`, `git add -- <stagePaths>`, count `git diff --cached --name-only`; if decideShipCommit.commit, buildCommitMessage and `git commit -m <subject> -m <body>` then capture `git rev-parse HEAD`. Unknown action => appendLog+skip. ALWAYS mark done first/regardless; report SHA or skip/why reason in emit and appendLog (release_commit_ran with sha/decision); catch git errors (non-fatal).
4. Create extensions/foreman/test/ship_test.sh mirroring planner_test.sh/gates_test.sh: assert inferCommitType cases (fix/feat/chore), buildCommitMessage subject format/length + body contains filesChanged bullets and slug + determinism, resolveStagePaths (gatePaths wins; else leading tokens + ledgerRelDir deduped; empty => [ledgerRelDir]; never -A/./:), and decideShipCommit truth table with correct reasons.
5. Run the full suite (ship_test.sh + all existing suites) to confirm no regressions, especially gates_test.sh (paths backward-compat) and gate_flow_test.sh (no release gate => done with no commit side-effects).

## Files likely
- `extensions/foreman/ship.ts`
- `extensions/foreman/index.ts`
- `extensions/foreman/gates.ts`
- `extensions/foreman/test/ship_test.sh`

## Risks
- gates_test.sh step 1 deepEquals action gates that have no `paths`; normalizeGate must add `paths` only when present or the existing assertion breaks.
- Backward compat: gate_flow_test.sh's temp repo has no .pi/foreman.json (legacy verify gate only), so release-action selection must be empty and Gate 2 must stay identical (done, no commit, protected-fixture hash unchanged).
- Safety: resolveStagePaths must NEVER yield -A/./: and the commit message must be passed as argv (spawn shell:false) to avoid sweeping concurrent sessions' files or shell injection.
- Commit must be strictly best-effort: any git failure is caught/reported and must never block or reverse state='done'.
- reviewerSummary is not cleanly in scope at the awaiting_ship resume path (reviewer handoffs are stored as role:'tester'); pass last tester summary or undefined — buildCommitMessage treats it as optional.
- ship_test.sh does not exist yet; it is a deliverable and is added to the verify chain (controller legacy fallback already lists it first). proposedGates reflects the existing .pi/foreman.json verify gate and does not overwrite the file; appending ship_test.sh to that gate is an intended in-task edit, not an auto-overwrite.

## Proposed gates
- verify (per-round command) — command: `grep -q "claude-opus-4-8:xhigh" extensions/foreman/crew/planner.md && bash extensions/foreman/test/planner_timeout_test.sh && bash extensions/foreman/test/planner_test.sh && bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/reviewer_test.sh && bash extensions/foreman/test/guard_test.sh && bash extensions/foreman/test/fallback_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/dashboard/test/reader_test.sh`

## Proposed manifest
- Existing .pi/foreman.json is present and will be preserved.

## Execution
- Working directory: /Users/a1241968/Desktop/Oscar/my-pi-harness
- Track: backend
- Developer: openai-codex/gpt-5.5:xhigh implements; controller-owned gates remain ground truth.
- Tester: cliproxy/claude-opus-4-8:high judges intent and catches cheats.
- Up to 3 fix rounds, then escalate.
