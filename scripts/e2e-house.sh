#!/usr/bin/env bash
# House-runner rehearsal: boots the same throwaway local stack as e2e-local,
# then lets the REAL persona runner (public API only, heuristic picks — no
# keys needed) draft House League #1 to completion and set week-1 lineups.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${E2E_PORT:-8803}"
BASE="http://localhost:$PORT"
PERSIST="$(mktemp -d)"
SEASON=2025
STATE="$PERSIST/house-state.json"

cleanup() {
  [ -n "${DEV_PID:-}" ] && kill -- "-$DEV_PID" 2>/dev/null || true
  rm -rf "$PERSIST"
}
trap cleanup EXIT

if curl -sf "$BASE/health" >/dev/null 2>&1; then
  echo "port $PORT already serving — kill the stale server first"
  exit 1
fi

echo "== migrations + seed"
CI=1 npx wrangler d1 migrations apply botfl-db --local --persist-to "$PERSIST" >/dev/null
OFFSET_MS=$(node -e 'console.log(Date.now() + 3*86400000 - Date.UTC(2025,8,4))')
node scripts/fixtures-to-sql.mjs players > "$PERSIST/players.sql"
node scripts/fixtures-to-sql.mjs games --season $SEASON --offset-ms "$OFFSET_MS" > "$PERSIST/games.sql"
npx wrangler d1 execute botfl-db --local --persist-to "$PERSIST" --file "$PERSIST/players.sql" >/dev/null
npx wrangler d1 execute botfl-db --local --persist-to "$PERSIST" --file "$PERSIST/games.sql" >/dev/null

echo "== start server"
setsid npx wrangler dev --port "$PORT" --persist-to "$PERSIST" --test-scheduled \
  --var DRAFT_OPEN_DELAY_SEC:0 --var CURRENT_SEASON:$SEASON --var REGISTER_IP_CAP:100 \
  >"$PERSIST/wrangler.log" 2>&1 &
DEV_PID=$!
for i in $(seq 1 60); do
  sleep 1
  curl -sf "$BASE/health" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && { echo "server never came up"; tail -20 "$PERSIST/wrangler.log"; exit 1; }
done

echo "== persona runner drafts House League #1 (heuristics, no keys)"
BASE_URL="$BASE" STATE_FILE="$STATE" node personas/runner.mjs --loop 1 --until-active

echo "== verify"
LEAGUE_ID=$(node -pe 'const s=JSON.parse(require("fs").readFileSync(process.env.STATE,"utf8")); Object.values(s.personas)[0].league_id' STATE="$STATE" 2>/dev/null || \
  STATE="$STATE" node -pe 'const s=JSON.parse(require("fs").readFileSync(process.env.STATE,"utf8")); Object.values(s.personas)[0].league_id')
curl -sf "$BASE/leagues/$LEAGUE_ID/draft" | node -e '
  const b = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (b.picks_made !== 120 || b.status !== "active") { console.error("HOUSE E2E FAIL:", b.picks_made, b.status); process.exit(1); }
  console.log("   draft:", b.picks_made, "picks,", b.status);
'
curl -sf "$BASE/l/$LEAGUE_ID/draft" | grep -q 'auto\|drafted' && echo "   draft room page renders"
curl -sf "$BASE/l/$LEAGUE_ID" | grep -qi 'standings' && echo "   league page renders"
echo "HOUSE E2E: PASS"
