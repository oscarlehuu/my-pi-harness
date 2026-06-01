# Plan: Refine the Foreman route-through-foreman guard (extensions/foreman/guard.ts) so it gates on IMPACT, not on everything. Today every edit/write is gated, which over-enforces: writing to /tmp or editing a README triggers the full loop. The charter itself exempts trivial/no-impact work. New rule, decided MECHANICALLY BY PATH (never by model judgment, never by edit size):

NO-IMPACT (guard returns gate:false → CTO writes directly):
  (a) OUT-OF-REPO: the target path is NOT inside any git repository (no ancestor dir contains a `.git`). Out-of-repo writes can't touch a managed codebase.
  (b) SCRATCH: the target path is under a scratch/temp root — os.tmpdir(), $TMPDIR, /tmp, /private/tmp, /private/var/folders, /var/folders — even if nominally under a repo.
  (c) IN-REPO PROSE: the file is prose, decided by extension/known-name ONLY (NOT by directory): extensions .md .markdown .mdx .txt .rst .adoc; known names LICENSE, LICENCE, COPYING, NOTICE, AUTHORS (with or without extension). Prose can't change runtime behavior or break a build.

GATED (gate:true → route through foreman), this is the DEFAULT inside a repo:
  Everything else in a repo: all code (.ts/.js/.py/.go/.rs/...), all tests, and ALL config/behavioral files — .json, .yaml/.yml, .toml, .ini, .env*, Dockerfile, Makefile, *.lock and lockfiles, shell scripts, etc. Do NOT add a special config allowlist — the only in-repo exemption is the prose set above; everything else inside a repo gates. Err toward GATE inside a repo.

WHY path-not-size: importance ≠ size — a 1-line auth/logic fix is the highest-value thing to route through the loop. So there is NO size threshold anywhere. The bright line is purely the file's path/type.

IMPLEMENTATION (keep it pure + unit-testable, mirror the existing style in guard.ts):
1) Add an EXPORTED PURE helper, e.g. `isNoImpactPath(absPath: string, ctx: { repoRoot: string | null; scratchDirs: string[] }): boolean`:
   - If absPath is under any scratchDirs entry → true (scratch).
   - Else if repoRoot === null → true (out-of-repo).
   - Else (inside repo) → true ONLY if the basename matches the prose extension/known-name set; otherwise false.
   - Use path normalization so e.g. "/repo/../tmp" style and trailing slashes are handled; compare with path.resolve + a proper "is path under dir" check (not naive string startsWith that lets "/repo-foo" match "/repo").
2) Add an EXPORTED resolver `resolveImpactContext(absPath, { cwd, findGitRoot?, tmpDirs? })` OR let `classifyToolCall` take an optional second `context` arg `{ cwd: string; findRepoRoot?: (p:string)=>string|null; scratchDirs?: string[] }`. The pure path logic (isNoImpactPath) must be testable WITHOUT touching the real fs/git — tests inject repoRoot + scratchDirs directly. The fs/git-walk (walk up for `.git`) lives in a separate default resolver used by index.ts; keep it small and out of the pure function.
3) Update `classifyToolCall({ toolName, input }, context?)`:
   - edit/write: resolve the target path (input.path/file_path) to absolute via context.cwd; if isNoImpactPath → { gate:false }; else keep the existing gate:true + implementationReason.
   - bash: keep the existing "does it mutate files" detection. THEN, for the write target path(s) you can extract (redirect target, `sed -i FILE`, `tee FILE`, `cp/mv DEST`, `dd of=FILE`, etc.), if EVERY extractable target isNoImpactPath → { gate:false }; if any target is impactful OR a target can't be resolved → keep gate:true + bashReason. Conservative: unknown target ⇒ gate.
   - read/grep/find/ls and any other tool name → unchanged (gate:false).
   - Gated reason text is UNCHANGED (still mentions `foreman(`).
4) Wire index.ts: the `pi.on("tool_call", (event, ctx) => …)` handler must pass a real context — `{ cwd: ctx.cwd, findRepoRoot: <walk up from path for .git>, scratchDirs: [os.tmpdir(), process.env.TMPDIR, "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].filter(Boolean) }`. Keep the FOREMAN_CREW==='1' and directMode early-returns exactly as they are. Don't touch quota/append-system-prompt or dashboard logic.

TESTS — extend extensions/foreman/test/guard_test.sh (keep it hermetic: inject repoRoot/scratchDirs, NO real git, NO pi spawn). Assert:
  - isNoImpactPath: scratch path (e.g. under "/tmp") → true; repoRoot=null → true; "<repo>/README.md" → true; "<repo>/docs/guide.md" → true; "<repo>/src/app.ts" → false; "<repo>/config.json" → false; "<repo>/package.json" → false; "<repo>/Dockerfile" → false; ensure "/repo-foo/x.ts" is NOT considered under repoRoot "/repo" (boundary).
  - classifyToolCall with context: edit/write to a scratch path → gate:false; to out-of-repo (repoRoot=null) → gate:false; to "<repo>/README.md" → gate:false; to "<repo>/src/app.ts" → gate:true (reason matches /foreman\(/); to "<repo>/config.json" → gate:true.
  - bash: `echo x > /tmp/y.txt` → gate:false; `echo x > src/a.ts` (in repo) → gate:true; `sed -i s/a/b/ README.md` (in repo) → gate:false; `sed -i s/a/b/ src/a.ts` → gate:true.
  - Keep ALL existing guard_test assertions passing (read-only bash allowed, edit/write default behavior under a repo context, etc.) — update them to pass an in-repo context where needed so they still represent "editing real source".
  - Print "Foreman guard tests passed".
The 3 other fast tests (ledger, gates, fallback) must remain green and untouched.

ACCEPTANCE: guard_test + ledger + gates + fallback all pass. The pure isNoImpactPath has zero fs/network deps. Inside a repo, only the prose set is exempt; scratch and out-of-repo are always exempt; everything else still routes through foreman. No size-based logic anywhere.

- Working directory: /Users/a1241968/Desktop/Oscar/my-pi-harness
- Track: backend
- Per-round command gates: verify (`cd /Users/a1241968/Desktop/Oscar/my-pi-harness && bash extensions/foreman/test/guard_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/fallback_test.sh`)
- Developer: openai-codex/gpt-5.5:xhigh implements; controller runs per-round command gates (exit code = ground truth).
- Tester: cliproxy/claude-opus-4-8:high judges intent and catches cheats.
- Up to 3 fix rounds, then escalate.

