# Continual Learning

A pi port of Cursor's official [`continual-learning`](https://github.com/cursor/plugins) plugin,
extended for **self-improvement**. It incrementally mines the **main session** transcript (the
founder↔CTO chat) for durable corrections, preferences, and workspace facts, and keeps `AGENTS.md`
current with plain bullet points — so a stateless agent accumulates project memory and stops repeating
mistakes across sessions, without any weight updates.

The self-heal loop is simple and bounded (memory-as-context, not retraining):

```
make a mistake once → distill the lesson into a do/don't rule → AGENTS.md auto-reloads next session → don't repeat it
```

## How it maps to Cursor

Cursor ships this as a Bun `stop` hook → skill → `agents-memory-updater` subagent. pi exposes the
same shape natively, so the port is faithful:

| Cursor plugin piece | pi port |
|---|---|
| `stop` hook (cadence gate, TS) | `pi.on("agent_end")` → `cadence.ts` (same turn/minute/mtime/dedupe truth table) |
| `followup_message` nudge | a **background** learning pass (no need to interrupt the main agent) |
| `continual-learning` skill (`disable-model-invocation`) | `skills/continual-learning/SKILL.md` (manual/explicit route) |
| `agents-memory-updater` subagent | `crew/agents-memory-updater.md`, spawned headless by `runner.ts` |
| `.cursor/hooks/state/continual-learning.json` | `.pi/state/continual-learning.json` |
| `.cursor/hooks/state/continual-learning-index.json` | `.pi/state/continual-learning-index.json` |
| transcripts under `~/.cursor/projects/<slug>/agent-transcripts/` | pi sessions under `~/.pi/agent/sessions/--<cwd>--/*.jsonl` |
| `AGENTS.md` two learned sections | extended to three (adds `## Learned Corrections` for self-heal) |

The key design choice: mine the **main CTO session**, not Foreman's crew/tool transcripts — that's
where preferences and corrections actually surface (crew agents run `--no-session` and are mechanical).

## Flow

```
agent_end ─► cadence gate (cadence.ts)
              │  turns≥min ∧ minutes≥min ∧ transcript mtime advanced ∧ not-duplicate
              ▼ (when due)
           learning pass (learn.ts)
              │  pick new/changed transcripts (memory.ts index delta)
              │  ensure AGENTS.md scaffold
              ▼
           agents-memory-updater subagent (runner.ts, headless pi)
              │  mine high-signal preferences + facts from the transcript digest
              ▼
           refresh index after clean exit + AGENTS.md updated in place  ─►  auto-loaded as context next session
```

## Trigger cadence

Defaults: **10 turns** and **30 minutes** since the last run, and the transcript must have advanced.
Trial mode lowers this to **3 turns / 15 minutes** and auto-expires after 24h.

Env overrides (primary name, with legacy `CONTINUOUS_*` alias accepted):

- `CONTINUAL_LEARNING_MIN_TURNS`, `CONTINUAL_LEARNING_MIN_MINUTES`
- `CONTINUAL_LEARNING_TRIAL_MODE`, `CONTINUAL_LEARNING_TRIAL_MIN_TURNS`,
  `CONTINUAL_LEARNING_TRIAL_MIN_MINUTES`, `CONTINUAL_LEARNING_TRIAL_DURATION_MINUTES`

## Manual run

```
/continual-learning      # mine recent transcripts and update AGENTS.md now
```

## Independence from Foreman (compose, don't couple)

This extension has **zero references to Foreman**, and Foreman has zero references to it. They compose
through a shared substrate, not code:

```
Foreman runs ─writes─► main CTO session transcript ─read by─► continual-learning ─writes─► AGENTS.md
```

Every `foreman({...})` call is a CTO turn; when it ends, `agent_end` fires and continual-learning's own
cadence gate observes it like any other session. So Foreman tasks feed learning automatically **without**
either side importing the other — and each works fully when the other is absent. Use continual-learning
with plain chat, with Foreman, or neither. (Earlier drafts had a `FOREMAN_CONTINUAL_LEARNING=1` seam in
Foreman; it was removed precisely because it coupled the two.)

## Output format (`AGENTS.md`)

Three sections, plain bullets, ≤12 per section, deduped and updated in place. On contradiction the
updater **overrides in place** (git history is the audit trail; the file stays machine-clean). No
evidence tags, confidence scores, or metadata. Secrets, one-off instructions, and transient details
are excluded.

```markdown
## Learned Corrections
- Ask before changing keybindings — the wrong binding was set twice.

## Learned User Preferences
- Wants clarifying questions before UI changes.

## Learned Workspace Facts
- pi tool names are lowercase (read, grep, find, ls, bash, edit, write).
```

### The three sections

- **Learned Corrections** — the self-heal core. Do/don't rules distilled from mistakes, failures, and
  explicit "no / actually / don't" moments, phrased as forward guidance so the next session avoids the
  repeat. This is what makes the agent *improve* rather than just *describe*.
- **Learned User Preferences** — durable style/process/communication preferences (no failure attached).
- **Learned Workspace Facts** — stable architecture/convention/command truths, **including verified
  procedures/playbooks** folded in as fact-style bullets.

## Files

```
index.ts        agent_end cadence hook + /continual-learning command + runForemanLearningPass export
cadence.ts      pure cadence truth table (port of continual-learning-stop.ts)
memory.ts       incremental transcript index + AGENTS.md section parse/merge contract
transcript.ts   pi session JSONL reader → compact user/assistant digest (exact cwd-slug rule)
learn.ts        orchestrator: delta select → scaffold → run updater → refresh index after clean exit
runner.ts       headless pi subprocess spawner for the updater subagent
crew/agents-memory-updater.md   the updater subagent (read/edit AGENTS.md only)
skills/continual-learning/SKILL.md   orchestration-only skill (manual route)
test/           cadence_test.sh (truth table + memory mechanics), learn_test.sh (orchestrator)
```

## Test

```bash
bash extensions/continual-learning/test/cadence_test.sh   # pure logic, exit 0 = pass
bash extensions/continual-learning/test/learn_test.sh     # orchestrator with injected deps
```

## License

MIT — same as the upstream Cursor plugin this is ported from.
