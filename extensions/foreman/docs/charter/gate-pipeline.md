# Gate Pipeline

Foreman's gate pipeline is a portable declaration system. It lets each target repo say which checks
or actions must run without baking web, mobile, backend, or release names into the orchestrator.

## Gate shape

A gate is validated as:

```ts
{
  name: string;
  kind: "command" | "judge" | "action";
  stage: "per-round" | "pre-ship" | "release";
  command?: string; // required for command gates
  agent?: string;   // required for judge gates
  action?: string;  // required for action gates
  paths?: string[]; // optional release action pathspec override, used by commit
}
```

Invalid gate entries are dropped. If `.pi/foreman.json` exists but is malformed, Foreman returns no
gates and does not synthesize the legacy verify fallback.

## Kinds

- `command` — runs a shell command in the target repo. All command gates for a stage run in
  declaration order; Foreman does not stop at the first failure because later output may help
  diagnosis. Any non-zero exit makes the aggregate stage fail.
- `judge` — runs a named crew agent. Today this is used for pre-ship reviewer gates such as
  `{ "kind": "judge", "stage": "pre-ship", "agent": "reviewer" }`.
- `action` — runs a release action after ship approval. The supported action is `commit`; unknown
  release actions are skipped and logged. Action gates declared at `pre-ship` are skipped because
  pre-ship actions are not supported.

## Stages

- `per-round` — command gates run after each developer round and before the tester. Their exit code
  is ground truth: a non-zero command result cannot be overridden into success by the tester. If no
  per-round command gate exists, the tester must infer and run appropriate read-only verification.
- `pre-ship` — after a round passes per-round gates and tester judgment, Foreman runs pre-ship
  command gates and then pre-ship judge gates. A command failure or `REVIEW: REQUEST-CHANGES` reopens
  the developer round. Inconclusive reviewer output proceeds to Gate 2 flagged, but it is not a clean
  approval for strict DoD. If the task reopens, pre-ship gates run again after the next successful
  round.
- `release` — action gates run only after Gate 2 approval and strict DoD. The `commit` action stages
  gate `paths` if provided; otherwise it derives paths from developer handoffs and includes the
  ledger path. It builds a commit message with files changed, reviewer summary, and the DoD
  checklist, then commits if the target is a git repo with staged changes.

## Declaration

Repos declare gates in `.pi/foreman.json`:

```json
{
  "gates": [
    { "name": "unit", "kind": "command", "stage": "per-round", "command": "npm test -- --runInBand" },
    { "name": "review", "kind": "judge", "stage": "pre-ship", "agent": "reviewer" },
    { "name": "commit", "kind": "action", "stage": "release", "action": "commit" }
  ]
}
```

If no `.pi/foreman.json` exists and the CTO supplied `verifyCommand`, Foreman keeps backward
compatibility by synthesizing one per-round command gate:

```json
{ "name": "verify", "kind": "command", "stage": "per-round", "command": "<verifyCommand>" }
```

If `.pi/foreman.json` exists, it is authoritative; the legacy `verifyCommand` is not synthesized.

## Web E2E example

Run fast unit checks every round and a slower Playwright browser suite once before Gate 2:

```json
{
  "gates": [
    { "name": "unit", "kind": "command", "stage": "per-round", "command": "npm test -- --runInBand" },
    { "name": "playwright", "kind": "command", "stage": "pre-ship", "command": "npx playwright test" },
    { "name": "review", "kind": "judge", "stage": "pre-ship", "agent": "reviewer" },
    { "name": "commit", "kind": "action", "stage": "release", "action": "commit" }
  ]
}
```

## Mobile E2E examples

Mobile repos can keep emulator/device checks out of every fix round and run them as pre-ship gates:

```json
{
  "gates": [
    { "name": "unit", "kind": "command", "stage": "per-round", "command": "npm test" },
    { "name": "detox-ios", "kind": "command", "stage": "pre-ship", "command": "npx detox test --configuration ios.sim.debug" },
    { "name": "maestro-smoke", "kind": "command", "stage": "pre-ship", "command": "maestro test flows/smoke.yaml" },
    { "name": "xcodebuild", "kind": "command", "stage": "pre-ship", "command": "xcodebuild test -scheme App -destination 'platform=iOS Simulator,name=iPhone 15'" },
    { "name": "review", "kind": "judge", "stage": "pre-ship", "agent": "reviewer" },
    { "name": "commit", "kind": "action", "stage": "release", "action": "commit" }
  ]
}
```

Use only commands that actually exist in the repo and environment. The planner may propose gates, but
Foreman writes a new `.pi/foreman.json` only after Gate 1 approval and never overwrites an existing
manifest.
