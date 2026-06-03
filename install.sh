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

# --- Extensions: every domain folder under extensions/ that pi can load ---
# pi loads a subdir if it has index.ts OR a package.json with a "pi.extensions"
# manifest (used by multi-tool domains like grok/ -> websearch + xsearch).
for ext in "$REPO_DIR"/extensions/*/; do
  [ -f "${ext}index.ts" ] || [ -f "${ext}package.json" ] || continue
  name="$(basename "$ext")"
  link "$ext" "$AGENT_DIR/extensions/$name"
done

# --- Foreman supplies the CTO persona + the charter ---
link "$REPO_DIR/extensions/foreman/AGENTS.md" "$AGENT_DIR/AGENTS.md"
mkdir -p "$AGENT_DIR/foreman"
link "$REPO_DIR/extensions/foreman/docs"      "$AGENT_DIR/foreman/charter"

# --- Crew + skills: real dirs populated by per-file symlinks from every extension that ships them.
# pi loads agents from ~/.pi/agent/agents/*.md and skills from ~/.pi/agent/skills/. Using a real dir
# (not a whole-dir symlink) lets multiple domains (foreman/crew, continual-learning/crew, ...) coexist.
[ -L "$AGENT_DIR/agents" ] && rm "$AGENT_DIR/agents"
mkdir -p "$AGENT_DIR/agents"
[ -L "$AGENT_DIR/skills" ] && rm "$AGENT_DIR/skills"
mkdir -p "$AGENT_DIR/skills"
for crew in "$REPO_DIR"/extensions/*/crew/; do
  [ -d "$crew" ] || continue
  for agent in "$crew"*.md; do
    [ -f "$agent" ] || continue
    link "$agent" "$AGENT_DIR/agents/$(basename "$agent")"
  done
done
for skills in "$REPO_DIR"/extensions/*/skills/; do
  [ -d "$skills" ] || continue
  for skill in "$skills"*/; do
    [ -d "$skill" ] || continue
    link "${skill%/}" "$AGENT_DIR/skills/$(basename "$skill")"
  done
done

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
echo "  AGENTS.md, agents/, foreman/charter, models.json -> workspace"
echo "  default model: cliproxy/claude-opus-4-8:xhigh"
echo "Run pi from any project. No PI_CODING_AGENT_DIR needed."
