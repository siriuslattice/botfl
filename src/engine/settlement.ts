// Settlement engine — pure functions only, no I/O (SPEC Appendix B).
// Deterministic and re-runnable: same lineups + same stat lines → same scores,
// same canonical snapshot string (hashed at the I/O layer into matchups).

import type { SportAdapter, StatLine } from '../sport/adapter';
import type { LineupAssignment } from './lineup';

export interface SlotScore {
  slot: string;
  playerId: string | null;
  points: number;
}

export interface LineupScore {
  total: number;
  slots: SlotScore[];
}

/** Score one team-week. Empty slots and missing stat lines score 0. */
export function scoreLineup(
  adapter: SportAdapter,
  lineup: Readonly<LineupAssignment>,
  statsByPlayer: ReadonlyMap<string, StatLine>,
): LineupScore {
  const slots: SlotScore[] = [];
  let totalCenti = 0;
  for (const slotDef of adapter.rosterShape.starters) {
    const playerId = lineup[slotDef.key] ?? null;
    const stat = playerId === null ? undefined : statsByPlayer.get(playerId);
    const points = stat === undefined ? 0 : adapter.scoreStatLine(stat);
    totalCenti += Math.round(points * 100);
    slots.push({ slot: slotDef.key, playerId, points });
  }
  return { total: totalCenti / 100, slots };
}

export interface SettledMatchup {
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  result: 'home' | 'away' | 'tie';
}

export function settleMatchup(
  homeTeamId: string,
  awayTeamId: string,
  homeScore: number,
  awayScore: number,
): SettledMatchup {
  const result = homeScore > awayScore ? 'home' : homeScore < awayScore ? 'away' : 'tie';
  return { homeTeamId, awayTeamId, homeScore, awayScore, result };
}

/**
 * Canonical snapshot of the stat lines a settlement consumed: players sorted,
 * stat keys sorted, JSON without whitespace. Hash this at the I/O layer and
 * store it in matchups.stat_snapshot_hash.
 */
export function canonicalStatSnapshot(statsByPlayer: ReadonlyMap<string, StatLine>): string {
  const players = [...statsByPlayer.keys()].sort();
  const parts = players.map((playerId) => {
    const stat = statsByPlayer.get(playerId)!;
    const keys = Object.keys(stat).sort();
    const entries = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(stat[k])}`);
    return `${JSON.stringify(playerId)}:{${entries.join(',')}}`;
  });
  return `{${parts.join(',')}}`;
}

export interface StandingsRow {
  teamId: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  rank: number;
}

/**
 * Standings over settled matchups. Order: win pct desc → points-for desc →
 * points-against asc → teamId asc (final tiebreak keeps ordering total and
 * deterministic; no H2H in v1).
 */
export function standings(
  teamIds: readonly string[],
  settled: readonly SettledMatchup[],
): StandingsRow[] {
  const rows = new Map<string, StandingsRow>();
  for (const teamId of teamIds) {
    rows.set(teamId, { teamId, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, rank: 0 });
  }
  for (const m of settled) {
    const home = rows.get(m.homeTeamId);
    const away = rows.get(m.awayTeamId);
    if (!home || !away) throw new Error(`matchup references unknown team: ${m.homeTeamId} vs ${m.awayTeamId}`);
    home.pointsFor = round2(home.pointsFor + m.homeScore);
    home.pointsAgainst = round2(home.pointsAgainst + m.awayScore);
    away.pointsFor = round2(away.pointsFor + m.awayScore);
    away.pointsAgainst = round2(away.pointsAgainst + m.homeScore);
    if (m.result === 'tie') {
      home.ties++;
      away.ties++;
    } else if (m.result === 'home') {
      home.wins++;
      away.losses++;
    } else {
      away.wins++;
      home.losses++;
    }
  }
  const ordered = [...rows.values()].sort((a, b) => {
    const pctDiff = winPct(b) - winPct(a);
    if (pctDiff !== 0) return pctDiff;
    if (b.pointsFor !== a.pointsFor) return b.pointsFor - a.pointsFor;
    if (a.pointsAgainst !== b.pointsAgainst) return a.pointsAgainst - b.pointsAgainst;
    return a.teamId.localeCompare(b.teamId);
  });
  ordered.forEach((row, i) => {
    row.rank = i + 1;
  });
  return ordered;
}

export function playoffSeeds(table: readonly StandingsRow[], spots = 4): string[] {
  return table.slice(0, spots).map((r) => r.teamId);
}

function winPct(r: StandingsRow): number {
  const games = r.wins + r.losses + r.ties;
  return games === 0 ? 0 : (r.wins + r.ties / 2) / games;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
