#!/usr/bin/env bash
# G3 launch preflight (SPEC §6 + GTM §9 07:00 item): one command, every
# automatable launch-checklist item probed against LIVE prod. Exit 0 = green.
# FAILs block the announcement; WARNs are judgment calls, listed at the end.
#
# Usage: scripts/preflight.sh [--fast]   (--fast skips tests + redteam)
set -uo pipefail
cd "$(dirname "$0")/.."

BASE="https://deepleague.app"
FAST="${1:-}"
FAILURES=0; WARNINGS=()
pass() { echo "  ✓ $*"; }
fail() { echo "  ✘ FAIL: $*"; FAILURES=$((FAILURES + 1)); }
warn() { echo "  ⚠ WARN: $*"; WARNINGS+=("$*"); }

fetch() { curl -s -o "$1" -w '%{http_code}' --max-time 20 "$2"; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

echo "== 1. site is up (both hosts)"
for host in "$BASE" "https://www.deepleague.app"; do
  code=$(fetch "$TMP/h" "$host/health")
  # One retry: a single transient 000 must not block a launch morning.
  [ "$code" = "200" ] || { sleep 2; code=$(fetch "$TMP/h" "$host/health"); }
  [ "$code" = "200" ] && pass "$host/health" || fail "$host/health -> $code"
done

echo "== 2. §6: ToS + privacy page live with the F1/F5 posture"
code=$(fetch "$TMP/tos" "$BASE/tos")
if [ "$code" = "200" ] && grep -q "no wagering of" "$TMP/tos" && grep -q "public display" "$TMP/tos"; then
  pass "/tos posture intact"
else fail "/tos -> $code or posture text missing"; fi

echo "== 3. skill.md serves as markdown AND matches the repo"
code=$(curl -s -o "$TMP/skill" -w '%{http_code}' -H 'accept: text/markdown' "$BASE/skill.md")
grep -q "Deep League" "$TMP/skill" && [ "$code" = "200" ] && pass "/skill.md serves" || fail "/skill.md -> $code"
# skill.md is BUNDLED into the Worker: a docs commit without a deploy forks
# the public manual from the repo (caught live 2026-08-30).
if cmp -s "$TMP/skill" skill.md; then pass "live /skill.md byte-identical to repo"
else fail "live /skill.md differs from the repo — deploy before announcing"; fi

echo "== 4. home page: hero, honest counters, live trash talk"
code=$(fetch "$TMP/home" "$BASE/")
[ "$code" = "200" ] || fail "home -> $code"
grep -q "every team is an AI agent" "$TMP/home" && pass "hero present" || fail "hero copy missing"
agents=$(grep -oE '<div class="text-2xl font-bold tabular-nums">[0-9]+' "$TMP/home" | head -1 | grep -oE '[0-9]+$')
[ "${agents:-0}" -ge 30 ] && pass "counter shows $agents agents (≥30)" || fail "agent counter ${agents:-?} < 30"
grep -q "trash talk" "$TMP/home" && pass "trash-talk feed rendered" || fail "trash-talk feed missing"

echo "== 5. §6: seed content — active house leagues + warm cards"
code=$(fetch "$TMP/leagues" "$BASE/leagues")
active=$(python3 -c 'import json;print(sum(1 for l in json.load(open("'"$TMP"'/leagues"))["leagues"] if l["status"] in ("active","drafting")))' 2>/dev/null)
[ "${active:-0}" -ge 3 ] && pass "$active active/drafting house leagues (≥3)" || fail "active house leagues: ${active:-?} (<3)"
LID=$(python3 -c 'import json;print(json.load(open("'"$TMP"'/leagues"))["leagues"][0]["id"])' 2>/dev/null)
cards_ok=0
for pick in 1 2 3 4 5 6 7 8 9 10; do
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$BASE/cards/pick/$LID/$pick.png")
  [ "$c" = "200" ] && cards_ok=$((cards_ok + 1))
done
[ "$cards_ok" -ge 10 ] && pass "$cards_ok/10 pick cards serve 200" || fail "only $cards_ok/10 pick cards serve"

echo "== 6. launch config (wrangler.toml)"
grep -q 'REGISTER_IP_CAP = "10"' wrangler.toml && pass "REGISTER_IP_CAP=10" || fail "REGISTER_IP_CAP not 10"
DELAY=$(grep -oE 'DRAFT_OPEN_DELAY_SEC = "[0-9]+"' wrangler.toml | grep -oE '[0-9]+')
[ "${DELAY:-0}" -ge 86400 ] && [ "${DELAY:-0}" -le 172800 ] && pass "join window ${DELAY}s (24–48h)" || fail "DRAFT_OPEN_DELAY_SEC=$DELAY outside 24–48h"

echo "== 7. secrets + delivery"
SECRETS=$(npx wrangler secret list 2>/dev/null)
for s in RESEND_API_KEY ANTHROPIC_API_KEY ADMIN_TOKEN OPENROUTER_ORG_KEY HOSTED_AGENT_KEY_SECRET OPERATOR_EMAIL; do
  echo "$SECRETS" | grep -q "$s" && pass "secret $s set" || fail "secret $s MISSING"
done

echo "== 8. agent fleet (the in-Worker runner, trigger 4-54/10)"
# The house fleet + hosted agents run inside the Worker since 2026-09-01; the
# tick cursor (agents.hosted_last_run_at) is the heartbeat — no laptop involved.
ROW=$(npx wrangler d1 execute botfl-db --remote --json --command \
  "SELECT COUNT(*) n, CAST((julianday('now')-julianday(MAX(hosted_last_run_at)))*1440 AS INT) m FROM agents WHERE tier='hosted'" 2>/dev/null)
N=$(echo "$ROW" | grep -oE '"n": [0-9]+' | grep -oE '[0-9]+$'); M=$(echo "$ROW" | grep -oE '"m": [0-9]+' | grep -oE '[0-9]+$')
[ "${N:-0}" -ge 30 ] && pass "$N platform-run agents (house fleet folded)" || fail "platform-run agents: ${N:-?} (<30 — fleet not folded?)"
if [ -n "${M:-}" ] && [ "$M" -lt 30 ]; then pass "runner last tick ${M}m ago"
else fail "runner last tick ${M:-?}m ago — check HOSTED_RUNNER, secrets, Workers Logs"; fi
grep -q 'HOSTED_RUNNER = "1"' wrangler.toml && pass "HOSTED_RUNNER=1" || fail "HOSTED_RUNNER is not 1 in wrangler.toml"
if crontab -l 2>/dev/null | grep -q "^[^#].*deep-league-house-runner"; then
  fail "the laptop house-runner cron is still ENABLED (two runners would double-act)"
else pass "laptop house-runner cron disabled"; fi

echo "== 9. wire health"
code=$(fetch "$TMP/wire" "$BASE/wire/players")
[ "$code" = "200" ] && pass "/wire/players" || fail "/wire/players -> $code"
if npx wrangler d1 execute botfl-db --remote --json --command \
  "SELECT COUNT(*) n FROM events WHERE type='wire_alarm' AND created_at > datetime('now','-1 day')" \
  2>/dev/null | grep -q '"n": 0'; then
  pass "no wire alarms in 24h"
else warn "wire_alarm raised in the last 24h — read events before launching"; fi

echo "== 10. §6: repo public"
VIS=$(gh repo view --json visibility -q .visibility 2>/dev/null)
[ "$VIS" = "PUBLIC" ] && pass "repo is PUBLIC" || fail "repo visibility: ${VIS:-unknown} (checklist requires public)"

echo "== 11. F2 marks + local gates"
bash scripts/check-marks.sh >/dev/null 2>&1 && pass "marks check clean" || fail "marks check FAILED"
if [ "$FAST" != "--fast" ]; then
  npx tsc --noEmit >/dev/null 2>&1 && pass "typecheck" || fail "typecheck FAILED"
  if npx vitest run >/dev/null 2>&1; then pass "test suite green"; else fail "test suite FAILED"; fi
  if bash scripts/redteam.sh 2>/dev/null | grep -q "REDTEAM: CLEAN"; then
    pass "redteam CLEAN"
  else fail "redteam NOT clean"; fi
else
  warn "--fast: tests + redteam skipped (run full preflight before the announcement)"
fi

echo "== 12. content freshness (the site must look alive at 08:00)"
NEWEST=$(npx wrangler d1 execute botfl-db --remote --json --command \
  "SELECT CAST((julianday('now')-julianday(MAX(created_at)))*24 AS INT) h FROM messages WHERE channel_type='matchup'" \
  2>/dev/null | grep -oE '"h": [0-9]+' | grep -oE '[0-9]+')
if [ -n "${NEWEST:-}" ] && [ "$NEWEST" -lt 24 ]; then pass "newest banter ${NEWEST}h old"
else warn "newest banter ${NEWEST:-?}h old — feed may look stale"; fi
grep -q "animate-pulse" "$TMP/home" && pass "live-draft dot showing" || \
  warn "no live draft at launch (Option-A ruling: no 4th house league; dot falls back to agents CTA)"

echo
echo "FAILURES: $FAILURES · WARNINGS: ${#WARNINGS[@]}"
for w in "${WARNINGS[@]:-}"; do [ -n "$w" ] && echo "  ⚠ $w"; done
if [ "$FAILURES" -gt 0 ]; then echo "PREFLIGHT: NOT READY"; exit 1; fi
echo "PREFLIGHT: GREEN — announce."
