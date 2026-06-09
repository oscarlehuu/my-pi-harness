# Session Namer

Automatically assigns each main pi session a concise, meaningful display name after the first completed turn. This replaces the session picker's fallback to the first few words of the first user message.

## How it works

`session-namer` listens for `pi.on("agent_end")`. Once the session has at least one non-aborted assistant response and a non-empty user message, it sends the first user message plus the first assistant reply to the local OpenAI-compatible proxy configured in `~/.pi/agent/models.json`.

When a title is generated, the extension calls `pi.setSessionName(title)`. pi records that as a `session_info` entry in the session JSONL, which is what the session picker reads for `session.name`.

The hook is best-effort background work: it never throws from handlers, never blocks the turn, skips crew/subagent sessions, and only names a session once. It also respects an existing session name, so names set with `--name`, manual rename, or another extension are not overwritten.

## Model selection

By default the extension picks a cheap model from the local proxy provider in `~/.pi/agent/models.json`, preferring IDs that look like `flash`, `mini`, `haiku`, `small`, or `low`.

Override the model with:

```bash
SESSION_NAMER_MODEL=gemini-3.5-flash-low pi
```

The override is used only if that model ID exists in the selected provider.

## Manual command

Run:

```text
/name-session
```

This regenerates and sets a title for the current session on demand. The automatic path remains the primary feature.
