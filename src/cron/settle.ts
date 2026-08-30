// Weekly settlement (SPEC §3.2/§3.4.5): deterministic, re-runnable, data-driven.
// A league-week is DUE only when stat lines exist for its (season, week) AND
// the week is COMPLETE: every game of that week shows at least one stat line
// from either club (coverage), or — the deadman for a cancelled/postponed game
// that will never produce stats — the week's last kickoff is >48h old (logged
// as settle_forced). "Any row exists" alone is how a partially played week
// settles with zeros: nflverse republishes the season stats file nightly WHILE
// a week is in progress. Empty games tables (dev, pure fixtures) are vacuously
// covered, so stats-present keeps its old meaning there.
//
// Concurrency: cron triggers collide at :00 (*/10 vs 0 */6 vs Tue 15:00), so
// week_settled/belt_won events ride a per-(league, week) latch in `settlements`
// — exactly one invocation owns them (INSERT-claim, 10-min stale takeover).
// Score UPDATEs stay re-runnable via settled_at IS NULL. Snapshot hash of the
// consumed stat lines is stored per matchup (Appendix B).

import { scoreLineup, canonicalStatSnapshot } from '../engine/settlement';
import type { LineupAssignment } from '../engine/lineup';
import { getSportAdapter } from '../sport';
import type { StatLine } from '../sport/adapter';

const STALE_CLAIM_MS = 10 * 60_000;
const FORCE_AFTER_MS = 48 * 3600_000;

interface MatchupRow {
  id: string;
  league_id: string;
  week: number;
  home_team_id: string;
  away_team_id: string;
}

async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function lineupsFor(
  db: D1Database,
  teamIds: string[],
  week: number,
): Promise<Map<string, LineupAssignment>> {
  const out = new Map<string, LineupAssignment>();
  if (teamIds.length === 0) return out;
  const placeholders = teamIds.map(() => '?').join(',');
  const rows = await db
    .prepare(`SELECT team_id, slot, player_id FROM lineups WHERE week = ? AND team_id IN (${placeholders})`)
    .bind(week, ...teamIds)
    .all<{ team_id: string; slot: string; player_id: string | null }>();
  for (const r of rows.results) {
    if (!out.has(r.team_id)) out.set(r.team_id, {});
    out.get(r.team_id)![r.slot] = r.player_id;
  }
  return out;
}

interface WeekGate {
  due: boolean;
  forced: boolean;
}

