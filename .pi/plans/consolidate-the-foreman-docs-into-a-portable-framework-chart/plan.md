# Plan: Consolidate the Foreman docs into a portable framework "charter" that is current, split into a kernel + sub-pages with a written split rule, and read by the planner + reviewer crew. (repo: my-pi-harness, extension: extensions/foreman)

BACKGROUND (what exists + what's stale — verify by reading):
- extensions/foreman/docs/CHARTER.md (~123 lines) calls itself "the operating manual for this harness… the reusable IP". It is STALE: its Roles table and loop predate this session's additions. The system now also has: planner (read-only Gate-1 planner, opus-4-8:xhigh), ui-developer (frontend track, gemini-3.5-flash-low:high with Opus fallback), reviewer (pre-ship judge, opus-4-8:xhigh), a generic GATE PIPELINE (gates of kind command|judge|action across stages per-round|pre-ship|release, declared in .pi/foreman.json), a strict DEFINITION OF DONE (done.ts) that gates auto-commit, a route-through-foreman GUARD (guard.ts), and REAL SHIP / auto-commit on Gate 2 (ship.ts release action gate). CHARTER must be brought fully current to describe all of this.
- extensions/foreman/AGENTS.md is the CTO persona auto-loaded as ~/.pi/agent/AGENTS.md; it already references CHARTER as the "Full operating manual" and was partially updated this session (AskUserQuestion gate relay, DoD rationale at Gate 2). Its crew list must be made current (planner, ui-developer, reviewer added).
- extensions/foreman/docs/PHASE2-SPEC.md (pre-build spec, describes a tasks.json that never shipped) and docs/foreman-impact-probe.md (1-line test scratch) are STALE — DELETE both.
- docs/architecture.md is half-stale (says "askuser (planned)", Phase-2 framing). Update to current repo specifics.
- Read the current crew files to get models/roles right: extensions/foreman/crew/{planner,developer,ui-developer,tester,reviewer,scout}.md. Read gates.ts (kinds/stages), done.ts (DoD checks), ship.ts (commit), guard.ts (route-through-foreman) to describe them accurately. Read install.sh to add the new symlink correctly.

DELIVERABLES:

1) RESTRUCTURE CHARTER.md into a KERNEL/INDEX + split sub-pages:
   - Keep in CHARTER.md (the kernel, read top-to-bottom): Principle; the Roles table (FULLY CURRENT — Founder, CTO cliproxy/claude-opus-4-8:xhigh, planner cliproxy/claude-opus-4-8:xhigh read-only, scout cliproxy/gemini-3.5-flash-low:high, developer openai-codex/gpt-5.5:xhigh, ui-developer cliproxy/gemini-3.5-flash-low:high→opus fallback, tester cliproxy/claude-opus-4-8:high, reviewer cliproxy/claude-opus-4-8:xhigh); the Loop (brainstorm→plan→[GATE 1]→implement→verify→test→pre-ship review→(fix↺)→[GATE 2]→ship+auto-commit) with the AskUserQuestion gate relay + DoD rationale at Gate 2; Safety (quota append-only + route-through-foreman guard); and a NEW "## Docs structure" section stating the split rule verbatim intent: "One concept = one ## section. When a section exceeds ~40 lines or needs its own examples/sub-structure, graduate it to docs/charter/<concept>.md, leaving a one-paragraph summary + link here. CHARTER stays the index/kernel. Sections are written self-contained (no cross-references that break when moved)."
   - For the two fattest concepts, write a one-paragraph SUMMARY + link in CHARTER and put the full content in NEW files:
     - extensions/foreman/docs/charter/gate-pipeline.md — the generic gate pipeline: Gate type {name,kind,stage,command?|agent?|action?,paths?}; kinds command|judge|action; stages per-round|pre-ship|release; .pi/foreman.json declaration; how per-round command gates + tester run each round, pre-ship command gates + reviewer run once before Gate 2, release action gates (commit) run on ship; web (playwright) vs mobile (detox/maestro/xcodebuild) E2E examples as pre-ship gates; backward-compat (no foreman.json + verifyCommand => single per-round gate).
     - extensions/foreman/docs/charter/definition-of-done.md — the STRICT DoD: the six checks (plan approved, per-round command gates pass/na, tester success, pre-ship command gates pass/na, reviewer APPROVE when a reviewer gate is declared else n/a, founder Gate-2 approval); done=true only if no blockers; inconclusive reviewer verdict BLOCKS commit (no silent force); recorded in THREE places (auto-commit message body, ledger done_evaluated event with full checklist, and the CTO's conversational relay at Gate 2).
   - CHARTER's existing "two gates" + "Definition of Done" + quota sections should be updated/condensed to reference the new sub-pages where content moved.

2) install.sh — add a symlink so the charter is reachable from a STABLE agent-dir path in ANY repo's cwd (crew run in other repos and can't see extensions/foreman/docs). Symlink extensions/foreman/docs/charter (and CHARTER.md) into the agent dir, e.g. ln -s "$REPO_DIR/extensions/foreman/docs" "$AGENT_DIR/foreman/charter" (mirror the existing link() helper + the foreman agent-dir layout already used for ledger-mirror). Make it idempotent like the other links. Echo it in the install summary.

