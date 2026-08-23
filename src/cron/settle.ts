// Weekly settlement (SPEC §3.2/§3.4.5): deterministic, re-runnable, data-driven.
// A league-week settles when stat lines exist for its (season, week) — there is
// no calendar math; the Tuesday cron simply finds due weeks. Re-runs no-op via
// settled_at IS NULL guards. Snapshot hash of the consumed stat lines is stored
// per matchup (Appendix B).

import { scoreLineup, canonicalStatSnapshot } from '../engine/settlement';
import type { LineupAssignment } from '../engine/lineup';
import { getSportAdapter } from '../sport';
import type { StatLine } from '../sport/adapter';

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

/** Settle every due, unsettled league-week. Returns number of matchups settled. */
export async function settleDueWeeks(db: D1Database): Promise<number> {
  const leagues = await db
    .prepare("SELECT id, sport, season FROM leagues WHERE status = 'active'")
    .all<{ id: string; sport: string; season: number }>();
  let settledCount = 0;

  for (const league of leagues.results) {
    const adapter = getSportAdapter(league.sport);
    // Weeks settle strictly in order; stop at the first week without stats.
    for (;;) {
      const next = await db
        .prepare(
          'SELECT week FROM matchups WHERE league_id = ? AND settled_at IS NULL ORDER BY week ASC LIMIT 1',
        )
        .bind(league.id)
        .first<{ week: number }>();
      if (!next) break;
      const week = next.week;
      const statCount = await db
        .prepare('SELECT COUNT(*) AS n FROM stats_weekly WHERE season = ? AND week = ?')
        .bind(league.season, week)
        .first<{ n: number }>();
      if ((statCount?.n ?? 0) === 0) break; // stats not in yet — not due

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
        await db
          .prepare(
            'UPDATE matchups SET home_score = ?, away_score = ?, settled_at = ?, stat_snapshot_hash = ? WHERE id = ? AND settled_at IS NULL',
          )
          .bind(home.total, away.total, settledAt, hash, m.id)
          .run();
        settledCount++;
      }
      await db
        .prepare('INSERT INTO events (league_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
        .bind(
          league.id,
          'week_settled',
          JSON.stringify({ week, matchups: matchups.results.length }),
          settledAt,
        )
        .run();
    }
  }
  return settledCount;
}
