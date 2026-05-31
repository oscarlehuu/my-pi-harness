#!/usr/bin/env bash
# Point pi at this repo's agent/ dir, so the harness runs from source.
# Usage:  source setup.sh   (must be sourced, not executed, to export into your shell)
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export PI_CODING_AGENT_DIR="$REPO_DIR/agent"
echo "PI_CODING_AGENT_DIR=$PI_CODING_AGENT_DIR"
