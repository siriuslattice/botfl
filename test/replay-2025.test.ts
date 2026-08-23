// The 2025 replay test (SPEC Appendix B): full synthetic season through the
// pure engine — draft → weekly lineups → 14 settled weeks → standings — with
// exact-total assertions. Must pass before any deploy, forever.

import { describe, expect, it } from 'vitest';
import adpJson from '../fixtures/replay-2025/adp.json';
import playersJson from '../fixtures/replay-2025/players.json';
import scheduleJson from '../fixtures/replay-2025/schedule.json';
import statsJson from '../fixtures/replay-2025/stats.json';
import {
  autopick,
  draftConfig,
  starterDeficit,
  teamSlotForPick,
  totalPicks,
  type AdpEntry,
} from '../src/engine/draft';
import { evaluateLineup, type LineupAssignment } from '../src/engine/lineup';
import {
  canonicalStatSnapshot,
  playoffSeeds,
  scoreLineup,
  settleMatchup,
  standings,
  type SettledMatchup,
} from '../src/engine/settlement';
import { assignDraftSlots, regularSeasonSchedule } from '../src/engine/schedule';
import type { StatLine } from '../src/sport/adapter';
import { nfl, nflRosterShape } from '../src/sport/nfl';

const board = adpJson as AdpEntry[];
const players = playersJson as { id: string; position: string; team: string }[];
const games = scheduleJson as { week: number; home: string; away: string }[];
const statsByWeek = statsJson as Record<string, Record<string, StatLine>>;

const posOf = new Map(players.map((p) => [p.id, p.position]));
const clubOf = new Map(players.map((p) => [p.id, p.team]));
const adpRank = new Map(board.map((e) => [e.playerId, e.adp]));

const clubsPlaying = new Map<number, Set<string>>();
for (const g of games) {
  if (!clubsPlaying.has(g.week)) clubsPlaying.set(g.week, new Set());
  clubsPlaying.get(g.week)!.add(g.home);
  clubsPlaying.get(g.week)!.add(g.away);
}

function runSeason() {
  const agents = Array.from({ length: 10 }, (_, i) => `agent-${String(i + 1).padStart(2, '0')}`);
  const teamIds = assignDraftSlots('replay-2025-league', agents);
  const cfg = draftConfig(10, nflRosterShape);

  // Draft: every pick via autopick (deterministic).
  const taken = new Set<string>();
  const rosters = new Map<string, string[]>(teamIds.map((t) => [t, []]));
  for (let pickNo = 1; pickNo <= totalPicks(cfg); pickNo++) {
    const teamId = teamIds[teamSlotForPick(cfg, pickNo) - 1]!;
    const mine = rosters.get(teamId)!;
    const entry = autopick(board, taken, mine.map((id) => posOf.get(id)!), nflRosterShape);
    if (!entry) throw new Error('board exhausted mid-draft');
    taken.add(entry.playerId);
    mine.push(entry.playerId);
  }

  // Weekly: set best-ADP valid lineup (prefers players whose club plays), score, settle.
  const schedule = regularSeasonSchedule(teamIds);
  const settled: SettledMatchup[] = [];
  const weeklyTotals: number[] = [];
  for (let week = 1; week <= 14; week++) {
    const weekStats = new Map(Object.entries(statsByWeek[String(week)] ?? {}));
    const active = clubsPlaying.get(week) ?? new Set<string>();
    const lineups = new Map<string, LineupAssignment>();
    for (const teamId of teamIds) {
      const roster = rosters.get(teamId)!;
      const used = new Set<string>();
      const lineup: LineupAssignment = {};
      for (const slotDef of nflRosterShape.starters) {
        const candidates = roster
          .filter((id) => !used.has(id) && slotDef.eligible.includes(posOf.get(id)!))
          .sort((a, b) => adpRank.get(a)! - adpRank.get(b)!);
        const playing = candidates.find((id) => active.has(clubOf.get(id)!));
        const chosen = playing ?? candidates[0] ?? null;
        if (chosen) used.add(chosen);
        lineup[slotDef.key] = chosen;
      }
      const res = evaluateLineup({
        shape: nflRosterShape,
        rosterPositions: new Map(roster.map((id) => [id, posOf.get(id)!])),
        current: {},
        proposed: lineup,
        kickoffs: new Map(),
        nowMs: 0,
      });
      if (!res.ok) throw new Error(`invalid replay lineup: ${JSON.stringify(res.errors)}`);
      lineups.set(teamId, res.lineup);
    }
    let weekCenti = 0;
    for (const m of schedule.filter((s) => s.week === week)) {
      const home = scoreLineup(nfl, lineups.get(m.home)!, weekStats);
      const away = scoreLineup(nfl, lineups.get(m.away)!, weekStats);
      weekCenti += Math.round(home.total * 100) + Math.round(away.total * 100);
      settled.push(settleMatchup(m.home, m.away, home.total, away.total));
    }
    weeklyTotals.push(weekCenti / 100);
  }
  const table = standings(teamIds, settled);
  return { teamIds, rosters, settled, table, weeklyTotals };
}

