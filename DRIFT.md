# DRIFT.md — gate reports & scope drift log

Gate reports (5 lines each: shipped, slipped, cost/day, next-gate risk) land at the top of the Gate reports section as gates pass. Drift entries are appended to the log below and never edited. Untouched for 3 working days = suspicious — say so.

## Gate reports

### G0 — PASSED 2026-08-23 (two days early; deadline was Tue Aug 25 EOD)
- **Shipped:** full core engine local — registration/auth, matchmaking join, snake draft w/ deadline autopick, lineup submit w/ per-player kickoff locks, data-driven weekly settlement w/ snapshot hashes; 94 tests green incl. the 2025 replay with golden exact totals; `scripts/e2e-local.sh` proves curl-register → draft 120 → lineups → cron settle end-to-end.
- **Slipped:** nothing. Free agency intentionally deferred to Phase B/C per §3.4.
- **Cost/day:** $0 (local only; no deploy, no LLM calls yet).
- **Next-gate risk (G1, Aug 29):** D1 database creation + first real deploy; Wire ingest pipeline (nflverse source formats unverified); house persona runner on mt-asus; House League #1 must draft via public API only.

## Drift log

- 2026-08-23 · Bootstrap executed per SPEC Appendix A. No drift. Phase A build plan proposed for human review before any feature code.
- 2026-08-23 · Pre-G5 TODO: add Tier 2 org-key rules to CLAUDE.md (house OpenRouter key reachable only from cron/ persona-runner paths, no endpoint proxies raw model access, D1 budget counters — on breach pause NEW hosted registrations, never in-season cycles, one hosted agent per verified email).
- 2026-08-23 · SPEC change (human-approved): §3.10 attachment & late-season retention added. Phase C items (claim ritual, advice-request) enter scope at Phase C — nothing from §3.10 is built now; it MUST NOT touch the G2 window.
- 2026-08-23 · Post-G4 TODO (hard deadline: live by Week 6, kickoff Thu Oct 15): Monday letter (references ≥1 prior `events` row), Weekly Belt, global model/persona leaderboard, consolation bracket weeks 15–17 + commissioner roast pre-announced in Week 1 (SPEC §3.10).
- 2026-08-23 · OPEN DECISION (ruling due Tue Sep 9 — decide before Week 1 or never; default NO): optional median game — each team also scores a W/L vs. the weekly league median. Adding it late changes record semantics mid-season (SPEC §3.10).
- 2026-08-23 · Lock semantics: per-player kickoff locks are PRIMARY, not optional — the global Sun 10:00 PT fallback is known-deficient (Thursday players' results are visible before a Sunday lock = start/bench-after-the-fact exploit). If the fallback is ever invoked, it MUST still lock each player at their own kickoff for any game before Sunday. Record this before G2 so it can't be "simplified" under deadline pressure.
- 2026-08-23 · Pre-G3 TODO (human + agent): replace synthetic ADP fixture with a real curated ADP board CSV before public drafts open Sep 4. Launch-checklist blocker.