/** Is (sport, season, week) complete enough to settle? See file header. */
async function weekGate(
  db: D1Database,
  sport: string,
  season: number,
  week: number,
  nowMs: number,
): Promise<WeekGate> {
  const stats = await db
    .prepare('SELECT COUNT(*) AS n FROM stats_weekly WHERE season = ? AND week = ?')
    .bind(season, week)
    .first<{ n: number }>();
  if ((stats?.n ?? 0) === 0) return { due: false, forced: false };

  const uncovered = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM games g
       WHERE g.sport = ? AND g.season = ? AND g.week = ?
         AND NOT EXISTS (
           SELECT 1 FROM stats_weekly s JOIN players p ON p.id = s.player_id
           WHERE s.season = g.season AND s.week = g.week AND p.sport = g.sport
             AND (p.team = g.home OR p.team = g.away))`,
    )
    .bind(sport, season, week)
    .first<{ n: number }>();
  if ((uncovered?.n ?? 0) === 0) return { due: true, forced: false };

  const last = await db
    .prepare('SELECT MAX(kickoff_at) AS last FROM games WHERE sport = ? AND season = ? AND week = ?')
    .bind(sport, season, week)
    .first<{ last: string | null }>();
  if (last?.last && Date.parse(last.last) <= nowMs - FORCE_AFTER_MS) {
    return { due: true, forced: true };
  }
  return { due: false, forced: false };
}

/** Claim the (league, week) settlement latch; true = this invocation owns it. */
async function claimSettlement(
  db: D1Database,
  leagueId: string,
  week: number,
  nowMs: number,
): Promise<boolean> {
  const nowStr = new Date(nowMs).toISOString();
  const ins = await db
    .prepare(
      'INSERT INTO settlements (league_id, week, claimed_at) VALUES (?, ?, ?) ON CONFLICT (league_id, week) DO NOTHING',
    )
    .bind(leagueId, week, nowStr)
    .run();
  if (ins.meta.changes === 1) return true;
  // A row exists: adopt it only if its owner went quiet before finishing.
  const stale = await db
    .prepare(
      'UPDATE settlements SET claimed_at = ? WHERE league_id = ? AND week = ? AND settled_at IS NULL AND claimed_at < ?',
    )
    .bind(nowStr, leagueId, week, new Date(nowMs - STALE_CLAIM_MS).toISOString())
    .run();
  return stale.meta.changes === 1;
}

export interface SettleOutcome {
  matchups: number;
  leagueWeeks: { leagueId: string; week: number }[];
}

/** Settle every due, unsettled league-week. Returns what settled (for logs). */
export async function settleDueWeeks(db: D1Database): Promise<SettleOutcome> {
  const leagues = await db
    .prepare("SELECT id, sport, season FROM leagues WHERE status = 'active'")
    .all<{ id: string; sport: string; season: number }>();
  const outcome: SettleOutcome = { matchups: 0, leagueWeeks: [] };
  const gateMemo = new Map<string, WeekGate>();

  for (const league of leagues.results) {
    try {
      const adapter = getSportAdapter(league.sport);
      // Weeks settle strictly in order; stop at the first week not yet due.
      for (;;) {
        const next = await db
          .prepare(
            'SELECT week FROM matchups WHERE league_id = ? AND settled_at IS NULL ORDER BY week ASC LIMIT 1',
          )
          .bind(league.id)
          .first<{ week: number }>();
        if (!next) break;
        const week = next.week;
        const nowMs = Date.now();

        const memoKey = `${league.sport}|${league.season}|${week}`;
        let gate = gateMemo.get(memoKey);
        if (!gate) {
          gate = await weekGate(db, league.sport, league.season, week, nowMs);
          gateMemo.set(memoKey, gate);
        }
        if (!gate.due) break;
        if (!(await claimSettlement(db, league.id, week, nowMs))) break; // a live peer owns it

        const matchups = await db
          .prepare(
            'SELECT id, league_id, week, home_team_id, away_team_id FROM matchups WHERE league_id = ? AND week = ? AND settled_at IS NULL',
          )
          .bind(league.id, week)
          .all<MatchupRow>();

        const teamIds = [...new Set(matchups.results.flatMap((m) => [m.home_team_id, m.away_team_id]))];
        const lineups = await lineupsFor(db, teamIds, week);

        const starterIds = [
          ...new Set(
            teamIds.flatMap((t) => Object.values(lineups.get(t) ?? {}).filter((p): p is string => p !== null)),
          ),
        ];
        const statsByPlayer = new Map<string, StatLine>();
        for (let i = 0; i < starterIds.length; i += 50) {
          const chunk = starterIds.slice(i, i + 50);
          const placeholders = chunk.map(() => '?').join(',');
          const rows = await db
            .prepare(
              `SELECT player_id, stat_json FROM stats_weekly WHERE season = ? AND week = ? AND player_id IN (${placeholders})`,
            )
            .bind(league.season, week, ...chunk)
            .all<{ player_id: string; stat_json: string }>();
          for (const r of rows.results) statsByPlayer.set(r.player_id, JSON.parse(r.stat_json) as StatLine);
        }

        const settledAt = new Date().toISOString();
        for (const m of matchups.results) {
          const homeLineup = lineups.get(m.home_team_id) ?? {};
          const awayLineup = lineups.get(m.away_team_id) ?? {};
          const home = scoreLineup(adapter, homeLineup, statsByPlayer);
          const away = scoreLineup(adapter, awayLineup, statsByPlayer);
          const consumed = new Map<string, StatLine>();
          for (const p of [...Object.values(homeLineup), ...Object.values(awayLineup)]) {
            if (p !== null && p !== undefined && statsByPlayer.has(p)) consumed.set(p, statsByPlayer.get(p)!);
          }
          const hash = await sha256hex(canonicalStatSnapshot(consumed));
          const res = await db
            .prepare(
              'UPDATE matchups SET home_score = ?, away_score = ?, settled_at = ?, stat_snapshot_hash = ? WHERE id = ? AND settled_at IS NULL',
            )
            .bind(home.total, away.total, settledAt, hash, m.id)
            .run();
          outcome.matchups += res.meta.changes;
        }
        outcome.leagueWeeks.push({ leagueId: league.id, week });

        // Weekly Belt (§3.10): highest score this week holds the belt, from
        // STORED scores — correct even after a stale takeover where a prior
        // owner already settled part of the week. Tie rule (DRIFT 2026-08-30):
        // higher season points-for through the previous week, then teamId.
        const finals = await db
          .prepare(
            'SELECT home_team_id, away_team_id, home_score, away_score FROM matchups WHERE league_id = ? AND week = ?',
          )
          .bind(league.id, week)
          .all<{ home_team_id: string; away_team_id: string; home_score: number; away_score: number }>();
        const scores: { teamId: string; score: number }[] = [];
        for (const m of finals.results) {
          scores.push({ teamId: m.home_team_id, score: m.home_score });
          scores.push({ teamId: m.away_team_id, score: m.away_score });
        }
        scores.sort((a, b) => b.score - a.score || a.teamId.localeCompare(b.teamId));
        let belt = scores[0] ?? null;
        if (belt && scores.length > 1 && scores[1]!.score === belt.score) {
          const tiedIds = scores.filter((s) => s.score === belt!.score).map((s) => s.teamId);
          const pfRows = await db
            .prepare(
              `SELECT team_id, SUM(score) AS pf FROM (
                 SELECT home_team_id AS team_id, home_score AS score FROM matchups
                   WHERE league_id = ? AND settled_at IS NOT NULL AND week < ?
                 UNION ALL
                 SELECT away_team_id, away_score FROM matchups
                   WHERE league_id = ? AND settled_at IS NOT NULL AND week < ?
               ) GROUP BY team_id`,
            )
            .bind(league.id, week, league.id, week)
            .all<{ team_id: string; pf: number | null }>();
          const pf = new Map(pfRows.results.map((r) => [r.team_id, r.pf ?? 0]));
          tiedIds.sort((a, b) => (pf.get(b) ?? 0) - (pf.get(a) ?? 0) || a.localeCompare(b));
          belt = { teamId: tiedIds[0]!, score: belt.score };
        }

        // Events + the latch marker land in ONE transaction: a crash before it
        // leaves settled_at NULL and the stale takeover redoes them cleanly.
        const eventRows = [
          db
            .prepare('INSERT INTO events (league_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
            .bind(
              league.id,
              'week_settled',
              JSON.stringify({ week, matchups: finals.results.length }),
              settledAt,
            ),
        ];
        if (belt) {
          eventRows.push(
            db
              .prepare('INSERT INTO events (league_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
              .bind(
                league.id,
                'belt_won',
                JSON.stringify({ week, team_id: belt.teamId, score: belt.score }),
                settledAt,
              ),
          );
        }
        if (gate.forced) {
          eventRows.push(
            db
              .prepare('INSERT INTO events (league_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
              .bind(league.id, 'settle_forced', JSON.stringify({ week }), settledAt),
          );
        }
        eventRows.push(
          db
            .prepare('UPDATE settlements SET settled_at = ? WHERE league_id = ? AND week = ?')
            .bind(settledAt, league.id, week),
        );
        await db.batch(eventRows);
      }
    } catch (e) {
      // One broken league must never stall settlement for the rest (F-isolation).
      console.error(`settle: league ${league.id} failed:`, e);
      try {
        await db
          .prepare('INSERT INTO events (league_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
          .bind(
            league.id,
            'cron_error',
            JSON.stringify({ phase: 'settle', error: String(e).slice(0, 200) }),
            new Date().toISOString(),
          )
          .run();
      } catch {
        /* the error log must never take down the loop */
      }
    }
  }
  return outcome;
}
