// Season advancement (SPEC §3.2 playoffs weeks 15–17, §3.10 consolation):
// materializes post-week-14 matchups as results arrive, and completes the
// league after week 17. DATA-DRIVEN SCAN, not settlement-outcome-driven — a
// crash between settle and hook can never wedge a season; every tick re-derives
// what is missing from what is settled. All inserts are INSERT OR IGNORE
// against UNIQUE(league_id, week, home_team_id), so the bracket freezes at
// first computation and re-runs are no-ops.
//
// Format (pinned by the engine + its tests):
//   wk15  semis 1v4, 2v3 (better seed home) + consolation round 1 (seeds 5–10)
//   wk16+17  two-week cumulative final (semi winners) and third-place game
//            (semi losers), decided by summed score; both legs inserted
//            TOGETHER once the semis settle, so the settle walker never meets
//            a half-populated week.
// Tie rules (caller-pinned, DRIFT 2026-08-30): semi tie → better seed
// advances; cumulative tie → better seed; consolation game tie → higher
// regular-season PF wins (home/away is round-robin-arbitrary there), then
// teamId; roast target = worst consolation record, tiebreak lowest
// regular-season PF (weeks ≤ 14), then teamId.

import {
  consolationPairs,
  finalPairs,
  semifinalPairs,
  type PlayoffPair,
} from '../engine/schedule';
import { playoffSeeds, settleMatchup, standings, type SettledMatchup } from '../engine/settlement';

interface MatchupRow {
  id: string;
  week: number;
  stage: string;
  home_team_id: string;
  away_team_id: string;
  home_score: number;
  away_score: number;
}

async function settledRows(db: D1Database, leagueId: string, where = ''): Promise<MatchupRow[]> {
  const rows = await db
    .prepare(
      `SELECT id, week, stage, home_team_id, away_team_id, home_score, away_score
       FROM matchups WHERE league_id = ? AND settled_at IS NOT NULL ${where}`,
    )
    .bind(leagueId)
    .all<MatchupRow>();
  return rows.results;
}

/** Regular-season table (weeks ≤ throughWeek, capped at 14 — playoff rows never pollute it). */
export async function regularSeasonTable(db: D1Database, leagueId: string, throughWeek = 14) {
  const teams = await db
    .prepare('SELECT id FROM teams WHERE league_id = ?')
    .bind(leagueId)
    .all<{ id: string }>();
  const cap = Math.min(throughWeek, 14);
  const rows = (await settledRows(db, leagueId, 'AND week <= 14')).filter((m) => m.week <= cap);
  return standings(
    teams.results.map((t) => t.id),
    rows.map((m): SettledMatchup => settleMatchup(m.home_team_id, m.away_team_id, m.home_score, m.away_score)),
  );
}

function insertPairs(db: D1Database, leagueId: string, pairs: PlayoffPair[]): D1PreparedStatement[] {
  return pairs.map((p) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO matchups (id, league_id, week, home_team_id, away_team_id, stage)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), leagueId, p.week, p.home, p.away, p.stage),
  );
}

/**
 * Winner of a settled head-to-head row; tie → home. Valid ONLY where home is
 * the better seed by construction (semis) — consolation rows use winnerOf.
 */
function rowWinner(m: MatchupRow): string {
  return m.away_score > m.home_score ? m.away_team_id : m.home_team_id;
}

/** Sum a team's score over a set of settled rows it appears in. */
function summed(rows: MatchupRow[], teamId: string): number {
  let total = 0;
  for (const m of rows) {
    if (m.home_team_id === teamId) total += m.home_score;
    else if (m.away_team_id === teamId) total += m.away_score;
  }
  return Math.round(total * 100) / 100;
}

export interface SeasonAdvance {
  playoffsSet: string[]; // league ids that just got week 15
  finalsSet: string[]; // league ids that just got weeks 16+17
  completed: string[]; // league ids that just completed
}

