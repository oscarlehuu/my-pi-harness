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
| **developer** | `openai-codex/gpt-5.5:xhigh` | full tools | Implements backend/logic + tests on disk | Judges its own work |
| **ui-developer** | `cliproxy/gemini-3.5-flash-low:high` (→ `claude-opus-4-8:xhigh` on tool failure) | full tools | Implements the frontend/UI with taste | Judges its own work |
| **tester** | `cliproxy/claude-opus-4-8:high` | read, grep, find, ls, bash | Judges intent, catches cheats | Edits code / fixes |

Routing lives in `config/models.json` (provider/model metadata) and each role's `model:` frontmatter
(`provider/id:thinking`). Valid thinking levels: `off|minimal|low|medium|high|xhigh` (`xhigh` = max).

### Tracks (who implements)

The CTO tags each task with a **track**, defaulting to `backend`:
- `foreman({ task, track: "backend" })` (default) → the **developer** (gpt-5.5) implements.
- `foreman({ task, track: "frontend" })` → the **ui-developer** (Gemini 3.5 Flash) implements, because
  gpt-5.5 lacks frontend taste. Gemini has taste but is unreliable at tool-calling, so the controller
  **auto-falls-back within the same round** to `claude-opus-4-8:xhigh` if the Gemini run errors, emits
  no DEV-JSON machine block, or changes no files on disk. The track persists in the ledger (survives
  resume); the fallback is logged as a `ui_fallback` event. The ledger role/phase stays `developer`
  either way, so the loop, gates, and dashboard are unchanged.

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

| Gate | When | Founder relay | Approve | Revise |
|------|------|----------------|---------|--------|
| **1 — Plan** | Before any code runs | `AskUserQuestion` header `Gate 1`; summarize the plan; options `Approve`/`Revise` | `foreman({ resume:true, approve:true })` → runs rounds | `foreman({ resume:true, reject:"…" })` → halts |
| **2 — Ship** | After verification passes | `AskUserQuestion` header `Gate 2`; state the Definition of Done rationale (why commit is permitted or withheld) and summarize DoD/ship result; options `Approve`/`Revise` | `foreman({ resume:true, approve:true })` → done | `foreman({ resume:true, reject:"…" })` → reopens for another round |

Gates are conversational and **persisted in the ledger**, so a killed/resumed session respects gate
position. The CTO relays each gate to the founder with a single-select `AskUserQuestion` and carries
the decision back by translating `Approve` to `foreman({ resume:true, approve:true })`; `Revise` or
custom free-text feedback to `foreman({ resume:true, reject:"…" })` (plus `slug` when needed by
normal resume semantics). The Foreman gate contract is unchanged; `AskUserQuestion` is only the CTO
relay surface. If no UI is available (headless), fall back to the plain command relay;
`AskUserQuestion` already degrades in headless mode.

## Definition of Done

A task is **done** only when **all** hold:
1. Gate 1 (plan) was approved.
2. Per-round command gates passed, if declared (or the check is n/a when none ran).
3. The tester judged `success` — intent satisfied, no cheats.
4. Pre-ship command gates passed, if declared (or n/a when none exist).
5. Any declared pre-ship reviewer gate returned a clean `APPROVE`; `REQUEST-CHANGES`, missing, or
   inconclusive reviewer output blocks done.
6. Gate 2 (ship) was approved by the founder.

At Gate 2, before founder approval, the CTO relays this Definition of Done rationale: every
non-founder check that passed or is n/a, that founder sign-off is the only remaining item, and
therefore why the task is eligible to commit. If any check blocks, the CTO says commit is WITHHELD
and gives the blocker instead of implying approval is enough. Foreman also renders the checklist at
Gate 2, records the full checklist in the `done_evaluated` ledger event, and embeds the
"Definition of Done:" block in the auto-commit message body.

Anything short of this is `escalated`, `awaiting_ship`, `in_progress`, or `planning` — never done.

## The ledger

Lives in the **target repo** at `<repo>/.pi/plans/<task-slug>/`, committed to git (only `plans/` is
committed; a generated `.pi/.gitignore` excludes the rest). Contents:
- `state.json` — task, slug, state, round, gate flags, verify command, cursor.
- `plan.md` — the Gate 1 plan.
- `handoffs/<ts>__<role>-r<n>__<uuid>.json` — every developer + tester handoff (controller always
  writes one, even on parse failure).
- `log.jsonl` — append-only event trail (gates, rounds, verdicts).

**Durability (automatic, every repo).** The in-repo ledger can be destroyed by `git clean`, a reset,
or a crashed tree rebuild before you commit. So Foreman also mirrors the committable files
(`state.json`, `plan.md`, `log.jsonl`, `handoffs/`) out of tree to
`<agentDir>/foreman/ledger-mirror/<repoKey>/plans/<slug>/` on every state change. On `resume`,
Foreman first restores any task whose in-repo ledger is missing from that mirror, so a wiped task
self-heals instead of vanishing. This is Foreman's job — no per-repo `.gitignore` or setup needed.

## When the CTO talks to the founder (only here)
- Gate 1 (plan) and Gate 2 (ship).
- Genuine forks where founder taste/priority matters.
- Blockers unresolved after real investigation.

Not for routine progress, tool mechanics, or anything verifiable without the founder.

## Quota safety (non-negotiable)

cliproxy/Anthropic agents use **append-only** system prompts (`--append-system-prompt`), preserving
the Claude Code marker so calls draw on the Max subscription quota, not billed credits. Never use a
replace-style `--system-prompt` on cliproxy agents.
