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
    crew/           developer.md  ui-developer.md  scout.md  tester.md   (role defs, not code)
    fallback.ts     frontend-track tool-failure detector (Gemini → Opus same-round fallback)
    AGENTS.md       CTO persona / project self-description
    docs/           CHARTER.md  PHASE2-SPEC.md
    test/           gate_flow_test.sh  (end-to-end acceptance)
  subagent/    spawn primitive — runs an agent in an isolated pi subprocess
  AskUserQuestion/  interactive ask-the-user UI primitive
  grok/        search + imagine domain — web/X search and image/video via Grok's subscription proxy
    package.json      pi manifest (registers two tools from one domain)
    _shared/grokClient.ts   reverse-engineered cli-chat-proxy client
    websearch/index.ts      the `grok-web-search` tool
    xsearch/index.ts        the `grok-x-search` tool
    test/             search_test.sh  (live web + X acceptance)
  codex/       image domain — generate + edit images via ChatGPT/Codex OAuth
    package.json      pi manifest (registers generate + edit tools)
    _shared/codexImageClient.ts  Codex OAuth + image_generation client
    generate/index.ts            the `codex-image-generate` tool
    edit/index.ts                the `codex-image-edit` tool
    test/             image_test.sh  (live generate + edit acceptance)
  antigravity/ image domain — generate + edit images via Antigravity Gemini flash-image through cli-proxy-api
    package.json      pi manifest (registers imagegen + imageedit tools)
    _shared/antigravityClient.ts  reverse-engineered generate_image transport client
    imagegen/index.ts             the `antigravity-image-gen` tool
    imageedit/index.ts            the `antigravity-image-edit` tool
    test/             image_test.sh  (live generate acceptance; skips without proxy/key)
config/
  models.json  shared model routing (cliproxy + openai-codex)
docs/
  architecture.md  how pi loads; the install model
install.sh     composes the workspace into ~/.pi/agent
```

Each extension registers its tool(s) via `pi.registerTool`; pi auto-loads every `extensions/*/index.ts`
(jiti, no build step). A domain that ships multiple tools (e.g. `grok/`) uses a `package.json` with a
`pi.extensions` manifest, since pi does not recurse beyond one level. Add a domain = drop a new folder
under `extensions/`.

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
| developer | openai-codex/gpt-5.5:xhigh | implements backend/logic, full tools |
| ui-developer | cliproxy/gemini-3.5-flash-low:high | frontend/UI with taste; `track:"frontend"`; falls back to opus-4-8:xhigh on tool failure |
| tester | cliproxy/claude-opus-4-8:high | judges verification, read-only |

Thinking levels: `off|minimal|low|medium|high|xhigh` (`xhigh` = max). cliproxy agents use an
**append-only** system prompt (preserves the Claude Code marker → Max subscription quota, not credits).

## Test

```bash
bash extensions/foreman/test/gate_flow_test.sh   # full gate-flow acceptance, exit 0 = pass
```
