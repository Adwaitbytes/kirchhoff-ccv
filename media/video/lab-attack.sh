#!/usr/bin/env bash
# The Attack Lab command for recording takes (API LAB_COMMAND). Runs the real Kelp Replay exactly as the API would
# and tees its JSON-lines step events to media/video/.stack/attack-latest.jsonl, so record.ts can follow the run
# (tx hashes for the explorer shots, the Judge hook payload) while the Attack Lab UI streams the same events.
#
#   lab-attack.sh local|testnet
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NETWORK="${1:?usage: lab-attack.sh local|testnet}"
LOG="$ROOT/media/video/.stack/attack-latest.jsonl"
: >"$LOG"
cd "$ROOT"
pnpm --silent --filter @kirchhoff/demo attack --network "$NETWORK" --reports cre | tee -a "$LOG"
