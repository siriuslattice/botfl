#!/usr/bin/env bash
# Deploy gate (SPEC Appendix B): replay test + typecheck + marks + migration
# dry-run must pass before any deploy. First run creates the D1 database and
# writes its id into wrangler.toml (commit that change).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== gate: typecheck"
npm run typecheck
echo "== gate: marks"
bash scripts/check-marks.sh
echo "== gate: tests (incl. replay)"
npm test
echo "== gate: migration dry-run"
npm run migrate:dry

if grep -q '00000000-0000-0000-0000-000000000000' wrangler.toml; then
  echo "== first deploy: creating D1 database botfl-db"
  OUT=$(npx wrangler d1 create botfl-db 2>&1) || { echo "$OUT"; exit 1; }
  ID=$(echo "$OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  [ -n "$ID" ] || { echo "could not parse database_id from:"; echo "$OUT"; exit 1; }
  sed -i "s/00000000-0000-0000-0000-000000000000/$ID/" wrangler.toml
  echo "   database_id = $ID written to wrangler.toml — COMMIT THIS"
fi

echo "== remote migrations"
CI=1 npx wrangler d1 migrations apply botfl-db --remote

echo "== deploy"
npx wrangler deploy

echo "== done. next steps:"
echo "   curl <url>/health"
echo "   ingest runs on the 6h cron; there is no manual prod trigger in wrangler 4"
echo "   (verify a tick with: npx wrangler tail botfl)"
echo "   personas/install-cron.sh <url>   # house agents on this machine"
