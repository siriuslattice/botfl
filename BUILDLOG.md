# BUILDLOG.md

## 2026-08-23 — Settlement engine (Phase A, commit 6)
- **Shipped:** `src/engine/settlement.ts` — `scoreLineup` (centipoint-exact starter sums; empty slot / missing stat line = 0), `settleMatchup` (ties allowed), `canonicalStatSnapshot` (sorted players + sorted stat keys → stable string; I/O layer hashes into `matchups.stat_snapshot_hash`), `standings`, `playoffSeeds` (top 4).
- **Key decisions:** tiebreakers are win pct → points-for → points-against → teamId (total, deterministic order; no H2H in v1 — logged here as the ruling). Ties count half a win for pct.
- **Verification:** `npm test` 48/48 green — golden lineup totals, tie handling, snapshot order-invariance, tiebreak ordering, unknown-team guard, top-4 seeding.
- **Open items:** playoff bracket structure lands with matchmaking/schedule (next commit).
## 2026-08-23 — Lineup engine (Phase A, commit 5)
- **Shipped:** `src/engine/lineup.ts` — `evaluateLineup`: shape validation (unknown slot, not-on-roster, ineligible position, duplicate) + per-player kickoff locks (frozen outgoing slot, no inserting kicked-off players). Partial submissions merge over the current lineup; unchanged slots never trip locks.
- **Key decisions:** submissions are **atomic** — any error rejects the whole submission with per-slot `{code, hint}` reasons written for an LLM reader (partial-apply made duplicate resolution ambiguous). Bye players (no kickoff) never lock. Per-player locks are PRIMARY per the DRIFT ruling; no global-lock code path exists to "simplify" into.
- **Verification:** `npm test` 40/40 green — 13 lineup cases incl. the start-after-the-fact exploit, locked-slot freeze, mid-week fill of an empty slot, bye-week swaps.
- **Open items:** none.
## 2026-08-23 — Draft engine (Phase A, commit 4)
- **Shipped:** `src/engine/draft.ts` — snake order math (pick↔round↔team-slot), pick clock (4h from later of open/previous pick, capped by the 72h hard end), `starterDeficit` + `autopick` (best ADP, deterministic tie-break by playerId, forced to fill unstartable slots once remaining picks ≤ deficit).
- **Key decisions:** the 72h "window" is binding — deadlines cap at `open + 72h`, after which all remaining picks autopick (keeps slow drafts from running 480h worst-case). Deficit computation is exact for shapes whose only multi-eligible slot is a leftover-eating FLEX (the v1 shape).
- **Verification:** `npm test` 27/27 green — snake boundaries (back-to-back turn picks), 12 picks/team over 120, clock incl. hard-end cap, autopick guard forcing QB/TE at the death, exhausted board, tie-break determinism.
- **Open items:** none.
## 2026-08-23 — SportAdapter + NFL module (Phase A, commit 3)
- **Shipped:** `src/sport/adapter.ts` (RosterShape/StatLine/SportAdapter interfaces + Phase-B `WireIngest` contract), `src/sport/nfl/` (half-PPR scoring, QB/RB/RB/WR/WR/TE/FLEX + 5 bench shape), `src/sport/index.ts` registry (`getSportAdapter`).
- **Key decisions:** scoring computed in integer centipoints (all half-PPR weights are exact in cents) so integer stat lines score exactly — required for the replay test's exact-total assertions. Stat keys follow nflverse weekly naming (`passing_yards`, `receptions`, …).
- **Verification:** `npm test` 12/12 green (registry, shape, QB/RB scoring goldens, float-drift exactness, empty/unknown keys, negative lines) · typecheck + marks clean.
- **Open items:** `WireIngest` implementation lands Phase B.
## 2026-08-23 — Schema + migrations (Phase A, commit 2)
- **Shipped:** `migrations/0001_core.sql` — all SPEC §4.1 tables (owners, agents, leagues, teams, draft_picks, rosters, lineups, players, stats_weekly, injuries, transactions, matchups, messages, advice, events) plus `games` (kickoff timestamps — required by the per-player lock ruling in DRIFT), `idempotency` (replay store for agent-facing writes), `rate_counters` (fixed-window per-key/per-IP limits). Migration dry-run script (`npm run migrate:dry` applies to a throwaway local D1). Tests apply migrations via `applyD1Migrations` in workerd.
- **Key decisions:** `leagues.season` column added (stats are season-keyed; 2025 replay vs 2026 live). Player ids are sport-namespaced strings (`nfl:...`). Agent/owner name+email unique COLLATE NOCASE. `events.seq` AUTOINCREMENT append-only. Typing moved to `wrangler types`-generated `worker-configuration.d.ts` (gitignored; `npm run typecheck` regenerates) — `@cloudflare/workers-types` dep dropped in favor of generated runtime types.
- **Verification:** `npm test` 5/5 green (tables present, agent round-trip, case-insensitive UNIQUE, FK enforcement, events autoincrement) · `npm run migrate:dry` OK · typecheck clean.
- **Open items:** real `database_id` at G1 deploy.
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
