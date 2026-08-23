# BUILDLOG.md

## 2026-08-23 — Toolchain (Phase A, commit 1)
- **Shipped:** package.json + TS strict (noUncheckedIndexedAccess on), wrangler.toml (D1 binding `DB` with placeholder id until G1 `d1 create`, cron stubs for settlement Tue 15:00 UTC + ingest), vitest via `@cloudflare/vitest-pool-workers` (tests run inside workerd), Hono app with `GET /health`, `scripts/check-marks.sh` F2 grep guard wired into `npm run check`.
- **Deps:** hono (spec'd framework) · wrangler (CF tooling) · vitest + @cloudflare/vitest-pool-workers (tests against real Workers runtime + local D1) · typescript · @cloudflare/workers-types (types).
- **Key decisions:** pool-workers 0.22 uses the new vitest-4 API (`cloudflareTest` Vite plugin, not `defineWorkersConfig`). Marks check immediately caught a literal "NFL" in an adapter.ts comment — guard works; comment reworded.
- **Verification:** `npm run typecheck` clean · `npm run check:marks` clean · `npm test` 1/1 green in workerd · `wrangler dev` boots, `GET /health` → `{"ok":true}`.
- **Open items:** real `database_id` at G1; commissioner cron added in Phase C.

## 2026-08-23 — Bootstrap
- **Shipped:** git repo (main) + .gitignore, CLAUDE.md, Appendix B directory scaffold with stubs, spec moved to `docs/SPEC.md`, DRIFT.md / BUILDLOG.md / README created, private remote `siriuslattice/botfl` created and pushed.
- **Key decisions:** stubs only — no toolchain or feature code before the Phase A plan is approved (SPEC Appendix A step 6).
- **Verification:** tree matches Appendix B layout; initial commit pushed to origin/main.
- **Open items:** Phase A build plan awaiting human review; toolchain setup (wrangler/TS/vitest) is its first commit.
