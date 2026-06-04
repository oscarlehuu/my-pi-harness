---
name: continual-learning
description: Orchestrate continual learning by delegating main-session transcript mining and AGENTS.md updates to the agents-memory-updater subagent.
disable-model-invocation: true
---

# Continual Learning

Keep `AGENTS.md` current by delegating the whole memory-update flow to one subagent.

## Trigger

Run when the founder asks to mine prior chats, refresh `AGENTS.md` memory, or run the continual-learning
loop — or when the `continual-learning` extension's cadence gate injects a follow-up asking for it.

## Workflow

1. Call the `agents-memory-updater` subagent (via the `subagent` tool) with the transcript digest and
   the `AGENTS.md` / index paths the extension provides.
2. Return the updater's result verbatim.

## Guardrails

- Keep this parent flow orchestration-only.
- Do not mine transcripts or edit `AGENTS.md` yourself.
- Do not bypass the subagent.
