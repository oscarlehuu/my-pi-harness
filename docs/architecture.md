# Architecture Decisions

## How pi loads

- The live agent dir defaults to `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides it completely.
- pi reads fixed names under the agent dir: `extensions/`, `agents/`, `skills/`, `prompts/`,
  `themes/`, `models.json`, `AGENTS.md`, `auth.json`, and `sessions/`.
- Extensions are loaded from the flat `extensions/` layout. A domain with a top-level `index.ts` is
  loaded directly; a domain that ships multiple tools uses `package.json` with a `pi.extensions`
  manifest.
- Project scope can add/override resources from `<cwd>/.pi/{extensions,agents,...}` on top of the
  machine-wide agent dir.

## Install/link model

`~/.pi/agent` is the machine-wide live pi directory. This repo is the versioned source organized by
domain, so `install.sh` symlinks source folders onto the flat names pi expects:

- `extensions/<domain>` -> `~/.pi/agent/extensions/<domain>` for every loadable domain.
- `extensions/foreman/AGENTS.md` -> `~/.pi/agent/AGENTS.md` for the CTO persona.
- `extensions/foreman/crew` -> `~/.pi/agent/agents` for planner/developer/tester/reviewer/scout roles.
- `extensions/foreman/docs` -> `~/.pi/agent/foreman/charter` so crew running in any repo can read the
  portable Foreman framework charter at `foreman/charter/CHARTER.md`.
- `config/models.json` -> `~/.pi/agent/models.json` for shared model routing.

Machine-local `auth.json`, `settings.json`, and `sessions/` remain real files under `~/.pi/agent`.
Normal use does **not** set `PI_CODING_AGENT_DIR`; run `pi` from any project after `./install.sh`.
Foreman's out-of-tree ledger mirror also lives under `~/.pi/agent/foreman/ledger-mirror/`.

## Workspace domains

Each domain is a self-contained folder under `extensions/` and registers one or more tools:

- `foreman` — gated planning/dev/test/review/ship orchestration, crew prompts, dashboard, ledger, and
  the framework charter.
- `subagent` — spawn primitive for isolated pi subprocess agents.
- `AskUserQuestion` — structured interactive ask-the-user prompt primitive used for gate relays.
- `grok` — web/X search plus Grok Imagine image/video tools through the subscription proxy.
- `codex` — ChatGPT/Codex OAuth image generation and edit tools.
- `antigravity` — Antigravity/Gemini flash-image generation and edit tools through cli-proxy-api.

Domains compose at runtime once installed; keep additions domain-scoped and primitive-oriented.

## Live Foreman pipeline

Foreman is documented as a portable framework in `extensions/foreman/docs/CHARTER.md`. The current
loop is:

`brainstorm → plan → [GATE 1] → implement → per-round command gates → tester → pre-ship gates/reviewer → (fix↺) → [GATE 2] → ship + release actions`

Key live pieces:

- `planner` drafts the Gate 1 plan read-only; a valid planner plan may propose `.pi/foreman.json`,
  written only after Gate 1 approval and never over an existing manifest.
- Tracks route implementation to `developer` for backend/logic or `ui-developer` for frontend/UI;
  the frontend track falls back to Opus xhigh on Gemini tool failure.
- `.pi/foreman.json` declares generic gates of kind `command|judge|action` and stage
  `per-round|pre-ship|release`. Without a manifest, a supplied `verifyCommand` remains the legacy
  single per-round command gate.
- Per-round command gates run before tester judgment each round. Pre-ship command gates and reviewer
  judge gates run after a successful round before Gate 2. Release action gates run after strict DoD;
  the supported action is `commit`.
- Gate 2 uses the strict Definition of Done before marking done or allowing release commit. The DoD
  checklist is rendered to the founder, recorded in the ledger, and included in the auto-commit body
  when a commit gate is configured.

## Ledger

The task ledger lives in each target repo at `<repo>/.pi/plans/<slug>/` and is intended to be
committed with the work. It records `state.json`, `plan.md`, persisted planner JSON, handoffs,
`log.jsonl`, and machine-local transcripts/activity. Foreman also mirrors the committable ledger
files out of tree under the agent dir so a task can resume after the in-repo ledger is wiped by
`git clean`, reset, or a crashed tree rebuild.
