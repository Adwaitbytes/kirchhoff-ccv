#!/usr/bin/env bash
# Brings up the read-model stack the demo recording drives, isolated from every other run on this machine:
#   indexer + API (LAB_ENABLED=true) + Judge (verdict sink -> API) + web (production build, api mode).
#
#   bash media/video/stack-up.sh local|testnet      start (idempotent: skips anything already listening)
#   bash media/video/stack-up.sh down               stop what this script started
#
# Each network gets its own Postgres database (kirchhoff_video_<network>) and its own web build dir, so a
# rehearsal on Anvil can never leak into the testnet read model. Ports: API 8090, Judge 8790, web 3005.
# Logs and pids: media/video/.stack/.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STACK="$ROOT/media/video/.stack"
mkdir -p "$STACK"
NETWORK="${1:-local}"


stop_all() {
  for f in "$STACK"/*.pid; do
    [ -e "$f" ] || continue
    pid="$(cat "$f")"
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
    rm -f "$f"
  done
  echo "stack stopped"
}

if [ "$NETWORK" = "down" ]; then
  stop_all
  exit 0
fi
if [ "$NETWORK" != "local" ] && [ "$NETWORK" != "testnet" ]; then
  echo "usage: stack-up.sh local|testnet|down" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1091
source "$ROOT/.env"
set +a
# After .env, which sets its own API_PORT/JUDGE_PORT for the default dev stack.
API_PORT=8090
JUDGE_PORT=8790
WEB_PORT=3005

DB_NAME="kirchhoff_video_${NETWORK}"
docker exec kirchhoff-postgres psql -U kirchhoff -d kirchhoff -tAc "select 1 from pg_database where datname = '${DB_NAME}'" | grep -q 1 \
  || docker exec kirchhoff-postgres psql -U kirchhoff -d kirchhoff -c "create database ${DB_NAME}" >/dev/null
DB_URL="${DATABASE_URL%/*}/${DB_NAME}"

listening() { lsof -iTCP:"$1" -sTCP:LISTEN -nP >/dev/null 2>&1; }

launch() {
  local name="$1"
  shift
  "$@" >"$STACK/$name.log" 2>&1 &
  echo $! >"$STACK/$name.pid"
  echo "$name started (pid $!, log media/video/.stack/$name.log)"
}

export KIRCHHOFF_NETWORK="$NETWORK"
export DATABASE_URL="$DB_URL"

if [ "$NETWORK" = "local" ]; then
  # The Judge refuses two identical provider URLs; both names reach the same Anvil node.
  export RPC_ETH_SEPOLIA_1=http://127.0.0.1:8545 RPC_ETH_SEPOLIA_2=http://localhost:8545
  export RPC_ARB_SEPOLIA_1=http://127.0.0.1:8546 RPC_ARB_SEPOLIA_2=http://localhost:8546
  export RPC_BASE_SEPOLIA_1=http://127.0.0.1:8547 RPC_BASE_SEPOLIA_2=http://localhost:8547
fi

# The indexer migrates on start; give it a moment before the API (which also migrates) so they do not race.
alive() { [ -f "$STACK/$1.pid" ] && kill -0 "$(cat "$STACK/$1.pid")" 2>/dev/null; }
alive indexer || {
  launch indexer node "$ROOT/indexer/src/main.ts"
  sleep 4
}

listening "$API_PORT" || launch api env API_PORT="$API_PORT" API_HOST=127.0.0.1 LAB_ENABLED=true \
  LAB_COMMAND=bash LAB_ARGS="$ROOT/media/video/lab-attack.sh $NETWORK" CORS_ORIGINS="http://localhost:${WEB_PORT}" \
  WEB_PUBLIC_URL="http://localhost:${WEB_PORT}" node "$ROOT/api/src/main.ts"

listening "$JUDGE_PORT" || launch judge env JUDGE_PORT="$JUDGE_PORT" JUDGE_HOST=127.0.0.1 JUDGE_AUTH_MODE=insecure JUDGE_CELL_ID=kirchhoff-cell-1 \
  JUDGE_SPEC_PATH="$ROOT/engine/specs/kETH.yaml" JUDGE_DEPLOYMENTS_PATH="$ROOT/deployments/${NETWORK}.json" \
  JUDGE_SPEC_SYNC_SECONDS=5 VERDICT_SINK_URL="http://127.0.0.1:${API_PORT}" node "$ROOT/judge/src/main.ts"

if ! listening "$WEB_PORT"; then
  DIST=".next-video-${NETWORK}"
  if [ ! -f "$ROOT/web/$DIST/BUILD_ID" ] || [ "${REBUILD_WEB:-0}" = "1" ]; then
    echo "building web ($DIST)"
    (cd "$ROOT/web" && NEXT_DIST_DIR="$DIST" NEXT_PUBLIC_DATA_SOURCE=api NEXT_PUBLIC_API_URL="http://localhost:${API_PORT}" pnpm exec next build >"$STACK/web-build.log" 2>&1)
  fi
  launch web env NEXT_DIST_DIR="$DIST" bash -c "cd '$ROOT/web' && exec pnpm exec next start --port ${WEB_PORT}"
fi

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:${API_PORT}/healthz" >/dev/null 2>&1 && curl -sf "http://localhost:${WEB_PORT}/" >/dev/null 2>&1 && break
  sleep 1
done
echo "stack up on ${NETWORK}: web http://localhost:${WEB_PORT}  api http://127.0.0.1:${API_PORT}  judge http://127.0.0.1:${JUDGE_PORT}"
