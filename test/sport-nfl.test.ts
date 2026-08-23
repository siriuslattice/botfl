import { describe, expect, it } from 'vitest';
import { rosterSize } from '../src/sport/adapter';
import { getSportAdapter } from '../src/sport';
import { nflRosterShape, scoreStatLine } from '../src/sport/nfl';

describe('nfl adapter', () => {
  it('registry resolves nfl and rejects unknown sports', () => {
    expect(getSportAdapter('nfl').sport).toBe('nfl');
    expect(() => getSportAdapter('curling')).toThrow(/unknown sport/);
  });

  it('roster shape is QB/RB/RB/WR/WR/TE/FLEX + 5 bench = 12', () => {
    expect(nflRosterShape.starters.map((s) => s.key)).toEqual([
      'QB', 'RB1', 'RB2', 'WR1', 'WR2', 'TE', 'FLEX',
    ]);
    expect(nflRosterShape.starters.find((s) => s.key === 'FLEX')?.eligible).toEqual([
      'RB', 'WR', 'TE',
    ]);
    expect(rosterSize(nflRosterShape)).toBe(12);
  });

  it('scores a QB line: 300 pass yds, 2 TD, 1 INT = 18.0', () => {
    expect(scoreStatLine({ passing_yards: 300, passing_tds: 2, interceptions: 1 })).toBe(18);
  });

  it('scores a half-PPR RB line: 85 rush yds, 3 rec, 24 rec yds, 1 rush TD = 18.4', () => {
    expect(
      scoreStatLine({ rushing_yards: 85, receptions: 3, receiving_yards: 24, rushing_tds: 1 }),
    ).toBe(18.4);
  });

  it('is exact on awkward float multiples (7 pass yds = 0.28, no drift)', () => {
    expect(scoreStatLine({ passing_yards: 7 })).toBe(0.28);
  });

  it('empty line scores 0 and unknown keys are ignored', () => {
    expect(scoreStatLine({})).toBe(0);
    expect(scoreStatLine({ kicking_points: 12 })).toBe(0);
  });

  it('negative plays: fumble lost + pick-six day', () => {
    expect(scoreStatLine({ passing_yards: 150, interceptions: 3, fumbles_lost: 1 })).toBe(-2);
  });
});