describe('2025 season replay', () => {
  const season = runSeason();

  it('drafts 120 unique players into 10 startable rosters', () => {
    const all = [...season.rosters.values()].flat();
    expect(all).toHaveLength(120);
    expect(new Set(all).size).toBe(120);
    for (const roster of season.rosters.values()) {
      expect(roster).toHaveLength(12);
      expect(starterDeficit(nflRosterShape, roster.map((id) => posOf.get(id)!))).toBe(0);
    }
  });

  it('settles 70 matchups; every team plays 14 games', () => {
    expect(season.settled).toHaveLength(70);
    for (const row of season.table) {
      expect(row.wins + row.losses + row.ties).toBe(14);
    }
  });

  it('points-for across the table equals the sum of all matchup scores exactly', () => {
    const tableCenti = season.table.reduce((s, r) => s + Math.round(r.pointsFor * 100), 0);
    const matchCenti = season.settled.reduce(
      (s, m) => s + Math.round(m.homeScore * 100) + Math.round(m.awayScore * 100),
      0,
    );
    expect(tableCenti).toBe(matchCenti);
    expect(tableCenti / 100).toBe(season.weeklyTotals.reduce((s, w) => s + Math.round(w * 100), 0) / 100);
  });

  it('is fully deterministic end-to-end', () => {
    const again = runSeason();
    expect(again.table).toEqual(season.table);
    expect(again.settled).toEqual(season.settled);
  });

  it('canonical stat snapshot for week 1 is stable', () => {
    const snap = canonicalStatSnapshot(new Map(Object.entries(statsByWeek['1'] ?? {})));
    const again = canonicalStatSnapshot(new Map(Object.entries(statsByWeek['1'] ?? {}).reverse()));
    expect(snap).toBe(again);
  });

  // GOLDEN section — filled from the first verified run; any diff is a
  // scoring/draft/schedule regression.
  it('matches golden final standings exactly', () => {
    expect(season.table.map((r) => r.teamId)).toEqual([
      'agent-08', 'agent-02', 'agent-03', 'agent-05', 'agent-06',
      'agent-01', 'agent-10', 'agent-04', 'agent-07', 'agent-09',
    ]);
    expect(season.table[0]).toEqual({
      teamId: 'agent-08', wins: 9, losses: 5, ties: 0,
      pointsFor: 1498.42, pointsAgainst: 1335.66, rank: 1,
    });
    expect(season.table.reduce((s, r) => s + Math.round(r.pointsFor * 100), 0) / 100)
      .toBe(14407.2);
    expect(playoffSeeds(season.table)).toEqual([
      'agent-08', 'agent-02', 'agent-03', 'agent-05',
    ]);
  });
});
