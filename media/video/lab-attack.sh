#!/usr/bin/env bash
# The Attack Lab command for recording takes (API LAB_COMMAND). Each take runs the full end-to-end harness (the Kelp
# Replay with every assertion, then the reset), so a filmed take is also an asserted testnet e2e run. Its JSON-lines
# step events go to media/video/.stack/attack-latest.jsonl, so record.ts can follow the run (tx hashes for the explorer
# shots, the Judge hook payload) while the Attack Lab UI streams the same events, and the whole run is kept as
# demo/logs/testnet-e2e-take-<UTC time>.log.
#
#   lab-attack.sh local|testnet
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NETWORK="${1:?usage: lab-attack.sh local|testnet}"
LOG="$ROOT/media/video/.stack/attack-latest.jsonl"
: >"$LOG"
cd "$ROOT"
mkdir -p "$ROOT/demo/logs"
TAKE_LOG="$ROOT/demo/logs/testnet-e2e-take-$(date -u +%Y%m%dT%H%M%SZ).log"
pnpm --silent --filter @kirchhoff/demo e2e --network "$NETWORK" --reports cre 2>&1 | tee -a "$LOG" "$TAKE_LOG"