3) crew prompts — extensions/foreman/crew/planner.md and extensions/foreman/crew/reviewer.md: add a short instruction that they READ THE FRAMEWORK CHARTER when available (at the agent dir, e.g. $PI_CODING_AGENT_DIR or ~/.pi/agent then foreman/charter/CHARTER.md and foreman/charter/charter/*.md) and plan/review WITHIN its rules — the reviewer should CITE a charter rule when a choice violates it (e.g. quota safety, primitives-not-features, strict DoD); the planner should plan within the framework and not re-propose things the charter forbids. Keep it concise, do not bloat the prompts, do not change their model/tools frontmatter. Do NOT make charter-reading hard-fail if the file is absent (best-effort, like other optional context).

4) docs/architecture.md — update to CURRENT repo specifics: pi load model + install symlinks (now including the charter symlink), the domain list (foreman, subagent, AskUserQuestion, grok, codex, antigravity), and the live pipeline summary. Remove the stale "askuser (planned)" line and Phase-2-tense framing. Keep it repo-specific; do NOT duplicate the framework (link to CHARTER instead).

5) DELETE extensions/foreman/docs/PHASE2-SPEC.md and docs/foreman-impact-probe.md. Update any references (README.md line ~17 mentions PHASE2-SPEC in the layout tree; fix it to mention charter/ instead).

6) Update README.md where it lists the foreman docs (the layout tree around line 14-17) to reflect CHARTER + charter/ subdir and the removal of PHASE2-SPEC.

STRICT CONSTRAINTS:
- Accuracy over prose: every model id, role, gate kind/stage, and behavior described MUST match the actual code (gates.ts/done.ts/ship.ts/guard.ts) and crew frontmatter. Cite nothing you didn't verify by reading.
- Do NOT change any .ts logic, gates.ts/index.ts/done.ts/ship.ts/reviewer.ts/planner.ts/guard.ts behavior, the ledger, the dashboard, or .pi/foreman.json. The ONLY non-doc edits allowed are: install.sh (add the charter symlink) and the planner.md + reviewer.md prompt additions (read-the-charter instruction). Everything else is markdown.
- Keep the planner/reviewer model + tools frontmatter unchanged.
- Keep edits tight; do not rewrite unrelated sections or change the existing AskUserQuestion/DoD guidance already in AGENTS.md/CHARTER beyond making the roles/loop current.
- Keep ALL existing test suites passing.

TEST/VERIFY (this is largely a docs+config change; correctness = accuracy + structure). The verify command asserts: CHARTER.md exists and references charter/gate-pipeline.md and charter/definition-of-done.md and contains the split-rule text ("graduate it to"); the two new charter sub-pages exist; PHASE2-SPEC.md and foreman-impact-probe.md are GONE; planner.md and reviewer.md mention the charter; install.sh contains the charter symlink; README no longer references PHASE2-SPEC; and the FULL existing test suite still passes (no code regression). It also asserts no unintended .ts files changed (git diff --name-only for *.ts is empty except none).

End with the mandatory DEV-JSON machine block.

## Summary (planner)
Restructure CHARTER.md into a current kernel/index plus two graduated sub-pages (gate-pipeline, definition-of-done) with a written split rule, delete two stale docs, add a stable charter symlink in install.sh, instruct planner+reviewer to read the charter, and refresh AGENTS.md crew list, architecture.md, and README — all doc/config only, no .ts or foreman.json changes.

## Steps
1. Rewrite extensions/foreman/docs/CHARTER.md as the kernel: keep Principle; make the Roles table FULLY CURRENT (Founder; CTO cliproxy/claude-opus-4-8:xhigh; planner cliproxy/claude-opus-4-8:xhigh read-only; scout cliproxy/gemini-3.5-flash-low:high; developer openai-codex/gpt-5.5:xhigh; ui-developer cliproxy/gemini-3.5-flash-low:high→claude-opus-4-8:xhigh fallback; tester cliproxy/claude-opus-4-8:high; reviewer cliproxy/claude-opus-4-8:xhigh); update the Loop to brainstorm→plan→[GATE 1]→implement→verify→test→pre-ship review→(fix↺)→[GATE 2]→ship+auto-commit, preserving existing AskUserQuestion relay + Gate-2 DoD rationale; keep Safety (append-only quota + route-through-foreman guard); add a new '## Docs structure' section with the split rule verbatim ('One concept = one ## section... graduate it to docs/charter/<concept>.md... CHARTER stays the index/kernel. Sections are written self-contained...').
2. Condense CHARTER's 'two gates' + 'Definition of Done' + 'Quota safety' sections to one-paragraph summaries that link to the new sub-pages where content moved (must include literal substrings 'charter/gate-pipeline.md' and 'charter/definition-of-done.md').
3. Create extensions/foreman/docs/charter/gate-pipeline.md: Gate type {name,kind,stage,command?|agent?|action?,paths?}; kinds command|judge|action; stages per-round|pre-ship|release; .pi/foreman.json declaration; per-round command gates + tester each round, pre-ship command gates + reviewer once before Gate 2, release action gate (commit) on ship; web (playwright) vs mobile (detox/maestro/xcodebuild) E2E examples as pre-ship gates; backward-compat (no foreman.json + verifyCommand => single per-round 'verify' gate) — matching gates.ts loadGates/runCommandGates.
4. Create extensions/foreman/docs/charter/definition-of-done.md: the six checks (plan approved; per-round command gates pass/na; tester success; pre-ship command gates pass/na; reviewer APPROVE when a reviewer gate is declared else n/a; founder Gate-2 approval); done=true only when no blockers; inconclusive reviewer verdict BLOCKS commit (no silent force); recorded in three places (auto-commit message body, ledger done_evaluated event with full checklist, CTO conversational relay at Gate 2) — matching done.ts.
5. Delete extensions/foreman/docs/PHASE2-SPEC.md and docs/foreman-impact-probe.md.
6. Edit install.sh: after the foreman AGENTS.md/crew links, mkdir -p "$AGENT_DIR/foreman" and add link "$REPO_DIR/extensions/foreman/docs" "$AGENT_DIR/foreman/charter" (reuses idempotent link() helper, mirrors ledger-mirror layout); echo the charter link in the install summary.
7. Edit extensions/foreman/crew/planner.md and reviewer.md: add a concise best-effort instruction to read the framework charter when present (agent dir via $PI_CODING_AGENT_DIR or ~/.pi/agent, then foreman/charter/CHARTER.md and foreman/charter/charter/*.md) and plan/review within its rules — planner plans within the framework and avoids charter-forbidden proposals; reviewer cites a charter rule when a choice violates it (quota safety, primitives-not-features, strict DoD). Do not hard-fail when absent. Keep model/tools frontmatter UNCHANGED (planner.md must retain 'claude-opus-4-8:xhigh').
8. Edit extensions/foreman/AGENTS.md crew list to be current: add planner (read-only Gate-1 planner) and reviewer (pre-ship judge) alongside the existing scout/developer/ui-developer/tester entries; keep existing AskUserQuestion/DoD guidance intact.
9. Update docs/architecture.md: remove the stale 'askuser (planned)' line and Phase-2-tense framing; state current domains (foreman, subagent, AskUserQuestion, grok, codex, antigravity), install symlinks now including the charter symlink, and the live gate pipeline summary; link to CHARTER instead of duplicating the framework.
10. Update README.md layout tree (around lines 14-17) to list CHARTER.md + charter/ subdir and the full crew, and remove the PHASE2-SPEC.md mention so README no longer references PHASE2-SPEC.
11. Run the full verify command locally (test -f assertions, greps, git diff --name-only for *.ts and .pi/foreman.json empty, and all ten test suites) to confirm structure + accuracy + no code regression.

## Files likely
- `extensions/foreman/docs/CHARTER.md`
- `extensions/foreman/docs/charter/gate-pipeline.md`
- `extensions/foreman/docs/charter/definition-of-done.md`
- `extensions/foreman/docs/PHASE2-SPEC.md`
- `docs/foreman-impact-probe.md`
- `install.sh`
- `extensions/foreman/crew/planner.md`
- `extensions/foreman/crew/reviewer.md`
- `extensions/foreman/AGENTS.md`
- `docs/architecture.md`
- `README.md`

## Risks
- The per-round verify gate greps planner.md for 'claude-opus-4-8:xhigh'; adding the charter instruction must NOT alter the model frontmatter or that exact string, or the gate fails.
- Verify asserts `git diff --name-only -- '*.ts' '.pi/foreman.json'` is empty — must avoid touching any .ts or the foreman.json (no code/logic edits).
- Symlink target path must stay consistent with crew instructions: linking extensions/foreman/docs to $AGENT_DIR/foreman/charter yields foreman/charter/CHARTER.md and foreman/charter/charter/<page>.md (note the doubled 'charter'); the prompt paths must match this layout.
- Accuracy risk: every model id/gate kind/stage/behavior in the new docs must match gates.ts/done.ts/ship.ts and crew frontmatter; cite nothing unverified.
- DASHBOARD-SPEC.md:95 also references PHASE2-SPEC; verify only checks README, but leaving it dangling is inaccurate — likely update that reference too (markdown-only, allowed).
- install.sh runs ln -s on first install; idempotency relies on the existing link() helper and a prior mkdir -p of $AGENT_DIR/foreman so the link target resolves.
- README 'Test' section still names only gate_flow_test.sh; out of scope to expand, leaving it as-is to keep edits tight.

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
