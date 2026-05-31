# Architecture Decisions

## How pi loads (verified from /tmp/pi-src)
- Agent dir defaults to `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides it completely. config.ts:485-490.
- pi reads fixed names under the agent dir: `extensions/`, `agents/`, `skills/`, `prompts/`, `themes/`,
  `models.json`, `AGENTS.md`, `auth.json`, `sessions/`. resource-loader.ts:646-657, config.ts.
- Extensions: every `*.ts`/`*.js` under `extensions/` auto-loaded via jiti (NO build step).
  package-manager.ts:191,292; loader.ts:2,15. Entry = folder with `index.ts`, `default export fn(pi)`.
- Project scope: pi ALSO merges `<cwd>/.pi/{extensions,agents,...}` on top (scope:"project").

## ~/.pi/agent = live; repo = versioned source
- `~/.pi/agent` is the machine-wide live pi directory.
- This repo is the committed source, organized by DOMAIN (not pi's flat layout). `install.sh`
  symlinks each domain onto the names pi requires:
  - `extensions/<domain>` -> `~/.pi/agent/extensions/<domain>` (every folder with an `index.ts`)
  - `extensions/foreman/AGENTS.md` -> `~/.pi/agent/AGENTS.md`
  - `extensions/foreman/crew` -> `~/.pi/agent/agents`
  - `config/models.json` -> `~/.pi/agent/models.json`
- auth.json, settings.json, sessions/ stay real machine-local files under `~/.pi/agent`.
- Normal use: do NOT set `PI_CODING_AGENT_DIR`; just run `pi` from any project.
- Verified: default `pi` sees cliproxy + openai-codex models and runs Opus 4.8 by default.

## Workspace of extensions (domains, no duplication)
- Each domain is a self-contained folder under `extensions/` registering one tool.
- `foreman` = orchestration (gated loop + crew + charter). `subagent` = spawn primitive.
  `askuser` (planned) = interactive UI primitive.
- The crew (`extensions/foreman/crew/`) lives with foreman, the domain that orchestrates it.
- Domains compose at runtime once installed (e.g. foreman's gates can call askuser).

## Ledger (Phase 2, lives in TARGET repos, not here)
- `<target-repo>/.pi/plans/<task>/` — committed (survives machine moves). Only `.pi/plans/` in git.
- Resume via handoff cursor (lastReviewedHandoffCount). Separate handoff file per run.
- 3-valued successState (success/partial/blocked). Fix = retry same task, cap 3.
- Source: real Factory CLI mission store on oscars-macbook-pro ~/.factory/missions/.
