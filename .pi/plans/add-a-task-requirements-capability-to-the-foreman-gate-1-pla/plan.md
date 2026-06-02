# Plan: Add a "task requirements" capability to the Foreman Gate 1 planner so the orchestrator PROACTIVELY surfaces and asks for the environment variables, CLI tools, and background services/runtimes a task actually needs — instead of waiting for the founder to bring them up. This edits the Foreman extension at extensions/foreman/.

DESIGN DECISIONS (already approved by the founder — implement exactly these, do not redesign):
1. Behavior = ADVISORY + PROACTIVE ASK. Missing requirements are surfaced in the Gate 1 plan and the CTO is instructed to proactively ask the founder for them, but NOTHING blocks approval. No hard preflight block.
2. Persistence = PERSIST NAMES TO MANIFEST. Required env-var/tool/service NAMES (and a short reason each) are written into .pi/foreman.json as a `requirements` block when the planner produces them and Gate 1 is approved, exactly like proposedGates is today. SECRET VALUES ARE NEVER READ OR STORED — only names.
3. Detection scope = all three categories: env vars/secrets, CLI tools/binaries, and services/runtimes.

IMPLEMENTATION (keep it minimal, mirror the EXISTING proposedGates/manifest patterns; do not over-engineer):

A. gates.ts — own the manifest file format. Add exported types and helpers:
   - `RequirementCategory = "env" | "tools" | "services"`
   - `interface Requirement { name: string; reason?: string }`
   - `interface TaskRequirements { env: Requirement[]; tools: Requirement[]; services: Requirement[] }`
   - `normalizeRequirement(value): Requirement | null` (drop entries without a non-empty name; trim; keep optional reason)
   - `normalizeRequirements(value): TaskRequirements` (tolerant: missing/!array categories become [])
   - `requirementsEmpty(r): boolean`
   - `loadRequirements(cwd): TaskRequirements` reading the same .pi/foreman.json `requirements` key (return empty TaskRequirements when absent/malformed). Do NOT break loadGates.

B. planner.ts — extend the plan + manifest:
   - Import the requirement types from gates.ts (mirror how Gate is imported).
   - PlannerPlan gains `requirements: TaskRequirements`. validatePlannerPlan must parse it via normalizeRequirements but treat it as OPTIONAL/additive — a plan that omits `requirements` must still validate (default to empty), so existing strict validation of summary/steps/filesLikely/risks/proposedGates is unchanged.
   - fallbackPlannerPlan sets requirements to empty.
   - serializePlannerPlan includes requirements.
   - ForemanManifest gains `requirements?: TaskRequirements`.
   - decideManifestWrite: broaden so a manifest is written on Gate 1 approval when source is "planner", no existing manifest, AND (proposedGates non-empty OR requirements non-empty). The written manifest is `{ gates, ...(requirements non-empty ? { requirements } : {}) }`. Update the reason strings. Keep: existing manifest is always preserved; fallback/invalid source never writes.
   - Add presence-evaluation + render helpers (pure, node-builtin only):
     * `type Presence = "present" | "missing" | "unknown"`
     * `interface RequirementCheck { category: RequirementCategory; name: string; reason?: string; presence: Presence }`
     * `evaluateRequirementPresence(input: { requirements: TaskRequirements; env: Record<string,string|undefined>; toolPresent: (name: string) => boolean }): RequirementCheck[]` — env present iff env[name] is a non-empty string; tools present iff toolPresent(name); services ALWAYS "unknown" (cannot be auto-probed; founder confirms). SECURITY: do NOT execute any command to probe services — services are advisory-only.
     * `summarizeRequirementChecks(checks): { present: RequirementCheck[]; missing: RequirementCheck[]; unknown: RequirementCheck[]; hasGaps: boolean }` (hasGaps = any missing or unknown).
     * Render a `## Requirements` section inside renderFounderPlan, grouped by category, marking each item present(✓)/missing(✗)/unknown(?) with its reason. If there are no requirements at all, render a single line like "- (none detected)". The render takes the already-evaluated RequirementCheck[] (renderFounderPlan gains an optional `requirementChecks` field on PlannerContext; when absent, fall back to listing names from the plan with unknown presence so the function stays usable in tests).

