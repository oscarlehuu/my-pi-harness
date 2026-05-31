# my-pi-harness

A **workspace of pi extensions** — reusable primitives for **pi** (Pi Coding Agent), organized by
domain. Not a single app; a growing collection of tools that each stand alone yet compose when
installed together. Philosophy: primitives, not features.

## Layout

```
extensions/
  foreman/     orchestration domain — gated dev→test→fix loop + crew + CTO charter
    index.ts        the `foreman` tool (orchestrator)
    ledger.ts       on-disk task state (.pi/plans/<task>/)
    crew/           developer.md  scout.md  tester.md   (role defs, not code)
    AGENTS.md       CTO persona / project self-description
    docs/           CHARTER.md  PHASE2-SPEC.md
    test/           gate_flow_test.sh  (end-to-end acceptance)
  subagent/    spawn primitive — runs an agent in an isolated pi subprocess
  askuser/     (planned) interactive ask-the-user UI primitive
config/
  models.json  shared model routing (cliproxy + openai-codex)
docs/
  architecture.md  how pi loads; the install model
install.sh     composes the workspace into ~/.pi/agent
```

Each extension registers one tool via `pi.registerTool`; pi auto-loads every `extensions/*/index.ts`
(jiti, no build step). Add a domain = drop a new folder under `extensions/`.

## Install

`~/.pi/agent` is the live, machine-wide pi directory. This repo is the versioned source.
`install.sh` symlinks each domain onto the flat names pi requires; secrets/sessions stay machine-local.

```bash
./install.sh             # symlink workspace into ~/.pi/agent (idempotent)
pi                       # from any project — no PI_CODING_AGENT_DIR needed
```

Do **not** set `PI_CODING_AGENT_DIR` for normal use; it replaces `~/.pi/agent` wholesale.

## The foreman loop

`brainstorm → plan → [GATE 1] → implement → verify → test → (fix↺) → [GATE 2] → ship`

The CTO (main pi session) starts `foreman({ task, verifyCommand? })`; the machine runs the rest:
controller runs the verify command (exit code = ground truth), tester judges intent + catches cheats,
fails are retried up to a cap. Two human gates (plan, ship) pause for founder approval. Full manual:
`extensions/foreman/docs/CHARTER.md`.

## Roles & routing

| Role | Model | Notes |
|------|-------|-------|
| CTO (main session) | cliproxy/claude-opus-4-8:xhigh | default/max reasoning; founder talks to this |
| scout | cliproxy/gemini-3.5-flash-low:high | recon, read-only |
| developer | openai-codex/gpt-5.5:xhigh | implements, full tools |
| tester | cliproxy/claude-opus-4-8:high | judges verification, read-only |

Thinking levels: `off|minimal|low|medium|high|xhigh` (`xhigh` = max). cliproxy agents use an
**append-only** system prompt (preserves the Claude Code marker → Max subscription quota, not credits).

## Test

```bash
bash extensions/foreman/test/gate_flow_test.sh   # full gate-flow acceptance, exit 0 = pass
```
