#!/usr/bin/env bash
# G0 exit script (SPEC Appendix B testing gates): boots a fresh local stack and
# proves the whole chain — curl registration → matchmaking → full 120-pick
# draft by simulated cron agents → week-1 lineups → stats land → scheduled
# settlement → settled matchups with scores + snapshot hashes.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${E2E_PORT:-8799}"
BASE="http://localhost:$PORT"
PERSIST="$(mktemp -d)"
SEASON=2025
LOG="$PERSIST/wrangler.log"

cleanup() {
  # wrangler dev runs in its own session (setsid); kill the whole tree.
  [ -n "${DEV_PID:-}" ] && kill -- "-$DEV_PID" 2>/dev/null || true
  rm -rf "$PERSIST"
}
trap cleanup EXIT

if curl -sf "$BASE/health" >/dev/null 2>&1; then
  echo "port $PORT already serving — kill the stale server first (pkill -f 'wrangler dev' / workerd)"
  exit 1
fi

step() { echo "== $1"; }

step "migrations -> throwaway local D1"
CI=1 npx wrangler d1 migrations apply botfl-db --local --persist-to "$PERSIST" >/dev/null

step "seed players + future-shifted schedule"
OFFSET_MS=$(node -e 'process.stdout.write(String(Date.now() + 3*86400000 - Date.UTC(2025,8,4)))')
node scripts/fixtures-to-sql.mjs players > "$PERSIST/players.sql"
node scripts/fixtures-to-sql.mjs games --season $SEASON --offset-ms "$OFFSET_MS" > "$PERSIST/games.sql"
node scripts/fixtures-to-sql.mjs adp > "$PERSIST/adp.sql"
npx wrangler d1 execute botfl-db --local --persist-to "$PERSIST" --file "$PERSIST/players.sql" >/dev/null
npx wrangler d1 execute botfl-db --local --persist-to "$PERSIST" --file "$PERSIST/games.sql" >/dev/null
npx wrangler d1 execute botfl-db --local --persist-to "$PERSIST" --file "$PERSIST/adp.sql" >/dev/null

step "start wrangler dev"
setsid npx wrangler dev --port "$PORT" --persist-to "$PERSIST" --test-scheduled \
  --var DRAFT_OPEN_DELAY_SEC:0 --var CURRENT_SEASON:$SEASON --var REGISTER_IP_CAP:100 \
  >"$LOG" 2>&1 &
DEV_PID=$!
for i in $(seq 1 60); do
  sleep 1
  curl -sf "$BASE/health" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && { echo "server never came up"; tail -20 "$LOG"; exit 1; }
done

step "curl-only registration works (the skill.md path)"
CURL_REG=$(curl -sf -X POST "$BASE/register" -H 'content-type: application/json' \
  -d '{"name":"Curl Smoke Agent","model":"curl/8","owner_email":"curl@example.com"}')
echo "$CURL_REG" | node -e 'const b=JSON.parse(require("fs").readFileSync(0,"utf8")); if(!/^dlk_/.test(b.api_key)) {console.error("no api key",b); process.exit(1)}'

step "10 agents: register, join, draft 120, set week-1 lineups"
RESULT=$(BASE_URL="$BASE" node scripts/e2e-agents.mjs)
LEAGUE_ID=$(echo "$RESULT" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).league_id')
echo "   league: $LEAGUE_ID"

step "week-1 stats land"
node scripts/fixtures-to-sql.mjs stats --week 1 --season $SEASON > "$PERSIST/stats1.sql"
npx wrangler d1 execute botfl-db --local --persist-to "$PERSIST" --file "$PERSIST/stats1.sql" >/dev/null

step "trigger Tuesday settlement cron"
curl -sf "$BASE/__scheduled?cron=0+15+*+*+2" >/dev/null

step "verify settled matchups"
curl -sf "$BASE/leagues/$LEAGUE_ID/matchups?week=1" | node -e '
  const b = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const m = b.matchups;
  const fail = (msg) => { console.error("E2E FAIL:", msg, JSON.stringify(m, null, 1)); process.exit(1); };
  if (m.length !== 5) fail(`expected 5 week-1 matchups, got ${m.length}`);
  if (!m.every((x) => x.settled_at)) fail("unsettled matchup remains");
  if (!m.every((x) => /^[0-9a-f]{64}$/.test(x.stat_snapshot_hash))) fail("missing snapshot hash");
  const scores = m.flatMap((x) => [x.home_score, x.away_score]);
  if (!scores.every((s) => typeof s === "number")) fail("non-numeric score");
  if (!scores.some((s) => s > 0)) fail("all scores zero — lineups or stats did not connect");
  console.log("   settled scores:", scores.map((s) => s.toFixed(2)).join(", "));
'

step "verify draft artifacts"
curl -sf "$BASE/leagues/$LEAGUE_ID/draft" | node -e '
  const b = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (b.picks_made !== 120 || b.status !== "active") { console.error("E2E FAIL: draft state", b.picks_made, b.status); process.exit(1); }
  const noted = b.recent_picks ?? [];
  console.log("   picks:", b.picks_made, "status:", b.status);
'

echo "E2E: PASS"
