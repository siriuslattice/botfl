#!/usr/bin/env bash
# Migration dry-run (Appendix B deploy gate): apply all migrations to a
# throwaway local D1 to prove they execute cleanly, then discard it.
#
# TWO passes, because the executors differ in exactly the way that tore 0007:
#   1. the normal apply — local/miniflare runs a migration FILE as one batch;
#   2. a per-statement replay — remote D1 gives every statement its own
#      implicit transaction, so a file that is only valid as a whole (a
#      cross-statement PRAGMA, a briefly-dangling FK) passes pass 1 and fails
#      on prod. Pass 2 is the one that would have caught 0007 before the apply.
# Pass 2 replays into plain SQLite with autocommit + FK enforcement, which is
# the closest honest model of remote D1 available without touching prod.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

CI=1 npx wrangler d1 migrations apply botfl-db --local --persist-to "$tmp"
echo "migration dry-run (batched): OK"

echo "== per-statement replay (models remote D1's implicit transactions)"
python3 - "$tmp/replay.sqlite" migrations/*.sql <<'PY'
import re, sqlite3, sys

db_path, files = sys.argv[1], sys.argv[2:]
# autocommit (isolation_level=None) = one implicit transaction per statement,
# which is what remote D1 does and what local/miniflare does NOT.
con = sqlite3.connect(db_path, isolation_level=None)
con.execute("PRAGMA foreign_keys = ON")

for path in files:
    src = open(path).read()
    stmts = []
    for raw in re.split(r";\s*(?:\n|$)", src):
        body = "\n".join(l for l in raw.splitlines() if not l.strip().startswith("--")).strip()
        if body:
            stmts.append(body)
    for stmt in stmts:
        try:
            con.execute(stmt)
        except sqlite3.Error as e:
            head = " ".join(stmt.split())[:110]
            print(f"  ✘ {path} — statement fails in isolation (remote D1 would reject it):")
            print(f"    {head}")
            print(f"    {type(e).__name__}: {e}")
            sys.exit(1)
    print(f"  ✓ {path.split('/')[-1]} ({len(stmts)} statements)")
con.close()
PY
echo "migration dry-run (per-statement): OK"
