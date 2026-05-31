#!/usr/bin/env bash
set -euo pipefail

# Compose this workspace's extensions into pi's machine-wide directory (~/.pi/agent).
# The workspace is organized by DOMAIN (extensions/foreman, extensions/askuser, ...).
# pi expects a flat layout, so we symlink domains onto the names pi requires.
# Secrets/sessions stay as real files under ~/.pi/agent and are never touched.
#
# Usage: ./install.sh

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
AGENT_DIR="$HOME/.pi/agent"
mkdir -p "$AGENT_DIR/extensions"

link() {
  # link <target> <linkname>
  local target="$1" name="$2"
  if [ -e "$name" ] || [ -L "$name" ]; then
    local current
    current="$(readlink "$name" 2>/dev/null || true)"
    if [ "$current" = "$target" ]; then return; fi
    mv "$name" "$name.bak-$(date +%Y%m%d-%H%M%S)"
  fi
  ln -s "$target" "$name"
}

# --- Extensions: every domain folder under extensions/ that has an index.ts ---
for ext in "$REPO_DIR"/extensions/*/; do
  [ -f "${ext}index.ts" ] || continue
  name="$(basename "$ext")"
  link "$ext" "$AGENT_DIR/extensions/$name"
done

# --- Foreman supplies the CTO persona + the crew it orchestrates ---
link "$REPO_DIR/extensions/foreman/AGENTS.md" "$AGENT_DIR/AGENTS.md"
link "$REPO_DIR/extensions/foreman/crew"      "$AGENT_DIR/agents"

# --- Shared infra ---
link "$REPO_DIR/config/models.json" "$AGENT_DIR/models.json"

# --- Defaults (CTO model + reasoning) ---
python3 - <<'PY'
import json, pathlib
p = pathlib.Path.home() / ".pi/agent/settings.json"
data = json.loads(p.read_text()) if p.exists() else {}
data["defaultProvider"] = "cliproxy"
data["defaultModel"] = "claude-opus-4-8"
data["defaultThinkingLevel"] = "xhigh"
p.write_text(json.dumps(data, indent=2) + "\n")
PY

echo "Installed into $AGENT_DIR:"
echo "  extensions: $(ls "$AGENT_DIR/extensions" | tr '\n' ' ')"
echo "  AGENTS.md, agents/, models.json -> workspace"
echo "  default model: cliproxy/claude-opus-4-8:xhigh"
echo "Run pi from any project. No PI_CODING_AGENT_DIR needed."
