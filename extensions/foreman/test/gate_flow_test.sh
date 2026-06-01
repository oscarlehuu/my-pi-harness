#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
LOOP_EXT="$ROOT_DIR/extensions/foreman/index.ts"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pi-loop-gate-flow.XXXXXX")"
REPO="$TMP_ROOT/repo"
LOG_DIR="$TMP_ROOT/logs"
STATE_FILE=""
PLAN_DIR=""
PI_BG_PID=""

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cleanup() {
  local status=$?
  if [[ -n "${PI_BG_PID:-}" ]] && kill -0 "$PI_BG_PID" >/dev/null 2>&1; then
    kill "$PI_BG_PID" >/dev/null 2>&1 || true
    wait "$PI_BG_PID" >/dev/null 2>&1 || true
  fi
  if [[ $status -eq 0 ]]; then
    rm -rf "$TMP_ROOT"
  else
    echo "" >&2
    echo "Gate flow test failed. Temp repo/logs kept at: $TMP_ROOT" >&2
    if [[ -d "$LOG_DIR" ]]; then
      echo "Logs:" >&2
      find "$LOG_DIR" -maxdepth 1 -type f -print >&2 || true
    fi
  fi
}
trap cleanup EXIT

require_file() {
  [[ -f "$1" ]] || fail "required file missing: $1"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

require_cmd pi
require_cmd git
require_cmd python3
require_file "$LOOP_EXT"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
require_file "$AGENT_DIR/agents/developer.md"
require_file "$AGENT_DIR/agents/tester.md"

mkdir -p "$REPO" "$LOG_DIR"

cat >"$LOG_DIR/driver-system-prompt.txt" <<'PROMPT'
You are a deterministic CLI tool bridge for an acceptance test.
When the user gives JSON arguments for the `foreman` tool, call `foreman` exactly once with exactly those arguments.
Do not call any other tool. Do not change files yourself. After the tool returns, respond with one short line.
PROMPT
DRIVER_SYSTEM_PROMPT="$(cat "$LOG_DIR/driver-system-prompt.txt")"

seed_repo() {
  cd "$REPO"
  git init -q
  git config user.email "gate-flow@example.invalid"
  git config user.name "Gate Flow Test"

  cat > calc.py <<'PY'
def add(a, b):
    return a - b
PY

  mkdir -p tests pytest
  cat > tests/test_calc.py <<'PY'
from calc import add


def test_add_positive_numbers():
    assert add(2, 3) == 5


def test_add_negative_and_positive():
    assert add(-2, 5) == 3
PY

  # Self-contained fallback for environments without pytest installed. It supports
  # the tiny pytest-style tests in this temp repo and is invoked as `python3 -m pytest`.
  cat > pytest/__main__.py <<'PY'
import importlib.util
import pathlib
import sys
import traceback


def main():
    root = pathlib.Path.cwd()
    sys.path.insert(0, str(root))
    test_files = sorted((root / "tests").glob("test_*.py")) + sorted(root.glob("test_*.py"))
    total = 0
    failed = 0
    for test_file in test_files:
        module_name = "_pytest_shim_" + test_file.stem
        spec = importlib.util.spec_from_file_location(module_name, test_file)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for name in sorted(dir(module)):
            obj = getattr(module, name)
            if name.startswith("test_") and callable(obj):
                total += 1
                try:
                    obj()
                except Exception:
                    failed += 1
                    print(f"{test_file.relative_to(root)}::{name} FAILED")
                    traceback.print_exc()
    if total == 0:
        print("no tests collected")
        return 5
    if failed:
        print(f"{failed} failed, {total - failed} passed")
        return 1
    print(f"{total} passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
PY

  git add calc.py tests/test_calc.py pytest/__main__.py
  git commit -qm "seed broken add fixture"
}

VERIFY_COMMAND='python3 -m pytest -q'
TASK='Fix calc.add(a, b) so it returns the arithmetic sum for all existing tests. Do not edit tests/test_calc.py or pytest/__main__.py.'

seed_repo
PROTECTED_FIXTURE_HASH="$(cd "$REPO" && python3 - <<'PY'
import hashlib
for name in ("tests/test_calc.py", "pytest/__main__.py"):
    h = hashlib.sha256(open(name, "rb").read()).hexdigest()
    print(f"{name}:{h}")
PY
)"

if (cd "$REPO" && $VERIFY_COMMAND) >"$LOG_DIR/seed-pytest.out" 2>"$LOG_DIR/seed-pytest.err"; then
  fail "seed repo tests unexpectedly passed before loop ran"
fi

json_field() {
  local file=$1
  local field=$2
  python3 - "$file" "$field" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as f:
    value = json.load(f)
for part in sys.argv[2].split("."):
    value = value[part]
if isinstance(value, bool):
    print("true" if value else "false")
else:
    print(value)
PY
}

find_state_file() {
  local -a states=()
  if [[ -d "$REPO/.pi/plans" ]]; then
    while IFS= read -r line; do
      states+=("$line")
    done < <(find "$REPO/.pi/plans" -mindepth 2 -maxdepth 2 -name state.json -print | sort)
  fi
  [[ ${#states[@]} -eq 1 ]] || fail "expected exactly one ledger state.json, found ${#states[@]}"
  printf '%s\n' "${states[0]}"
}

assert_state() {
  local expected=$1
  local actual
  actual="$(json_field "$STATE_FILE" state)"
  [[ "$actual" == "$expected" ]] || fail "expected ledger state '$expected', got '$actual' in $STATE_FILE"
  echo "asserted state: $expected"
}

wait_for_state() {
  local expected=$1
  local timeout=${2:-180}
  local start=$SECONDS
  local actual="(missing)"
  while (( SECONDS - start < timeout )); do
    if [[ -f "$STATE_FILE" ]]; then
      actual="$(json_field "$STATE_FILE" state || true)"
      if [[ "$actual" == "$expected" ]]; then
        echo "observed state: $expected"
        return 0
      fi
    fi
    sleep 0.25
  done
  fail "timed out waiting for ledger state '$expected' (last: $actual)"
}

assert_json_state_fields() {
  local expected_state=$1
  local expected_gate1=$2
  local expected_gate2=$3
  python3 - "$STATE_FILE" "$expected_state" "$expected_gate1" "$expected_gate2" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as f:
    state = json.load(f)
expected_state, expected_gate1, expected_gate2 = sys.argv[2:5]
errors = []
if state.get("state") != expected_state:
    errors.append(f"state={state.get('state')!r}")
if str(state.get("gate1Approved")).lower() != expected_gate1:
    errors.append(f"gate1Approved={state.get('gate1Approved')!r}")
if str(state.get("gate2Approved")).lower() != expected_gate2:
    errors.append(f"gate2Approved={state.get('gate2Approved')!r}")
if expected_state in {"awaiting_ship", "done"} and int(state.get("round", 0)) < 1:
    errors.append(f"round={state.get('round')!r}")
if errors:
    raise SystemExit("bad state fields: " + ", ".join(errors))
PY
}

assert_log_event() {
  local event=$1
  grep -q '"type":"'"$event"'"' "$PLAN_DIR/log.jsonl" || fail "ledger log missing event: $event"
}

assert_handoffs() {
  local count
  count="$(find "$PLAN_DIR/handoffs" -type f -name '*.json' | wc -l | tr -d ' ')"
  [[ "$count" -ge 2 ]] || fail "expected at least developer+tester handoffs, found $count"
  find "$PLAN_DIR/handoffs" -type f -name '*__developer-r*.json' | grep -q . || fail "missing developer handoff"
  find "$PLAN_DIR/handoffs" -type f -name '*__tester-r*.json' | grep -q . || fail "missing tester handoff"
}

assert_phase_a_capture() {
  local transcript_dir="$PLAN_DIR/transcripts"
  local activity_file="$PLAN_DIR/activity.json"
  [[ -d "$transcript_dir" ]] || fail "missing transcript directory: $transcript_dir"
  find "$transcript_dir" -type f -name '*.jsonl' -size +0c | grep -q . || fail "expected at least one non-empty transcript jsonl"
  [[ -f "$activity_file" ]] || fail "missing activity.json"
  grep -Fxq 'plans/*/activity.json' "$REPO/.pi/.gitignore" || fail ".pi/.gitignore missing activity.json exclusion"
  python3 - "$activity_file" "$transcript_dir" <<'PY'
import json
import pathlib
import sys

activity_path = pathlib.Path(sys.argv[1])
transcript_dir = pathlib.Path(sys.argv[2])
activity = json.loads(activity_path.read_text(encoding="utf-8"))
required = {"updatedAt", "round", "phase", "activeTranscript", "note", "pid"}
missing = sorted(required - set(activity))
if missing:
    raise SystemExit(f"activity.json missing fields: {missing}")
if activity["phase"] not in {"developer", "verify", "tester", "idle"}:
    raise SystemExit(f"bad activity phase: {activity['phase']!r}")
files = sorted(p for p in transcript_dir.glob("*.jsonl") if p.stat().st_size > 0)
if not files:
    raise SystemExit("no non-empty transcript files")
seen_start = False
for path in files:
    for line in path.read_text(encoding="utf-8").splitlines():
        event = json.loads(line)
        if event.get("kind") == "agent_start":
            seen_start = True
if not seen_start:
    raise SystemExit("transcripts did not contain an agent_start event")
PY
}

pi_args=()
if [[ -n "${PI_GATE_FLOW_DRIVER_MODEL:-}" ]]; then
  pi_args+=(--model "$PI_GATE_FLOW_DRIVER_MODEL")
fi

run_pi_sync() {
  local name=$1
  local prompt=$2
  local out="$LOG_DIR/$name.jsonl"
  local err="$LOG_DIR/$name.stderr"
  echo "==> pi $name"
  (
    cd "$REPO"
    PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
      pi --mode json --print --no-session --no-context-files --no-builtin-tools --no-extensions \
        --extension "$LOOP_EXT" --tools foreman --system-prompt "$DRIVER_SYSTEM_PROMPT" \
        ${pi_args[@]+"${pi_args[@]}"} "$prompt"
  ) >"$out" 2>"$err" || {
    tail -80 "$err" >&2 || true
    fail "pi command failed for $name (see $out / $err)"
  }
  grep -q '"toolName":"foreman"' "$out" || fail "pi command $name did not execute foreman tool (see $out)"
}

start_pi_async() {
  local name=$1
  local prompt=$2
  local out="$LOG_DIR/$name.jsonl"
  local err="$LOG_DIR/$name.stderr"
  echo "==> pi $name (background)"
  (
    cd "$REPO"
    PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
      pi --mode json --print --no-session --no-context-files --no-builtin-tools --no-extensions \
        --extension "$LOOP_EXT" --tools foreman --system-prompt "$DRIVER_SYSTEM_PROMPT" \
        ${pi_args[@]+"${pi_args[@]}"} "$prompt"
  ) >"$out" 2>"$err" &
  PI_BG_PID=$!
}

start_prompt=$(cat <<EOF
Call the foreman tool exactly once with these JSON arguments:
{
  "task": "$TASK",
  "verifyCommand": "$VERIFY_COMMAND",
  "maxRounds": 3,
  "cwd": "$REPO"
}
EOF
)

approve_prompt=$(cat <<EOF
Call the foreman tool exactly once with these JSON arguments:
{
  "resume": true,
  "approve": true,
  "cwd": "$REPO"
}
EOF
)

# Gate 1 start: ledger is created and pauses at planning.
run_pi_sync gate1_start "$start_prompt"
STATE_FILE="$(find_state_file)"
PLAN_DIR="$(dirname "$STATE_FILE")"
assert_state planning
assert_json_state_fields planning false false
assert_log_event gate1_awaiting

# Gate 1 approval: observe in_progress while the loop performs dev/test work,
# then assert it pauses at Gate 2 awaiting shipment.
start_pi_async gate1_approve "$approve_prompt"
wait_for_state in_progress 180
if ! wait "$PI_BG_PID"; then
  tail -120 "$LOG_DIR/gate1_approve.stderr" >&2 || true
  fail "pi command failed for gate1_approve"
fi
PI_BG_PID=""
grep -q '"toolName":"foreman"' "$LOG_DIR/gate1_approve.jsonl" || fail "pi command gate1_approve did not execute foreman tool"
assert_state awaiting_ship
assert_json_state_fields awaiting_ship true false
assert_log_event gate1_approved
assert_log_event round_started
assert_log_event verify_ran
assert_log_event verdict
assert_log_event gate2_awaiting
assert_handoffs
assert_phase_a_capture

# Gate 2 approval: marks the task done.
run_pi_sync gate2_approve "$approve_prompt"
assert_state done
assert_json_state_fields done true true
assert_log_event gate2_approved
assert_log_event task_done

# The finished temp repo must pass its pytest command.
(cd "$REPO" && $VERIFY_COMMAND) >"$LOG_DIR/final-pytest.out" 2>"$LOG_DIR/final-pytest.err" || {
  tail -80 "$LOG_DIR/final-pytest.out" >&2 || true
  tail -80 "$LOG_DIR/final-pytest.err" >&2 || true
  fail "final code did not pass pytest"
}

# The acceptance fixture should have been fixed in source, not by editing tests/runner.
PROTECTED_FIXTURE_HASH_AFTER="$(cd "$REPO" && python3 - <<'PY'
import hashlib
for name in ("tests/test_calc.py", "pytest/__main__.py"):
    h = hashlib.sha256(open(name, "rb").read()).hexdigest()
    print(f"{name}:{h}")
PY
)"
[[ "$PROTECTED_FIXTURE_HASH_AFTER" == "$PROTECTED_FIXTURE_HASH" ]] || fail "tests or pytest runner were modified"
(cd "$REPO" && python3 - <<'PY'
from calc import add
assert add(2, 3) == 5
assert add(-2, 5) == 3
PY
) || fail "calc.add still returns incorrect results"

echo "PASS: loop gate flow reached planning -> in_progress -> awaiting_ship -> done and final pytest passed"
