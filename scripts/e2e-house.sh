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
HOUSE_EMAIL="house-e2e@example.com"

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
OFFSET_MS=$(node -e 'process.stdout.write(String(Date.now() + 3*86400000 - Date.UTC(2025,8,4)))')
node scripts/fixtures-to-sql.mjs players > "$PERSIST/players.sql"
node scripts/fixtures-to-sql.mjs games --season $SEASON --offset-ms "$OFFSET_MS" > "$PERSIST/games.sql"
node scripts/fixtures-to-sql.mjs adp > "$PERSIST/adp.sql"
npx wrangler d1 execute botfl-db --local --persist-to "$PERSIST" --file "$PERSIST/players.sql" >/dev/null
npx wrangler d1 execute botfl-db --local --persist-to "$PERSIST" --file "$PERSIST/games.sql" >/dev/null
npx wrangler d1 execute botfl-db --local --persist-to "$PERSIST" --file "$PERSIST/adp.sql" >/dev/null

echo "== start server"
setsid npx wrangler dev --port "$PORT" --persist-to "$PERSIST" --test-scheduled \
  --var DRAFT_OPEN_DELAY_SEC:0 --var CURRENT_SEASON:$SEASON --var REGISTER_IP_CAP:100 \
  --var DEV_EXPOSE_LINKS:1 \
  >"$PERSIST/wrangler.log" 2>&1 &
DEV_PID=$!
for i in $(seq 1 60); do
  sleep 1
  curl -sf "$BASE/health" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && { echo "server never came up"; tail -20 "$PERSIST/wrangler.log"; exit 1; }
done

echo "== persona runner drafts House League #1 (heuristics, no keys)"
ANTHROPIC_API_KEY= OPENROUTER_API_KEY= BASE_URL="$BASE" STATE_FILE="$STATE" \
  HOUSE_OWNER_EMAIL="$HOUSE_EMAIL" node personas/runner.mjs --loop 1 --until-active

echo "== verify (3 leagues, 360 picks)"
LEAGUE_ID=$(STATE="$STATE" node -pe 'const s=JSON.parse(require("fs").readFileSync(process.env.STATE,"utf8")); Object.values(s.personas)[0].league_id')
STATE="$STATE" node -e '
  const s = JSON.parse(require("fs").readFileSync(process.env.STATE, "utf8"));
  const leagues = [...new Set(Object.values(s.personas).map((p) => p.league_id))];
  if (leagues.length !== 3) { console.error("HOUSE E2E FAIL: expected 3 leagues, got", leagues.length); process.exit(1); }
  console.log(leagues.join("\n"));
' > "$PERSIST/leagues.txt"
while read -r LID; do
  curl -sf "$BASE/leagues/$LID/draft" | LID="$LID" node -e '
    const b = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (b.picks_made !== 120 || b.status !== "active") { console.error("HOUSE E2E FAIL:", process.env.LID, b.picks_made, b.status); process.exit(1); }
    console.log("   league", process.env.LID.slice(0, 8), "— 120 picks, active");
  '
done < "$PERSIST/leagues.txt"
curl -sf "$BASE/l/$LEAGUE_ID/draft" | grep -q 'auto\|drafted' && echo "   draft room page renders"
curl -sf "$BASE/l/$LEAGUE_ID" | grep -qi 'standings' && echo "   league page renders"

echo "== C6: owner claims the house teams and leaves advice"
TEAM_ID=$(STATE="$STATE" node -pe 'const s=JSON.parse(require("fs").readFileSync(process.env.STATE,"utf8")); Object.values(s.personas)[0].team_id')
LINK=$(curl -sf -X POST "$BASE/claim" -H 'content-type: application/json' -d "{\"email\":\"$HOUSE_EMAIL\"}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).dev_magic_link')
# wrangler dev reports the custom-domain origin in req.url, so follow the
# link's PATH against the local server (same trick as the vitest claim test).
CLAIM_PATH=$(node -pe 'new URL(process.argv[1]).pathname' "$LINK")
COOKIE=$(curl -sf -D - -o /dev/null "$BASE$CLAIM_PATH" | tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie: dl_owner=\([^;]*\).*/\1/p')
[ -n "$COOKIE" ] || { echo "C6 FAIL: no owner session cookie"; exit 1; }
curl -sf -X POST "$BASE/teams/$TEAM_ID/advice" -H "cookie: dl_owner=$COOKIE" -H 'content-type: application/json' \
  -d '{"body":"Consider a higher-upside FLEX this week. Your call, of course."}' >/dev/null

echo "== C6: second runner pass — greeting + public response (fallback path)"
ANTHROPIC_API_KEY= OPENROUTER_API_KEY= BASE_URL="$BASE" STATE_FILE="$STATE" \
  HOUSE_OWNER_EMAIL="$HOUSE_EMAIL" node personas/runner.mjs

curl -sf "$BASE/teams/$TEAM_ID/advice" | node -e '
  const b = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const answered = (b.advice ?? []).filter((a) => a.response);
  const notes = b.agent_notes ?? [];
  if (answered.length < 1) { console.error("C6 FAIL: advice unanswered", JSON.stringify(b).slice(0, 300)); process.exit(1); }
  if (notes.length < 1) { console.error("C6 FAIL: no greeting note"); process.exit(1); }
  console.log("   advice answered:", JSON.stringify(answered[0].response).slice(0, 72));
  console.log("   greeting posted:", JSON.stringify(notes[notes.length - 1].body).slice(0, 72));
'
curl -sf "$BASE/teams/$TEAM_ID" | node -e '
  const b = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (b.owner_claimed !== true) { console.error("C6 FAIL: owner_claimed not exposed"); process.exit(1); }
  console.log("   team card: owner_claimed true");
'
echo "HOUSE E2E: PASS"
