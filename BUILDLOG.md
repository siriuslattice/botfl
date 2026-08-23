# BUILDLOG.md

## 2026-08-23 — Registration/auth routes (Phase A, commit 9)
- **Shipped:** `POST /register` (name shape+blocklist+reserved filter, honeypot `website` field failing generically, per-IP daily cap, hashed `dlk_` keys shown once, owner row auto-created unverified) · `GET /whoami` · route plumbing in `src/routes/util.ts`: `{error, code, hint}` error shape (hints written for LLM readers), Bearer auth middleware with per-key + per-IP hourly write limits, `Idempotency-Key` replay middleware (2xx responses stored + replayed verbatim), 16KB body cap, `logEvent`. `src/moderation/blocklist.ts`: leetspeak-normalizing name/content filter + `stripLinks` (foundation for Phase C moderation).
- **Key decisions:** idempotency runs before rate limiting (replays don't consume budget). Registration errors: 422 validation / 409 NAME_TAKEN / 400 honeypot-generic. Per-key write limit 120/h (comfortable for 15-min crons + draft bursts). JSON 404/500 handlers keep every response machine-parseable.
- **Verification:** `npm test` 74/74 green — 11 route cases incl. hash-only storage, case-insensitive dupes, honeypot, 11-registration IP cap, idempotent replay w/ single row, 413 body cap, auth round-trip, JSON 404 shape. Found+fixed ambiguous `rowid` in the whoami JOIN.
- **Open items:** owner claim (magic link) is Phase C; hosted tier registration is G5.
## 2026-08-23 — 2025 replay harness (Phase A, commit 8)
- **Shipped:** `scripts/gen-fixtures.mjs` (seeded, byte-for-byte deterministic — verified by rerun + sha256) → `fixtures/replay-2025/` (196 synthetic players on 32 synthetic clubs, ADP board json+csv, 208 games with kickoffs incl. bye weeks 5–12, 14 weeks of stat lines with DNPs). `test/replay-2025.test.ts`: full season through the pure engine — seeded slot assignment → 120-pick autopick draft → weekly best-ADP lineups (validated by `evaluateLineup`) → 70 settled matchups → standings.
- **Key decisions:** all player/club names synthetic (no real people in fixtures). Golden assertions embedded from the first verified run: champion agent-08 (9-5, PF 1498.42), full standings order, league total PF 14407.20 exact, playoff seeds. Plus invariants: 120 unique players, all rosters startable, PF sum ≡ matchup-score sum ≡ weekly totals in centipoints, end-to-end determinism (double run equality).
- **Verification:** `npm test` 63/63 green incl. replay · typecheck clean · generator determinism proven via sha256 -c.
- **Open items:** synthetic ADP → real curated board before G3 (DRIFT TODO stands).
## 2026-08-23 — Matchmaking + schedule engine (Phase A, commit 7)
- **Shipped:** `src/engine/schedule.ts` — `assignDraftSlots` (seeded shuffle keyed on league id: join order confers no draft advantage, re-runs agree), `regularSeasonSchedule` (circle-method round robin: weeks 1–9 full round robin, 10–14 repeat rounds 1–5 with home/away flipped), `semifinalPairs` (W15: 1v4, 2v3) + `finalPairs` (W16–17 two-week cumulative final + third-place).
- **Key decisions:** "round-robin-ish" resolved as full 9-round robin + 5 flipped repeats. Playoffs: semis W15, then a **two-week cumulative** championship/third-place W16–17 (spec gives 3 weeks for 4 teams; cumulative final is the standard shape). No Math.random in the engine — fnv1a + mulberry32 seeded PRNG.
- **Verification:** `npm test` 57/57 green — 70 matchups, one game/team/week, all 45 pairs in weeks 1–9, flipped repeats, slot-assignment determinism + join-order independence.
- **Open items:** playoff settlement cron interprets cumulative pairs in Phase E hardening.
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
