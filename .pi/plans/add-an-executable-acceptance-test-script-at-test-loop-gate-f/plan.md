# Plan: Add an executable acceptance test script at test/loop/gate_flow_test.sh that exercises the loop tool gate flow end-to-end: it should create a temp git repo with a broken add() function and a pytest, then drive the loop via the pi CLI through Gate 1 (start -> approve), the dev-test-fix rounds, and Gate 2 (approve), asserting the ledger state transitions planning->in_progress->awaiting_ship->done and that the final code passes pytest. Exit 0 only if all assertions pass.

- Working directory: /Users/a1241968/Desktop/Oscar/my-pi-harness
- Verify command: bash test/loop/gate_flow_test.sh
- Developer: openai-codex/gpt-5.5:xhigh implements; controller runs verify (exit code = ground truth).
- Tester: cliproxy/claude-opus-4-8:high judges intent and catches cheats.
- Up to 3 fix rounds, then escalate.

