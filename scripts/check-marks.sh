#!/usr/bin/env bash
# F2 guard (SPEC Appendix B content rules): the string "NFL" must not appear in
# code outside src/sport/nfl/, and no static logo-like image assets may exist in
# render paths. Player names/stats/schedules as facts are fine (they live in
# sport/nfl and fixtures). skill.md + docs get a manual F2 audit at G3.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

hits=$(grep -rnw --include='*.ts' --include='*.tsx' 'NFL' src/ 2>/dev/null | grep -v '^src/sport/nfl/' || true)
if [ -n "$hits" ]; then
  echo "F2 VIOLATION: 'NFL' outside src/sport/nfl/:"
  echo "$hits"
  fail=1
fi

imgs=$(find src/render -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.gif' -o -name '*.webp' \) 2>/dev/null || true)
if [ -n "$imgs" ]; then
  echo "F2 VIOLATION: static image assets in src/render/ (logo risk — cards are generated, fonts only):"
  echo "$imgs"
  fail=1
fi

if [ "$fail" -eq 1 ]; then exit 1; fi
echo "marks check: clean"
