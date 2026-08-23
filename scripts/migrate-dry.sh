#!/usr/bin/env bash
# Migration dry-run (Appendix B deploy gate): apply all migrations to a
# throwaway local D1 to prove they execute cleanly, then discard it.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
CI=1 npx wrangler d1 migrations apply botfl-db --local --persist-to "$tmp"
echo "migration dry-run: OK"
