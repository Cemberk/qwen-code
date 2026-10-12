#!/usr/bin/env bash
# M6 pre-acceptance: run the OpenTUI no-flicker scenario and assert the
# renderer streams with ZERO full-screen clears and balanced DEC 2026.
# Requires: bun on PATH. Runs the offline scripted-stream gate; the
# live-model opentui-noflicker scenario can be run through runner.mjs.
# Usage: scripts/tui-parity/accept-noflicker.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

if ! command -v bun >/dev/null 2>&1; then
  echo "SKIP: bun not on PATH (OpenTUI requires bun)." >&2
  exit 77
fi
if [ ! -f packages/cli/dist/index.js ]; then
  echo "SKIP: packages/cli/dist/index.js missing (run npm run build)." >&2
  exit 77
fi

OUT="${OUT:-/tmp/opentui-noflicker-out}"
SCENARIO="scripts/tui-parity/fixtures/scenarios/opentui-noflicker-offline.scenario.json"
node scripts/tui-parity/runner.mjs --scenario "$SCENARIO" --out "$OUT"

echo "PASS: opentui no-flicker gate (0 full-screen clears, balanced DEC 2026). Report: $OUT"
