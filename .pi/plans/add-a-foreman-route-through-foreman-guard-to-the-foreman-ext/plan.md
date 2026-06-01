# Plan: Add a Foreman "route-through-foreman" guard to the foreman extension so that, in the MAIN CTO session, attempts to directly implement/edit code are naturally redirected into a foreman task instead of being hand-written. This makes the AGENTS.md charter rule ("Route any non-trivial coding task through foreman by default") actually enforced by mechanism, not just prose. The founder's intent: NOT a hard wall and NOT a per-edit founder approval — a natural redirect so that "going to edit" naturally becomes "start a foreman task." The crew (developer/tester/scout/subagents) MUST stay fully able to edit.

CONTEXT / FILES:
- Extension entry: extensions/foreman/index.ts (registers the `foreman` tool via pi.registerTool; default export takes `pi: ExtensionAPI`). The crew is spawned as `pi` subprocesses by runAgent() in this same file (look for `spawn(inv.command, inv.args, { cwd, shell: false, stdio: [...] })`).
- Sibling spawner: extensions/subagent/index.ts also spawns `pi` subprocesses via `spawn(invocation.command, invocation.args, { cwd, ... })` (~line 329). These delegated agents must also be exempt.
- The pi extension API (already imported types) exposes a blockable event:
    pi.on("tool_call", handler)  where handler returns { block?: boolean; reason?: string } (type ToolCallEventResult). event has { type:"tool_call", toolName, toolCallId, input }. toolName is one of "edit"|"write"|"bash"|"read"|"grep"|"find"|"ls" plus custom tool names. event.input is the tool args (e.g. edit/write have a path; bash has { command }). Confirm exact field names from node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts (EditToolInput/WriteToolInput/BashToolInput).
- The repo's tests are plain bash+node scripts that import the .ts modules and assert (see extensions/foreman/test/gates_test.sh and ledger_test.sh for the exact style: they `import` the module via pathToFileURL and use node:assert). Follow that style.

REQUIREMENTS:
1) Crew/subagent exemption via env marker (robust, mode-independent):
   - In extensions/foreman/index.ts runAgent(): pass env to the spawn so the child has FOREMAN_CREW="1", i.e. `spawn(inv.command, inv.args, { cwd, shell: false, stdio: [...], env: { ...process.env, FOREMAN_CREW: "1" } })`.
   - Do the same in extensions/subagent/index.ts at its spawn() call.
   - The MAIN CTO session has NO FOREMAN_CREW env, so it is the only session that gets gated. Any spawned crew/subagent (and their descendants) inherit FOREMAN_CREW and are fully exempt.
2) The guard (register in the foreman extension's default export):
   - pi.on("tool_call", (event, ctx) => ...). If process.env.FOREMAN_CREW === "1" -> return undefined (never gate crew). 
   - If a session-local "direct mode" flag is on -> return undefined (escape hatch, see #4).
   - Otherwise classify with a PURE, EXPORTED, UNIT-TESTABLE function so it can be tested without spawning pi. Put it in a new file extensions/foreman/guard.ts and export e.g. `classifyToolCall({ toolName, input }): { gate: boolean; kind?: "edit"|"write"|"bash"; reason?: string }`. Rules:
       * toolName "edit" or "write" -> gate.
       * toolName "bash" -> gate ONLY when the command obviously mutates files in the tree. Be CONSERVATIVE and ERR TOWARD ALLOW (false positives break the "natural" feel). Gate on clear write patterns: output redirection to a file (`>`/`>>`/`>|` to a path, not `2>&1`/`/dev/null`), `sed -i`, `tee` writing a file, `git apply`, `git checkout -- `, `git restore `, `patch `, `dd of=`, `truncate `, `install `, and `cp`/`mv` whose destination is inside the tree. EXPLICITLY allow read-only/inspection commands: `git status|diff|log|show`, test runners, `ls|grep|rg|cat|find|head|tail|echo` (without a file redirect), `pwd`, `which`. When unsure -> do NOT gate.
       * toolName "read"|"grep"|"find"|"ls" and any other/custom tool name (including "foreman", "subagent") -> never gate.
   - When gate is true, the handler returns { block: true, reason: <natural redirect message> }. The reason is the whole point — it must read as a NATURAL nudge, not a punishment, and tell the model exactly what to do. Use wording like:
       "Implementation in the main session is routed through Foreman. Don't hand-edit here — start this change as a Foreman task: foreman({ task: \"<what you were about to do>\", verifyCommand: \"<how to verify>\" }). The developer crew will implement it and the dev→test→fix loop + gates will run. (If the founder explicitly asked for a direct edit, they can toggle /foreman-direct.)"
     Tailor a short variant for the bash case ("This bash command writes files; route the change through foreman({...}) instead.").
3) Founder escape hatch (natural, founder-controlled, NOT per-edit approval):
   - Register a slash command via pi.registerCommand("foreman-direct", { description, handler }) that TOGGLES a module-level boolean `directMode` for this session. When turning on, ctx.ui.notify or setStatus to make it visible (e.g. setStatus("foreman-direct", "⚠ foreman direct-edit mode ON")); clear the status when off. While directMode is on, the guard returns undefined (no gating). This is the "founder explicitly said do it directly / emergency hotfix" path from the charter. Keep it simple and session-local (no persistence).
4) Do NOT break anything:
   - The foreman controller writes ledger files via node:fs (not via the edit/write tools), so it is unaffected by the guard. Verify that's true (grep index.ts/ledger.ts for fs.writeFileSync vs the edit tool) and do not gate fs.* — only the LLM `edit`/`write`/`bash` TOOLS are gated.
   - Keep quota-safety intact: do not touch the --append-system-prompt logic.
   - Don't gate the dashboard shortcuts.
5) Tests — add extensions/foreman/test/guard_test.sh (chmod +x, same harness style as gates_test.sh) that imports extensions/foreman/guard.ts and asserts:
   - edit -> gate true; write -> gate true.
   - read/grep/find/ls/foreman/subagent -> gate false.
   - bash read-only commands (`npm test`, `git status`, `ls -la`, `grep -r foo .`, `echo hi`, `cat x`) -> gate false.
   - bash write commands (`echo x > a.ts`, `sed -i 's/a/b/' a.ts`, `tee a.ts`, `git apply p.patch`, `patch < p`, `cp /tmp/x a.ts`, `mv a b.ts`) -> gate true.
   - The returned reason for gated calls mentions "foreman(".
   Keep the test hermetic (no network, no pi spawn). Print a clear "Foreman guard tests passed" on success.

ACCEPTANCE: All four existing fast tests still pass (ledger, gates, fallback) AND the new guard_test passes. The guard must compile/run within index.ts (TypeScript via pi's loader). Crew subprocesses (FOREMAN_CREW=1) and directMode must both fully bypass the guard.

- Working directory: /Users/a1241968/Desktop/Oscar/my-pi-harness
- Track: backend
- Verify command: cd /Users/a1241968/Desktop/Oscar/my-pi-harness && bash extensions/foreman/test/guard_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/fallback_test.sh
- Developer: openai-codex/gpt-5.5:xhigh implements; controller runs verify (exit code = ground truth).
- Tester: cliproxy/claude-opus-4-8:high judges intent and catches cheats.
- Up to 3 fix rounds, then escalate.

