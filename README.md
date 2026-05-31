# my-pi-harness

A reusable harness for running many projects on **pi** (Pi Coding Agent). The "company" is the
founder; this repo is the tooling. Built BY pi, FOR running pi. Philosophy: primitives, not features.

## How it runs

`~/.pi/agent` is the live, machine-wide pi directory. This repo is the versioned source for the
harness. `setup.sh` symlinks the committed harness files into `~/.pi/agent`, while secrets and
sessions stay machine-local there.

```bash
./setup.sh               # one-time / update: installs symlinks into ~/.pi/agent
pi                       # no PI_CODING_AGENT_DIR export needed
```

Do **not** set `PI_CODING_AGENT_DIR` for normal use. That env var replaces `~/.pi/agent`; we only use
it for temporary experiments.

## Architecture: core vs workflows

```
agent/                         ← source for what setup.sh installs into ~/.pi/agent
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
| CTO (main session) | cliproxy/claude-opus-4-8:xhigh | default/max reasoning; founder talks to this |
| scout | cliproxy/gemini-3.5-flash-low:high | recon, read-only |
| developer | openai-codex/gpt-5.5:xhigh | implements, full tools |
| tester | cliproxy/claude-opus-4-8:high | judges verification, read-only |

pi's valid thinking levels are `off|minimal|low|medium|high|xhigh`; we use `xhigh` as "max".

cliproxy agents use **append-only** system prompt (preserves Claude Code marker → Max subscription quota, not credits).

## Docs

- `docs/PHASE2-SPEC.md` — the loop workflow spec
- `docs/CHARTER.md` — roles, loop, gates, definition-of-done (Phase 3)

## Tests

- `test/loop/` — broken-task handshake (dev→test→fix acceptance rig)
