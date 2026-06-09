# my-pi-harness

A workspace of composable extensions for **pi** (the Pi Coding Agent) — and, at its heart, an
experiment in building an **alignment engine** for autonomous coding: a system that makes an AI
orchestrator *show you how it understood your request, and verify that understanding with you,
before it writes a line of code.*

Philosophy: **primitives, not features.** Each extension stands alone yet composes when installed
together. Nothing here is a monolith; it grew one small, gated, reviewed change at a time — by the
very loop it implements.

> **Status:** personal research harness, shared in the open. It runs on a local
> [`cli-proxy-api`](https://github.com/router-for-me/CLIProxyAPI) that routes to Claude / GPT / Gemini
> via subscription auth. See [Setup](#setup) and the [disclaimer](#disclaimer) before using.

---

## The story: why this exists

Most "autonomous coding" fails the same way — **the agent and the human end up talking past each
other.** You ask for X; the agent confidently builds a coherent, well-tested *Y*; nobody notices
until it ships. The failure isn't bad code. It's **misalignment that stays invisible until it's
expensive.**

This repo started as a question: *can an orchestrator be made to expose and verify its understanding
before building — and keep that understanding flowing all the way down to the crew that does the
work?* The answer became **Foreman**: a gated planner → dev → test → review → ship loop with a human
at two gates, and an "alignment engine" layered on top of it.

A second question arrived later: *what if the human is "blind"* — a contractor dropped into a giant
company codebase they don't understand, handed a ticket? Then the founder can't be the source of
truth either. The orchestrator has to verify its understanding against **the code, the history, and
the team** — with the human as a relay, not an oracle. That reframed the whole design: the founder
is just *one possible source of truth*; the engine is the same whether truth lives in your head or
in a repo you've never read.

Almost everything here was built **through Foreman itself** — planned, gated, implemented by a crew,
adversarially reviewed, and documented by an automated doc-writer. The git history is the receipts.

---

## The alignment engine

Layered on top of the base gated loop, built in order, each piece earning its place:

| Layer | What it does | Key modules |
| --- | --- | --- |
| **① Understanding layer** | The planner exposes *how it understood the task* at Gate 1: a plain-language restatement plus `assumptions` (with confidence), `nonGoals`, `alternatives` (with why-rejected), and `blastRadius`. You verify the understanding **before** code runs. | `planner.ts` |
| **② Intent contract → crew** | The founder-approved understanding/assumptions/non-goals flow *down* into the developer and tester prompts (re-attached every round), so the crew builds and judges against **one shared intent**, not each member's private re-guess. | `planner.ts:formatIntentContract`, `index.ts` |
| **③ Assumption scorer** | Ranks each assumption by **risk = P(wrong) × cost**. P comes from the planner's confidence; cost from declared high-risk path globs + a keyword backstop. Routes each to `self` / `founder` / `team`. Advisory: it reorders Gate 1 so the *dangerous* assumptions surface first. | `scorer.ts` |
| **④ Team relay packet** | Risky *domain-fact* assumptions become a compact, paste-able "Questions for your team" packet — for the blind-mode case where the founder must relay to people who actually know the app. **Assume-unless-vetoed**: approving = proceed; a team veto comes back as an ordinary Gate reject. No new pause state. | `teampacket.ts` |
| **Anti-rubber-stamp (4 tiers)** | A verify step is theater if the human waves it through. **T1** verifiable-claim discipline (a risky flag must carry concrete evidence, else `[unsubstantiated]`); **T2** the planner must try to resolve a question itself before raising it; **T4** cost-asymmetry friction (high-risk-path ships require a deliberate `confirm` token, normal ships stay one-tap); **T3** a cross-task calibration loop that measures whether flags were *worth it* and proposes recalibration — human-gated, never auto-tuned. | `approvalfriction.ts`, `calibration.ts`, `scorer.ts` |
| **⑤ Doc-er + compound loop** | After review approves, a soft doc-writer agent updates the repo's architecture docs to reflect the change — *agent-friendly first*. A hard drift-detector flags stale docs at Gate 2 without blocking ship. The docs it maintains (`INTERNALS.md`) then **feed the next task's planner**, so the system understands its own code faster over time. | `doc-er` crew, `docdrift.ts` |

The deepest proof: by the end, **the engine was running on the work of building itself** — the
scorer rated the assumptions in its own successor's plan; the doc-er kept the code-map current as
each piece landed; the planner read that map to move faster.

---

## The Foreman loop

```
brainstorm → plan → [GATE 1] → implement → per-round command gates → tester
          → pre-ship (command gates + reviewer judge) → doc-er → [GATE 2] → ship + release
```

- **Two human gates.** Gate 1 (plan) and Gate 2 (ship) pause for founder approval. Everything between is machine-run.
- **Exit code = ground truth.** Command gates are objective; the LLM tester/reviewer judge *intent* on top, but can never turn a failing command into a pass.
- **Adversarial judges.** Tester and reviewer run a *default-refuted* stance — they must try to disprove the work before passing it.
- **Strict Definition of Done.** No force-ship: even with founder approval, ship is withheld until a clean reviewer `APPROVE` (when a reviewer gate is declared).
- **Crew runs in isolated subprocesses** under a shared timeout harness (idle + max budgets, heartbeat, SIGKILL backstop) so a hung agent degrades gracefully instead of hanging the loop.

### Roles & model routing

| Role | Model | Why |
| --- | --- | --- |
| CTO (main session) | Opus (xhigh) | orchestrates, talks to the founder, never writes production code |
| planner | Opus (xhigh) | read-only Gate 1 plan + understanding layer |
| developer | GPT-5.5 (xhigh) | implements; cross-model from the judges by design (decorrelated) |
| ui-developer | Gemini 3.5 Flash → Opus fallback | frontend taste; auto-falls back on tool-call flakiness |
| tester | Opus (high) | judges intent, catches cheats |
| reviewer | Opus (high) | pre-ship code review; `high` not `xhigh` (xhigh stalled in thinking spirals) |
| doc-er | Opus (medium) | writes docs; reliable tool-use, lighter budget (not a decision-maker) |
| scout | Gemini 3.5 Flash | fast read-only recon |

A recurring lesson, encoded in the routing above: **diversity of judgment beats raw model strength**
(keep developer ≠ judges), and **`xhigh` is for *creating*, not *deciding*** — judges that
over-deliberate just stall.

---

## Layout

```
extensions/
  foreman/            the alignment engine — gated loop + crew + pure helper modules
    index.ts            orchestrator (the only stateful/host-integrated module)
    planner.ts          Gate 1 plan contract + understanding layer + intent contract
    scorer.ts           assumption risk scorer (P × cost) + verifiable-evidence check
    teampacket.ts       founder→team relay packet (assume-unless-vetoed)
    approvalfriction.ts cost-asymmetry Gate 2 ship friction (high-risk → confirm token)
    calibration.ts      cross-task flag calibration (advisory, human-gated)
    reviewer.ts         pre-ship review verdict parser/decider
    done.ts             strict Definition-of-Done evaluator
    gates.ts            generic command|judge|action gate engine
    ledger.ts           on-disk task state (.pi/plans/<slug>/) + resume
    guard.ts            route-through-Foreman impact classifier
    agent-timeouts.ts   per-role idle/max timeout policy
    docdrift.ts         stale-doc detector for the soft doc-er stage
    crew/               planner / developer / ui-developer / scout / tester / reviewer / doc-er
    docs/               CHARTER.md (framework kernel) · INTERNALS.md (code map, doc-er-maintained)
  subagent/           spawn an agent in an isolated pi subprocess
  AskUserQuestion/    structured interactive prompt (used for gate relays)
  continual-learning/ mines the founder↔CTO chat → learned rules in AGENTS.md
  session-namer/      auto-titles pi sessions after the first turn
  grok/ codex/ antigravity/   reverse-engineered media tools (search / image / video) — see disclaimer
  statusline/ claude-studio/  TUI look & feel
config/  models.json   shared model routing (apiKey read from ${API_KEY})
docs/    architecture.md
install.sh             symlinks the workspace into ~/.pi/agent
```

Almost every module under `foreman/` except `index.ts` is **pure / node-builtin-only** — no pi SDK,
no filesystem in the core — so the whole decision layer is headlessly unit-testable. `index.ts` is
the one place that touches the host. That split is the reason a 2000-line orchestrator stays
reviewable.

---

## Setup

**Prerequisites:** [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), Node.js, and a
running [`cli-proxy-api`](https://github.com/router-for-me/CLIProxyAPI) (v7+) that routes to your
Claude / OpenAI / Gemini subscriptions.

```bash
# 1. Point models.json's apiKey at your local proxy token via env
export API_KEY="<the api-key from your cli-proxy-api config.yaml>"

# 2. Install the workspace into ~/.pi/agent (idempotent symlinks)
./install.sh

# 3. Run pi from any project
pi
```

`~/.pi/agent` is the live, machine-wide pi directory; this repo is the versioned source.
`install.sh` symlinks each domain onto the flat names pi expects, and links each crew agent per-file
(so **adding a new crew role requires re-running `./install.sh`** before it can spawn). Machine-local
`auth.json` / `sessions/` stay out of the repo. Do **not** set `PI_CODING_AGENT_DIR` for normal use.

## Test

Foreman's decision layer is covered by headless, pure-data tests (no pi, no live models, no TTY):

```bash
# the per-round verify gate Foreman runs on itself:
bash extensions/foreman/test/planner_test.sh
bash extensions/foreman/test/scorer_test.sh
bash extensions/foreman/test/approvalfriction_test.sh
bash extensions/foreman/test/calibration_test.sh
# ...and the rest under extensions/foreman/test/
```

## Documentation

- [`extensions/foreman/docs/CHARTER.md`](extensions/foreman/docs/CHARTER.md) — the portable framework kernel (roles, loop, gates, DoD, safety).
- [`extensions/foreman/docs/INTERNALS.md`](extensions/foreman/docs/INTERNALS.md) — the agent-friendly code map, kept current by the doc-er stage.
- [`docs/architecture.md`](docs/architecture.md) — how pi loads and the install/link model.

---

## Notable engineering notes

Hard-won lessons, mostly discovered by the loop failing on itself and being fixed through it:

- **Timeouts are a real signal, not flaky infra.** Repeated stalls meant a budget too tight for an
  `xhigh` role doing many tool calls — diagnosed from transcripts, fixed by role-specific budgets,
  not blind retries.
- **A green test suite can still ship a lie.** A fake theme stub once hid an invalid-token crash;
  judges now validate against ground truth, not stubs.
- **Parser robustness:** the plan-block extractor had to tolerate prose that *mentions* its own
  markers (a task about the contract broke the contract).
- **Pure vs host split** keeps the orchestrator testable and the helpers trustworthy.
- **Same-model self-review is weak.** Keep the developer cross-model from the judges; don't seat the
  cheap/fast model as a judge.

---

## Disclaimer

The `grok/`, `codex/`, and `antigravity/` extensions talk to **subscription-backed CLI proxies via
reverse-engineered transports**. They read credentials you already have locally (e.g. `~/.grok/auth.json`)
and never hardcode secrets. This is a personal-use experiment; using it may be inconsistent with the
upstream providers' Terms of Service. Use at your own risk. No secrets or API keys are committed to
this repository.

## License

MIT — see [LICENSE](LICENSE).
