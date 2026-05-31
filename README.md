# my-pi-harness

A reusable harness for running many projects on **pi** (Pi Coding Agent). The "company" is the
founder; this repo is the tooling. Built BY pi, FOR running pi. Philosophy: primitives, not features.

## How it runs (no install step)

pi reads its config from whatever `PI_CODING_AGENT_DIR` points at. We point it at this repo's
`agent/` folder, so **the repo IS the running config** — edit a file, it's live.

```bash
source setup.sh          # exports PI_CODING_AGENT_DIR=<repo>/agent
pi                       # now runs the harness
```

Secrets (`auth.json`, `settings.json`) are symlinked from `~/.pi/agent` and gitignored — they stay
machine-local, never committed. Logins are preserved.

## Architecture: core vs workflows

```
agent/                         ← what pi reads (folder names fixed by pi's contract)
  AGENTS.md                    CTO persona (governance)
  models.json                  model routing (cliproxy + codex, :thinking inline)
  agents/                      CORE CREW — shared by every workflow, defined ONCE
    scout.md  developer.md  tester.md
  extensions/                  pi auto-loads every */index.ts (jiti, no build step)
    subagent/                  CORE PRIMITIVE — spawns isolated agents
    loop/                      WORKFLOW 1 — deterministic dev→test→fix + ledger + gates
```

- **Core** (crew + subagent) exists once.
- Each **workflow** is a folder in `extensions/`; it reuses the same crew + subagent. No duplication.
- Add a workflow = drop a new folder in `extensions/`. pi finds it automatically.

## Roles & routing

| Role | Model | Notes |
|------|-------|-------|
| CTO (main session) | cliproxy/claude-opus-4-8 | the founder talks to this |
| scout | cliproxy/gemini-3.5-flash-low:high | recon, read-only |
| developer | openai-codex/gpt-5.5:xhigh | implements, full tools |
| tester | cliproxy/claude-opus-4-8:high | runs tests, PASS/FAIL/partial, read-only |

cliproxy agents use **append-only** system prompt (preserves Claude Code marker → Max subscription quota, not credits).

## Docs

- `docs/PHASE2-SPEC.md` — the loop workflow spec
- `docs/CHARTER.md` — roles, loop, gates, definition-of-done (Phase 3)

## Tests

- `test/loop/` — broken-task handshake (dev→test→fix acceptance rig)
