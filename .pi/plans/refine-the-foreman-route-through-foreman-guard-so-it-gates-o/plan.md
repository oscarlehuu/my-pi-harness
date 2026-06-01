# Plan: Refine the Foreman route-through-foreman guard so it gates on impact mechanically by path. In extensions/foreman/guard.ts, add a pure exported isNoImpactPath(absPath, { repoRoot, scratchDirs }) with normalized path/dir-boundary comparisons: scratch paths are no-impact; repoRoot null means no-impact; inside repo only prose by extension/known-name is no-impact (.md/.markdown/.mdx/.txt/.rst/.adoc and LICENSE/LICENCE/COPYING/NOTICE/AUTHORS with or without extension). Add an exported resolver or context support so pure logic is testable without fs/git and default resolver walks up for .git. Update classifyToolCall({ toolName, input }, context?) so edit/write resolve target paths against cwd and gate only impactful in-repo paths; bash keeps existing mutation detection but if all extractable write targets are no-impact then gate:false, otherwise conservative gate:true; read-only tools unchanged; gated reason text still mentions foreman(. Wire extensions/foreman/index.ts tool_call handler to pass real context { cwd: ctx.cwd, findRepoRoot: walk up from path for .git, scratchDirs: [os.tmpdir(), process.env.TMPDIR, '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'].filter(Boolean) }, keeping FOREMAN_CREW==='1' and directMode early returns unchanged. Extend extensions/foreman/test/guard_test.sh hermetically to inject repoRoot/scratchDirs and assert scratch/out-of-repo/prose no-impact, code/config gated, repo boundary, classify edit/write behavior, bash redirects/sed behavior, and preserve existing assertions. Do not touch ledger/gates/fallback except ensure they pass.

## Summary (fallback)
Implement the requested task in /Users/a1241968/Desktop/Oscar/my-pi-harness using the backend track, then verify it through Foreman's deterministic dev/test loop.

## Steps
1. Confirm the relevant files and constraints before editing.
2. Developer implements the smallest scoped change and records a structured handoff.
3. Controller runs the proposed per-round command gates and treats their exit codes as ground truth.
4. Tester judges intent, catches cheats, and sends failures back for another bounded fix round.
5. If verification succeeds, pause at Gate 2 for founder ship approval.

## Risks
- Planner model output was unavailable or invalid, so this deterministic template plan was used.
- Repo-specific edge cases may still be discovered by the developer/tester loop.

## Proposed gates
- verify (per-round command) — command: `bash extensions/foreman/test/guard_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/fallback_test.sh`

## Proposed manifest
- Will write proposed .pi/foreman.json only after Gate 1 approval.

## Execution
- Working directory: /Users/a1241968/Desktop/Oscar/my-pi-harness
- Track: backend
- Developer: openai-codex/gpt-5.5:xhigh implements; controller-owned gates remain ground truth.
- Tester: cliproxy/claude-opus-4-8:high judges intent and catches cheats.
- Up to 3 fix rounds, then escalate.
