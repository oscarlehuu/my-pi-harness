#!/usr/bin/env bash
# Acceptance test for the Antigravity image extensions.
#
# Loads the .ts client/tools through jiti (same as pi), then runs one live tiny
# image generation against the local cli-proxy-api. Exit 0 = pass, or cleanly
# skipped when the proxy/API key is unavailable; non-zero = real failure.
#
#   bash extensions/antigravity/test/image_test.sh
set -Eeuo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

if ! command -v node >/dev/null 2>&1; then
  echo "SKIP: node not found on PATH." >&2
  exit 0
fi

exec node "$DIR/image_live_test.mjs"
