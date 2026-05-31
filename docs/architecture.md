# Architecture Decisions

## How pi loads (verified from /tmp/pi-src)
- Agent dir = `PI_CODING_AGENT_DIR` (overrides default `~/.pi/agent`). config.ts:485-490.
- pi reads fixed names under it: `extensions/`, `agents/`, `skills/`, `prompts/`, `themes/`,
  `models.json`, `AGENTS.md`, `auth.json`, `sessions/`. resource-loader.ts:646-657, config.ts.
- Extensions: every `*.ts`/`*.js` under `extensions/` auto-loaded via jiti (NO build step).
  package-manager.ts:191,292; loader.ts:2,15. Entry = folder with `index.ts`, `default export fn(pi)`.
- Project scope: pi ALSO merges `<cwd>/.pi/{extensions,agents,...}` on top (scope:"project").

## Repo = running config
- `PI_CODING_AGENT_DIR=<repo>/agent` → pi runs from source. No install/symlink/copy of harness files.
- auth.json + settings.json symlinked from ~/.pi/agent → machine-local, gitignored. Logins preserved.
- Verified: handshake runs from repo, models route correctly, auth works (cost 0 = subscription).

## Core vs Workflows (no duplication)
- CORE (once): `agents/` (crew) + `extensions/subagent/` (spawn primitive).
- WORKFLOWS (many): each a folder in `extensions/` (loop, future...). Reuse same crew + subagent.
- New workflow references crew, never copies. Matches pi's native one-extensions-dir merge.

## Ledger (Phase 2, lives in TARGET repos, not here)
- `<target-repo>/.pi/plans/<task>/` — committed (survives machine moves). Only `.pi/plans/` in git.
- Resume via handoff cursor (lastReviewedHandoffCount). Separate handoff file per run.
- 3-valued successState (success/partial/blocked). Fix = retry same task, cap 3.
- Source: real Factory CLI mission store on oscars-macbook-pro ~/.factory/missions/.
