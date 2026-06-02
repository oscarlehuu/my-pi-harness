# Foreman Framework Charter

The portable operating kernel for Foreman: one founder, one CTO, a small crew, a gated loop, and a
strict ship contract that can run from any repo once installed.

## Principle

The founder works at **decision altitude** (ideas, priorities, taste). The CTO runs engineering on
their behalf and talks to the founder **only at decision points**. Build reusable primitives, not
one-off features. Verify with real calls, never assumptions; cite `file:line` when asserting code
facts.

## Roles

| Role | Model | Tools | Does | Never |
|------|-------|-------|------|-------|
| **Founder** | — (human) | — | Sets intent, approves gates, makes taste calls | Writes code |
| **CTO** | `cliproxy/claude-opus-4-8:xhigh` | orchestration + `foreman`, `subagent`, `AskUserQuestion` | Scopes, delegates, relays gates, synthesizes decisions | Writes production code itself |
| **planner** | `cliproxy/claude-opus-4-8:xhigh` | read, grep, find, ls, bash (read-only) | Drafts the Gate 1 plan, likely files, risks, and optional gate declarations | Edits files or implements |
| **scout** | `cliproxy/gemini-3.5-flash-low:high` | read, grep, find, ls, bash (read-only) | Fast recon, returns compressed context | Edits anything |
| **developer** | `openai-codex/gpt-5.5:xhigh` | full tools | Implements backend/logic and tests on disk | Judges its own work |
| **ui-developer** | `cliproxy/gemini-3.5-flash-low:high` → `cliproxy/claude-opus-4-8:xhigh` fallback | full tools | Implements frontend/UI work with taste on `track:"frontend"` | Judges its own work |
| **tester** | `cliproxy/claude-opus-4-8:high` | read, grep, find, ls, bash (read-only) | Judges intent after command gates, catches cheats | Edits or fixes |
| **reviewer** | `cliproxy/claude-opus-4-8:xhigh` | read, grep, find, ls, bash (read-only) | Runs pre-ship code review when a reviewer judge gate is declared | Edits files or reruns the test suite |

Routing lives in `config/models.json`, each crew file's `model:` frontmatter, and the frontend
fallback constant in `extensions/foreman/index.ts`. The backend track uses `developer`; the frontend
track uses `ui-developer` and auto-falls back within the same round to Opus xhigh if Gemini fails to
use tools, emits no DEV-JSON, or changes no files.

## The loop

`brainstorm → plan → [GATE 1] → implement → verify → test → pre-ship review → (fix↺) → [GATE 2] → ship + auto-commit`

1. **Scope** with the founder only if the task is unclear; use `scout` for quick read-only recon when useful.
2. **Plan**: starting `foreman({ task, verifyCommand?, track?, cwd?, maxRounds? })` invokes the read-only `planner` for a Gate 1 plan. If the planner is unavailable, times out, or emits invalid `PLAN-JSON`, Foreman uses a deterministic fallback plan. A valid planner plan may propose `.pi/foreman.json` gates and advisory task requirement names (env vars, tools, services); Foreman writes them only after Gate 1 approval and never overwrites an existing manifest. Secret values are never read or stored.
3. **Gate 1 relay**: the CTO presents a single-select `AskUserQuestion` with header `Gate 1`, summarizes the plan, and offers `Approve`/`Revise`. If the plan reports any MISSING or UNKNOWN requirements (env vars/secrets, CLI tools/binaries, services/runtimes), the CTO must proactively ask the founder to provide/confirm them as part of this relay (or just before it), rather than waiting for the founder to raise it. This is advisory: the founder can still approve without them, and secret values must be provided out-of-band (exported env / `.env`), never pasted into the plan or stored in the manifest. `Approve` maps to `foreman({ resume: true, approve: true })`; `Revise` or free-text feedback maps to `foreman({ resume: true, reject: "<feedback>" })`.
4. **Implement**: the selected implementer makes the smallest scoped change and records a DEV-JSON handoff. `backend` routes to `developer`; `frontend` routes to `ui-developer` with same-round Opus fallback on tool failure.
5. **Verify + test**: per-round command gates run first and their exit codes are ground truth. The `tester` then judges whether the work satisfies intent and catches cheats. `fail` loops back to the implementer until `maxRounds`; `partial` or `blocked` escalates.
6. **Pre-ship review**: after a successful tester round, pre-ship command gates run and declared reviewer judge gates run. A pre-ship command failure or `REVIEW: REQUEST-CHANGES` reopens the developer round; inconclusive reviewer output proceeds to Gate 2 flagged but does not satisfy strict DoD.
7. **Gate 2 relay**: the CTO presents `AskUserQuestion` header `Gate 2`, summarizes the ship result, and states the Definition of Done rationale in plain language: which checks passed or are n/a, that founder sign-off is the only remaining item, or that commit is WITHHELD and why. `Approve`/`Revise` map to the same unchanged `foreman({ resume: true, ... })` calls.
8. **Ship**: only after strict DoD passes does Foreman mark the task done. Release action gates then run; the supported `commit` action stages gate `paths` if provided, otherwise developer-reported paths plus the ledger, writes a commit message with the DoD checklist, and auto-commits when the repo has staged changes. Without a release commit gate, Foreman marks done but does not commit.

Gate state, rounds, handoffs, transcripts, and logs persist under `<repo>/.pi/plans/<slug>/`, with an
out-of-tree mirror under the agent dir so resume can self-heal after `git clean`, reset, or a crash.

## Gate pipeline

Foreman gates are generic declarations, not hardcoded test names: each gate has `{ name, kind,
stage, command?, agent?, action?, paths? }`, with kind `command|judge|action` and stage
`per-round|pre-ship|release`. Per-round command gates and the tester run each round; pre-ship
command gates and reviewer judge gates run after a successful round before Gate 2; release action
gates run only after Gate 2 approval and strict DoD. Full standalone details and examples live in
[`charter/gate-pipeline.md`](charter/gate-pipeline.md).

## Definition of Done

Foreman uses a strict, machine-evaluated Definition of Done: plan approved, per-round command gates
passed or n/a, tester success, pre-ship command gates passed or n/a, reviewer `APPROVE` when a
reviewer gate is declared, and founder Gate 2 approval. Any blocker means `done=false`; an
inconclusive reviewer verdict blocks commit rather than silently force-shipping. Full standalone
details live in [`charter/definition-of-done.md`](charter/definition-of-done.md).

## Safety

Quota safety is non-negotiable: cliproxy/Anthropic crew agents use **append-only** system prompts
(`--append-system-prompt`) so the Claude Code marker is preserved and calls draw on the Max
subscription quota, not billed credits. Never replace that prompt with `--system-prompt`.

Route-through-Foreman safety is enforced by `guard.ts`: main-session `edit`/`write` and mutating
`bash` calls that would make impactful repo changes are blocked with instructions to start a Foreman
task instead. The guard allows read-only tools and no-impact paths such as prose docs, scratch dirs,
or paths outside the repo; crew subprocesses set `FOREMAN_CREW=1`, and `/foreman-direct` is the
explicit session escape hatch.

## Docs structure

One concept = one ## section. When a section exceeds ~40 lines or needs its own examples/sub-structure, graduate it to docs/charter/<concept>.md, leaving a one-paragraph summary + link here. CHARTER stays the index/kernel. Sections are written self-contained (no cross-references that break when moved).

Current sub-pages:
- [`charter/gate-pipeline.md`](charter/gate-pipeline.md) — generic gate declarations and execution stages.
- [`charter/definition-of-done.md`](charter/definition-of-done.md) — strict DoD checks, blockers, and recording surfaces.