export async function advanceSeason(db: D1Database): Promise<SeasonAdvance> {
  const out: SeasonAdvance = { playoffsSet: [], finalsSet: [], completed: [] };
  const leagues = await db
    .prepare("SELECT id FROM leagues WHERE status = 'active'")
    .all<{ id: string }>();

  for (const { id: leagueId } of leagues.results) {
    try {
      await advanceLeague(db, leagueId, out);
    } catch (e) {
      // One malformed league must never stall season advancement for the rest.
      console.error(`season: league ${leagueId} failed:`, e);
      try {
        await db
          .prepare('INSERT INTO events (league_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
          .bind(
            leagueId,
            'cron_error',
            JSON.stringify({ phase: 'season', error: String(e).slice(0, 200) }),
            new Date().toISOString(),
          )
          .run();
      } catch {
        /* the error log must never take down the loop */
      }
    }
  }
  return out;
}

async function advanceLeague(db: D1Database, leagueId: string, out: SeasonAdvance): Promise<void> {
  {
    const state = await db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN settled_at IS NULL THEN 1 ELSE 0 END) AS unsettled,
                MAX(week) AS maxWeek
         FROM matchups WHERE league_id = ?`,
      )
      .bind(leagueId)
      .first<{ total: number; unsettled: number; maxWeek: number | null }>();
    if (!state || state.total === 0 || (state.unsettled ?? 0) > 0) return;

    if (state.maxWeek === 14) {
      // Regular season done → seed the bracket + consolation round 1..3? No:
      // consolation pairings for ALL three weeks are knowable now (round
      // robin, no advancement), but inserting weeks 16–17 consolation early
      // would let the settle walker reach a week that lacks its final/third
      // rows. Insert ONLY week 15 here; 16+17 (all stages) land together.
      const table = await regularSeasonTable(db, leagueId);
      const seeds = playoffSeeds(table, 4);
      const bottom = table.slice(4).map((r) => r.teamId);
      const wk15 = [
        ...semifinalPairs(seeds),
        ...consolationPairs(bottom).filter((p) => p.week === 15),
      ];
      // Pair inserts are idempotent; the event is NOT-EXISTS-guarded in the
      // same transaction, so colliding :00 triggers converge on one event.
      const results = await db.batch([
        ...insertPairs(db, leagueId, wk15),
        db
          .prepare(
            `INSERT INTO events (league_id, type, payload_json, created_at)
             SELECT ?, 'playoffs_set', ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM events WHERE league_id = ? AND type = 'playoffs_set')`,
          )
          .bind(leagueId, JSON.stringify({ seeds, consolation: bottom }), new Date().toISOString(), leagueId),
      ]);
      if ((results.at(-1)?.meta.changes ?? 0) === 1) out.playoffsSet.push(leagueId);
      return;
    }

    if (state.maxWeek === 15) {
      // Semis settled → both championship legs + both third-place legs +
      // consolation weeks 16 and 17, in ONE batch (participants fully known).
      const table = await regularSeasonTable(db, leagueId);
      const seedOrder = new Map(table.map((r, i) => [r.teamId, i]));
      const semis = (await settledRows(db, leagueId, "AND week = 15 AND stage = 'semi'"));
      if (semis.length !== 2) throw new Error(`week 15 settled with ${semis.length} semis`); // foreign shape → cron_error, league left for inspection
      const winners = semis.map(rowWinner).sort((a, b) => (seedOrder.get(a) ?? 9) - (seedOrder.get(b) ?? 9));
      const losers = semis
        .map((m) => (rowWinner(m) === m.home_team_id ? m.away_team_id : m.home_team_id))
        .sort((a, b) => (seedOrder.get(a) ?? 9) - (seedOrder.get(b) ?? 9));
      const bottom = table.slice(4).map((r) => r.teamId);
      const rows = [
        ...finalPairs(winners, losers, 16),
        ...finalPairs(winners, losers, 17),
        ...consolationPairs(bottom).filter((p) => p.week >= 16),
      ];
      await db.batch(insertPairs(db, leagueId, rows));
      out.finalsSet.push(leagueId);
      return;
    }

    if (state.maxWeek === 17) {
      // Season over: cumulative champion + third place; roast target from the
      // consolation record. Everything is COMPUTED FIRST — then the status
      // flip and both events commit in one transaction, so a crash can never
      // strand a `complete` league with no champion event (the old latch-first
      // ordering could). Duplicate protection: the UPDATE's status guard plus
      // NOT-EXISTS-guarded event inserts, all under SQLite's single writer.
      const finals = await settledRows(db, leagueId, "AND stage = 'final'");
      if (finals.length === 0) throw new Error('week 17 settled with no final rows'); // foreign shape → cron_error
      const thirds = await settledRows(db, leagueId, "AND stage = 'third'");
      const table = await regularSeasonTable(db, leagueId);
      const seedOrder = new Map(table.map((r, i) => [r.teamId, i]));
      const pick = (rows: MatchupRow[]): string => {
        const [a, b] = [rows[0]!.home_team_id, rows[0]!.away_team_id];
        const sa = summed(rows, a);
        const sb = summed(rows, b);
        if (sa !== sb) return sa > sb ? a : b;
        return (seedOrder.get(a) ?? 9) < (seedOrder.get(b) ?? 9) ? a : b; // cumulative tie → better seed
      };
      const champion = pick(finals);
      const third = thirds.length > 0 ? pick(thirds) : null;

      // Roast: worst consolation record → lowest regular-season PF → teamId.
      // Consolation home/away comes from round-robin alternation, so a tied
      // game must NOT default to home — winner-by-PF (DRIFT 2026-08-30 rule),
      // then teamId, keeps the roast deterministic and seed-meaningful.
      const pfAll = new Map(table.map((r) => [r.teamId, r.pointsFor]));
      const winnerOf = (m: MatchupRow): string => {
        if (m.away_score !== m.home_score) return m.away_score > m.home_score ? m.away_team_id : m.home_team_id;
        const ph = pfAll.get(m.home_team_id) ?? 0;
        const pa = pfAll.get(m.away_team_id) ?? 0;
        if (ph !== pa) return ph > pa ? m.home_team_id : m.away_team_id;
        return m.home_team_id < m.away_team_id ? m.home_team_id : m.away_team_id;
      };
      const consolation = await settledRows(db, leagueId, "AND stage = 'consolation'");
      const bottom = table.slice(4);
      const record = new Map(bottom.map((r) => [r.teamId, 0]));
      for (const m of consolation) {
        const w = winnerOf(m);
        record.set(w, (record.get(w) ?? 0) + 1);
      }
      const pf = new Map(bottom.map((r) => [r.teamId, r.pointsFor]));
      const roast = [...record.keys()].sort(
        (a, b) =>
          (record.get(a) ?? 0) - (record.get(b) ?? 0) ||
          (pf.get(a) ?? 0) - (pf.get(b) ?? 0) ||
          a.localeCompare(b),
      )[0];

      const now = new Date().toISOString();
      const stmts = [
        db
          .prepare("UPDATE leagues SET status = 'complete' WHERE id = ? AND status = 'active'")
          .bind(leagueId),
        db
          .prepare(
            `INSERT INTO events (league_id, type, payload_json, created_at)
             SELECT ?, 'champion_crowned', ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM events WHERE league_id = ? AND type = 'champion_crowned')`,
          )
          .bind(leagueId, JSON.stringify({ team_id: champion, third_place: third }), now, leagueId),
      ];
      if (roast) {
        stmts.push(
          db
            .prepare(
              `INSERT INTO events (league_id, type, payload_json, created_at)
               SELECT ?, 'roast_target', ?, ?
               WHERE NOT EXISTS (SELECT 1 FROM events WHERE league_id = ? AND type = 'roast_target')`,
            )
            .bind(leagueId, JSON.stringify({ team_id: roast }), now, leagueId),
        );
      }
      const results = await db.batch(stmts);
      if ((results[0]?.meta.changes ?? 0) === 1) out.completed.push(leagueId);
    }
  }
}