C. index.ts — wire the probes and surface it (controller owns ground-truth probing, like command gates):
   - Add a side-effect-free `toolOnPath(name)` helper that scans process.env.PATH for an executable named `name` (no shell spawn; honor PATHEXT-less unix; fine to keep it unix-focused). 
   - In the Gate 1 AWAITING branch (where renderFounderPlan is called): evaluate requirement presence from the drafted plan via evaluateRequirementPresence({ requirements: drafted.plan.requirements, env: process.env, toolPresent: toolOnPath }) and pass the resulting checks into renderFounderPlan so the founder plan shows present/missing/unknown. Add the missing+unknown summary to the `gate1_awaiting` log event (e.g. `requirementGaps: [...names]`). Do NOT execute service checks.
   - PREFLIGHT EVERY RUN: after gates load (refreshGates) and after Gate 1 is approved / on resume into the round loop, load persisted requirements via loadRequirements(cwd), evaluate env+tools presence, and if there are missing/unknown items emit a single ADVISORY (non-blocking) line listing them (e.g. "Preflight: missing env OPENAI_API_KEY; confirm service postgres is running") and append a `preflight_checked` log event. This must NOT block the rounds.
   - writeProposedManifestOnGate1Approval already delegates to decideManifestWrite, so persisting requirements falls out for free once decideManifestWrite includes them — just confirm the persisted manifest round-trips and loadRequirements reads it.

D. crew/planner.md — teach the planner to detect requirements:
   - Add to recon: detect the env vars/secrets the task will read (grep for process.env / os.environ / getenv / config keys / .env.example), the external CLI tools/binaries it shells out to, and any background services/runtimes it depends on (DBs, queues, dev servers, language/runtime versions).
   - SAFETY: report only NAMES and a short reason; NEVER read, echo, or store secret VALUES; never open real .env files for their values (an .env.example for names is fine).
   - Add a `requirements` key to the PLAN-JSON contract documented in the prompt, with the shape { env: [{name, reason}], tools: [{name, reason}], services: [{name, reason}] }, and say it may be empty when the task needs nothing special.

E. crew docs / charter — make the CTO proactive (this is the core behavioral fix):
   - In extensions/foreman/AGENTS.md and extensions/foreman/docs/CHARTER.md, at the Gate 1 relay step, add: if the plan reports any MISSING or UNKNOWN requirements (env vars, tools, services), the CTO must PROACTIVELY ask the founder to provide/confirm them as part of the Gate 1 AskUserQuestion relay (or a question just before it) — rather than waiting for the founder to raise it. Keep it advisory: the founder can still approve without them. State that secret VALUES are provided by the founder out-of-band (e.g. exported in the env / .env), never pasted into the plan or stored in the manifest.

F. Tests — extend coverage (these tests are the per-round verify gate; they must pass):
   - Extend extensions/foreman/test/planner_test.sh (or add a new requirements_test.sh next to it following the same headless `node --input-type=module` style) to cover: normalizeRequirements tolerance, requirementsEmpty, validatePlannerPlan accepting a plan WITH requirements and still accepting one WITHOUT (defaults empty), serialize round-trip preserving requirements, decideManifestWrite writing requirements (gates empty + requirements non-empty => writes; both empty => no write; existing manifest preserved; fallback source never writes), evaluateRequirementPresence (env present/missing from an injected env map, tool present/missing from an injected toolPresent, services always unknown, and NO command execution), summarizeRequirementChecks.hasGaps, and renderFounderPlan emitting a `## Requirements` section with ✓/✗/? markers. If you add loadRequirements coverage, put it in gates_test.sh.

CONSTRAINTS:
- Mirror existing code style exactly; keep helpers pure/node-builtin where the existing ones are (planner.ts, gates.ts have no pi imports — keep it that way).
- Backward compatibility: existing .pi/foreman.json files without a `requirements` key must keep working; existing planner plans without requirements must still validate.
- Do NOT execute arbitrary planner-proposed commands during preflight (no service probing via shell). Env + tool probing only, both side-effect-free.
- Quota safety: do not touch the append-only system-prompt mechanism.
- The verify gate runs the full foreman test suite; all of it must pass.

## Summary (planner)
Add an advisory, proactive task-requirements capability (env vars, CLI tools, services) to the Foreman Gate 1 planner, mirroring the existing proposedGates/manifest patterns, persisting only requirement NAMES+reasons and never blocking approval.

