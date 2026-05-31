# Architecture Decisions

## How pi loads (verified from /tmp/pi-src)
- Agent dir defaults to `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides it completely. config.ts:485-490.
- pi reads fixed names under the agent dir: `extensions/`, `agents/`, `skills/`, `prompts/`, `themes/`,
  `models.json`, `AGENTS.md`, `auth.json`, `sessions/`. resource-loader.ts:646-657, config.ts.
- Extensions: every `*.ts`/`*.js` under `extensions/` auto-loaded via jiti (NO build step).
  package-manager.ts:191,292; loader.ts:2,15. Entry = folder with `index.ts`, `default export fn(pi)`.
- Project scope: pi ALSO merges `<cwd>/.pi/{extensions,agents,...}` on top (scope:"project").

## ~/.pi/agent = live harness; repo = versioned source
- `~/.pi/agent` is the machine-wide live pi directory.
- `my-pi-harness/agent` is the committed source. `setup.sh` symlinks AGENTS.md, agents/, extensions/,
  and models.json into `~/.pi/agent`.
- auth.json, settings.json, sessions/ stay real machine-local files under `~/.pi/agent`.
- Normal use: do NOT set `PI_CODING_AGENT_DIR`; just run `pi` from any project.
- Verified: default `pi` sees cliproxy + openai-codex models and runs Opus 4.8 by default.

## Core vs Workflows (no duplication)
- CORE (once): `agents/` (crew) + `extensions/subagent/` (spawn primitive).
- WORKFLOWS (many): each a folder in `extensions/` (loop, future...). Reuse same crew + subagent.
- New workflow references crew, never copies. Matches pi's native one-extensions-dir merge.

## Ledger (Phase 2, lives in TARGET repos, not here)
- `<target-repo>/.pi/plans/<task>/` — committed (survives machine moves). Only `.pi/plans/` in git.
- Resume via handoff cursor (lastReviewedHandoffCount). Separate handoff file per run.
- 3-valued successState (success/partial/blocked). Fix = retry same task, cap 3.
- Source: real Factory CLI mission store on oscars-macbook-pro ~/.factory/missions/.
