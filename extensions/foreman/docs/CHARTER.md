# Company Charter

The operating manual for this harness. One founder, one CTO, a small crew, one loop, two gates.
This is the reusable IP — the roles and rules survive any individual task.

## Principle

The founder works at **decision altitude** (ideas, priorities, taste). The CTO runs engineering on
their behalf and talks to the founder **only at decision points**. Build only what the loop needs
(primitives, not features). Verify with real calls, never assumptions; cite `file:line`.

## Roles

| Role | Model | Tools | Does | Never |
|------|-------|-------|------|-------|
| **Founder** | — (human) | — | Sets intent, approves gates, makes taste calls | Writes code |
| **CTO** | `cliproxy/claude-opus-4-8:xhigh` | orchestration + `foreman`, `subagent` | Scopes, delegates, gates, synthesizes | Writes production code itself |
| **scout** | `cliproxy/gemini-3.5-flash-low:high` | read, grep, find, ls | Fast recon, returns compressed context | Edits anything |
| **developer** | `openai-codex/gpt-5.5:xhigh` | full tools | Implements code + tests on disk | Judges its own work |
| **tester** | `cliproxy/claude-opus-4-8:high` | read, grep, find, ls, bash | Judges intent, catches cheats | Edits code / fixes |

Routing lives in `config/models.json` (provider/model metadata) and each role's `model:` frontmatter
(`provider/id:thinking`). Valid thinking levels: `off|minimal|low|medium|high|xhigh` (`xhigh` = max).

## The loop

`brainstorm → plan → [GATE 1] → implement → verify → test → (fix↺) → [GATE 2] → ship`

Driven by the `foreman` tool (`extensions/foreman/`). The CTO starts it; the machine runs it.

1. **Scope** with the founder if the task is unclear.
2. **Scout** existing code when relevant (via `subagent`).
3. `foreman({ task, verifyCommand?, cwd?, maxRounds? })` — pauses at **Gate 1**.
4. After Gate 1 approval: **developer** implements → **controller runs the verify command** (its
   exit code is ground truth) → **tester** judges whether the work satisfies intent and looks for
   cheats (hardcoding, edited tests). A non-zero exit is always `fail`; a zero exit is `success`
   unless the tester flags otherwise.
5. On `fail`: the verdict is fed back to the developer; retry up to `maxRounds` (default 3), then
   **escalate** to the founder.
6. On `success`: pauses at **Gate 2**.

### Verdicts (what the tester returns)
- `success` — verified and satisfies the task → Gate 2.
- `fail` — retry the developer with the diagnosis.
- `partial` — done but blocked by an off-scope issue → escalate.
- `blocked` — cannot verify (no test, broken env) → escalate.

## The two gates

| Gate | When | Approve | Revise |
|------|------|---------|--------|
| **1 — Plan** | Before any code runs | `foreman({ resume:true, approve:true })` → runs rounds | `foreman({ resume:true, reject:"…" })` → halts |
| **2 — Ship** | After verification passes | `foreman({ resume:true, approve:true })` → done | `foreman({ resume:true, reject:"…" })` → reopens for another round |

Gates are conversational and **persisted in the ledger**, so a killed/resumed session respects gate
position. The CTO relays gate prompts to the founder and carries the decision back.

## Definition of Done

A task is **done** only when **all** hold:
1. Gate 1 (plan) was approved.
2. The verify command exits 0 (ground truth).
3. The tester judged `success` — intent satisfied, no cheats.
4. Gate 2 (ship) was approved by the founder.

Anything short of this is `escalated`, `awaiting_ship`, `in_progress`, or `planning` — never done.

## The ledger

Lives in the **target repo** at `<repo>/.pi/plans/<task-slug>/`, committed to git (only `plans/` is
committed; a generated `.pi/.gitignore` excludes the rest). Contents:
- `state.json` — task, slug, state, round, gate flags, verify command, cursor.
- `plan.md` — the Gate 1 plan.
- `handoffs/<ts>__<role>-r<n>__<uuid>.json` — every developer + tester handoff (controller always
  writes one, even on parse failure).
- `log.jsonl` — append-only event trail (gates, rounds, verdicts).

## When the CTO talks to the founder (only here)
- Gate 1 (plan) and Gate 2 (ship).
- Genuine forks where founder taste/priority matters.
- Blockers unresolved after real investigation.

Not for routine progress, tool mechanics, or anything verifiable without the founder.

## Quota safety (non-negotiable)

cliproxy/Anthropic agents use **append-only** system prompts (`--append-system-prompt`), preserving
the Claude Code marker so calls draw on the Max subscription quota, not billed credits. Never use a
replace-style `--system-prompt` on cliproxy agents.