## Steps
1. gates.ts: add RequirementCategory/Requirement/TaskRequirements types plus normalizeRequirement, normalizeRequirements (tolerant; missing or non-array categories become []), requirementsEmpty, and loadRequirements(cwd) reading the .pi/foreman.json `requirements` key (empty TaskRequirements when absent/malformed); do not change loadGates.
2. planner.ts: import the requirement types; add requirements to PlannerPlan and parse it in validatePlannerPlan as OPTIONAL/additive defaulting to empty (existing summary/steps/filesLikely/risks/proposedGates validation unchanged); set fallbackPlannerPlan requirements to empty; include requirements in serializePlannerPlan; add requirements? to ForemanManifest.
3. planner.ts: broaden decideManifestWrite to accept optional requirements and write when proposedGates non-empty OR requirements non-empty, emitting { gates, ...(requirements non-empty ? { requirements } : {}) }; keep the existing-manifest and fallback/invalid guards, keep the both-empty no-write reason matching /No valid proposed gates/, and update reason strings.
4. planner.ts: add pure Presence/RequirementCheck types, evaluateRequirementPresence (env present iff non-empty string, tools via injected toolPresent, services ALWAYS unknown, no shell), summarizeRequirementChecks (hasGaps = any missing/unknown), and a ## Requirements section in renderFounderPlan grouped by category with present(checkmark)/missing/unknown markers, driven by an optional requirementChecks on PlannerContext (fallback to plan names as unknown when absent), '(none detected)' when empty.
5. index.ts: add a side-effect-free toolOnPath(name) scanning process.env.PATH; in the Gate 1 AWAITING branch evaluate presence via evaluateRequirementPresence({ requirements: drafted.plan.requirements, env: process.env, toolPresent: toolOnPath }), pass checks into renderFounderPlan, and add requirementGaps to the gate1_awaiting log; never run service checks.
6. index.ts: add a per-run advisory preflight after refreshGates and after Gate 1 approval/resume that loads persisted requirements via loadRequirements(cwd), evaluates env+tool presence only, emits a single non-blocking advisory line for missing/unknown items, and appends a preflight_checked log without blocking the rounds; confirm writeProposedManifestOnGate1Approval passes requirements so the persisted manifest round-trips with loadRequirements.
7. crew/planner.md: extend recon to detect env vars/secrets (grep process.env/os.environ/getenv/config keys/.env.example), external CLI tools, and services/runtimes; add SAFETY (names+short reason only, never read/echo/store secret VALUES, never open real .env files); document a requirements key in the PLAN-JSON contract with shape { env:[{name,reason}], tools:[...], services:[...] } that may be empty.
8. AGENTS.md and docs/CHARTER.md: at the Gate 1 relay step, instruct the CTO to PROACTIVELY ask the founder to provide/confirm any MISSING or UNKNOWN requirements as part of (or just before) the Gate 1 AskUserQuestion, keeping it advisory (founder can still approve) and stating secret VALUES are provided out-of-band, never pasted into the plan or stored in the manifest.
9. Tests: extend extensions/foreman/test/planner_test.sh (normalizeRequirements tolerance, requirementsEmpty, validatePlannerPlan with and without requirements, serialize round-trip, decideManifestWrite requirements cases, evaluateRequirementPresence with injected env/toolPresent and no command execution, summarizeRequirementChecks.hasGaps, renderFounderPlan ## Requirements with markers) and add loadRequirements coverage to gates_test.sh; if a new requirements_test.sh is added instead, also wire it into the verify gate command.
10. Run the full Foreman test suite via the resolved verify gate and confirm all suites pass.

## Files likely
- `extensions/foreman/gates.ts`
- `extensions/foreman/planner.ts`
- `extensions/foreman/index.ts`
- `extensions/foreman/crew/planner.md`
- `extensions/foreman/AGENTS.md`
- `extensions/foreman/docs/CHARTER.md`
- `extensions/foreman/test/planner_test.sh`
- `extensions/foreman/test/gates_test.sh`
- `.pi/foreman.json`

## Risks
- The resolved verify gate hardcodes the test-file list AND greps crew/planner.md for 'claude-opus-4-8:xhigh'; a new requirements_test.sh will NOT run unless appended to that command, and any planner.md edit must preserve the model line. Safest to extend the already-wired planner_test.sh/gates_test.sh, or also update the verify command string in .pi/foreman.json.
- validatePlannerPlan must treat requirements as optional/additive — plans without it must still validate to empty — or existing planner_test.sh assertions break.
- decideManifestWrite must keep emitting exactly { gates } when requirements is empty (existing test deep-equals that) and keep the both-empty no-write reason matching /No valid proposed gates/, while broadening to write on requirements-only.
- Security: services must never be probed via shell, secret VALUES must never be read/stored (names only), and .env.example may be read for names but real .env values must not.
- Backward compatibility: existing .pi/foreman.json without a requirements key and existing persisted plans without requirements must keep working (tolerant loaders/defaults).
- gates.ts and planner.ts must remain pure/node-builtin with no pi imports, and the append-only system-prompt mechanism must not be touched (quota safety).

## Proposed gates
- verify (per-round command) — command: `grep -q "claude-opus-4-8:xhigh" extensions/foreman/crew/planner.md && bash extensions/foreman/test/planner_timeout_test.sh && bash extensions/foreman/test/planner_test.sh && bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/reviewer_test.sh && bash extensions/foreman/test/guard_test.sh && bash extensions/foreman/test/fallback_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/dashboard/test/reader_test.sh`
- review (pre-ship judge) — agent: reviewer
- commit (release action) — action: `commit`

## Proposed manifest
- Existing .pi/foreman.json is present and will be preserved.

## Execution
- Working directory: /Users/a1241968/Desktop/Oscar/my-pi-harness
- Track: backend
- Developer: openai-codex/gpt-5.5:xhigh implements; controller-owned gates remain ground truth.
- Tester: cliproxy/claude-opus-4-8:high judges intent and catches cheats.
- Up to 4 fix rounds, then escalate.
