#!/usr/bin/env bash
# Acceptance test for the Grok search extensions (web + X).
#
# Runs the live client smoke test against the subscription-backed Grok proxy.
# Exit 0 = pass (or cleanly skipped when Grok is not authorised); non-zero = fail.
#
#   bash extensions/grok/test/search_test.sh
set -Eeuo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Locate node (the test loads the .ts client via jiti, same as pi).
if ! command -v node >/dev/null 2>&1; then
  echo "SKIP: node not found on PATH." >&2
  exit 0
fi

exec node "$DIR/client_live_test.mjs"
