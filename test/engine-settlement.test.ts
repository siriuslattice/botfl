import { describe, expect, it } from 'vitest';
import {
  canonicalStatSnapshot,
  playoffSeeds,
  scoreLineup,
  settleMatchup,
  standings,
  type SettledMatchup,
} from '../src/engine/settlement';
import type { StatLine } from '../src/sport/adapter';
import { nfl } from '../src/sport/nfl';

const lineup = {
  QB: 'nfl:qb1', RB1: 'nfl:rb1', RB2: 'nfl:rb2', WR1: 'nfl:wr1',
  WR2: 'nfl:wr2', TE: 'nfl:te1', FLEX: 'nfl:rb3',
};

describe('scoreLineup', () => {
  it('sums starter points exactly; missing stats and empty slots are 0', () => {
    const stats = new Map<string, StatLine>([
      ['nfl:qb1', { passing_yards: 300, passing_tds: 2, interceptions: 1 }], // 18
      ['nfl:rb1', { rushing_yards: 85, receptions: 3, receiving_yards: 24, rushing_tds: 1 }], // 18.4
      ['nfl:wr1', { receptions: 5, receiving_yards: 77 }], // 10.2
      ['nfl:bench-guy', { rushing_yards: 200 }], // not in lineup, ignored
    ]);
    const res = scoreLineup(nfl, lineup, stats);
    expect(res.total).toBe(46.6);
    expect(res.slots.find((s) => s.slot === 'RB2')?.points).toBe(0); // no stat line
    const empty = scoreLineup(nfl, { ...lineup, TE: null }, stats);
    expect(empty.total).toBe(46.6);
  });
});

describe('settleMatchup', () => {
  it('assigns winner and allows ties', () => {
    expect(settleMatchup('a', 'b', 100.5, 90).result).toBe('home');
    expect(settleMatchup('a', 'b', 90, 100.5).result).toBe('away');
    expect(settleMatchup('a', 'b', 77.77, 77.77).result).toBe('tie');
  });
});

describe('canonicalStatSnapshot', () => {
  it('is invariant to insertion order of players and stat keys', () => {
    const a = new Map<string, StatLine>([
      ['nfl:z', { rushing_yards: 50, receptions: 2 }],
      ['nfl:a', { passing_yards: 300 }],
    ]);
    const b = new Map<string, StatLine>([
      ['nfl:a', { passing_yards: 300 }],
      ['nfl:z', { receptions: 2, rushing_yards: 50 }],
    ]);
    expect(canonicalStatSnapshot(a)).toBe(canonicalStatSnapshot(b));
    expect(canonicalStatSnapshot(a)).toContain('"nfl:a"');
  });
});

describe('standings', () => {
  const m = (h: string, a: string, hs: number, as: number): SettledMatchup =>
    settleMatchup(h, a, hs, as);

  it('orders by win pct, then points-for, then points-against, then teamId', () => {
    const table = standings(
      ['t1', 't2', 't3', 't4'],
      [
        m('t1', 't2', 100, 90), // t1 1-0, t2 0-1
        m('t3', 't4', 120, 80), // t3 1-0, t4 0-1
        m('t1', 't3', 95, 105), // t1 1-1 (195 PF), t3 2-0
        m('t2', 't4', 88, 88),  // both 0-1-1, t2 PF 178, t4 PF 168
      ],
    );
    expect(table.map((r) => r.teamId)).toEqual(['t3', 't1', 't2', 't4']);
    expect(table[0]).toMatchObject({ wins: 2, losses: 0, pointsFor: 225, rank: 1 });
    expect(table[2]).toMatchObject({ teamId: 't2', ties: 1, pointsFor: 178 });
  });

  it('ties count as half a win for pct', () => {
    const table = standings(['a', 'b', 'c'], [m('a', 'b', 50, 50)]);
    const a = table.find((r) => r.teamId === 'a');
    expect(a).toMatchObject({ wins: 0, losses: 0, ties: 1 });
  });

  it('is deterministic when teams are fully level', () => {
    const t1 = standings(['b', 'a'], []);
    const t2 = standings(['a', 'b'], []);
    expect(t1.map((r) => r.teamId)).toEqual(['a', 'b']);
    expect(t2.map((r) => r.teamId)).toEqual(['a', 'b']);
  });

  it('rejects matchups referencing unknown teams', () => {
    expect(() => standings(['a'], [m('a', 'ghost', 1, 0)])).toThrow(/unknown team/);
  });

  it('playoffSeeds takes the top 4', () => {
    const table = standings(
      ['t1', 't2', 't3', 't4', 't5'],
      [m('t1', 't5', 100, 50), m('t2', 't5', 100, 50), m('t3', 't5', 90, 50), m('t4', 't5', 80, 50)],
    );
    expect(playoffSeeds(table)).toHaveLength(4);
    expect(playoffSeeds(table)).not.toContain('t5');
  });
});
