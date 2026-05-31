#!/usr/bin/env bash
set -euo pipefail

# Install/update the harness into pi's default machine-wide directory.
# ~/.pi/agent stays the live PI directory; this repo is the versioned source.
# Usage: ./setup.sh

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
AGENT_DIR="$HOME/.pi/agent"
mkdir -p "$AGENT_DIR"

for name in AGENTS.md agents extensions models.json; do
  if [ -e "$AGENT_DIR/$name" ] || [ -L "$AGENT_DIR/$name" ]; then
    current="$(readlink "$AGENT_DIR/$name" 2>/dev/null || true)"
    if [ "$current" != "$REPO_DIR/agent/$name" ]; then
      mv "$AGENT_DIR/$name" "$AGENT_DIR/$name.bak-$(date +%Y%m%d-%H%M%S)"
    else
      rm "$AGENT_DIR/$name"
    fi
  fi
  ln -s "$REPO_DIR/agent/$name" "$AGENT_DIR/$name"
done

python3 - <<'PY'
import json, pathlib
p=pathlib.Path.home()/'.pi/agent/settings.json'
data=json.loads(p.read_text()) if p.exists() else {}
data['defaultProvider']='cliproxy'
data['defaultModel']='claude-opus-4-8'
data['defaultThinkingLevel']='xhigh'
p.write_text(json.dumps(data, indent=2)+"\n")
PY

echo "Installed harness into $AGENT_DIR"
echo "Default: cliproxy/claude-opus-4-8:xhigh"
echo "No PI_CODING_AGENT_DIR export needed. Run: pi"
