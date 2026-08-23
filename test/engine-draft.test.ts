import { describe, expect, it } from 'vitest';
import {
  autopick,
  draftConfig,
  draftHardEndsAt,
  isDraftComplete,
  nextPick,
  pickDeadline,
  roundForPick,
  starterDeficit,
  teamSlotForPick,
  totalPicks,
  type AdpEntry,
} from '../src/engine/draft';
import { nflRosterShape } from '../src/sport/nfl';

const cfg = draftConfig(10, nflRosterShape);
const HOUR = 60 * 60 * 1000;

describe('snake math', () => {
  it('120 total picks for 10 teams × 12 rounds', () => {
    expect(totalPicks(cfg)).toBe(120);
  });

  it('snakes at round boundaries: 1..10, then 10..1', () => {
    expect(teamSlotForPick(cfg, 1)).toBe(1);
    expect(teamSlotForPick(cfg, 10)).toBe(10);
    expect(teamSlotForPick(cfg, 11)).toBe(10); // back-to-back for slot 10
    expect(teamSlotForPick(cfg, 20)).toBe(1);  // back-to-back for slot 1
    expect(teamSlotForPick(cfg, 21)).toBe(1);
    expect(teamSlotForPick(cfg, 120)).toBe(1); // round 12 is even → ends at slot 1
  });

  it('maps overall pick to round', () => {
    expect(roundForPick(cfg, 1)).toBe(1);
    expect(roundForPick(cfg, 10)).toBe(1);
    expect(roundForPick(cfg, 11)).toBe(2);
    expect(roundForPick(cfg, 120)).toBe(12);
  });

  it('every team gets exactly 12 picks', () => {
    const perSlot = new Map<number, number>();
    for (let p = 1; p <= totalPicks(cfg); p++) {
      const s = teamSlotForPick(cfg, p);
      perSlot.set(s, (perSlot.get(s) ?? 0) + 1);
    }
    for (let s = 1; s <= 10; s++) expect(perSlot.get(s)).toBe(12);
  });

  it('nextPick walks the board and completes', () => {
    expect(nextPick(cfg, 0)).toEqual({ overall: 1, round: 1, teamSlot: 1 });
    expect(nextPick(cfg, 10)).toEqual({ overall: 11, round: 2, teamSlot: 10 });
    expect(nextPick(cfg, 120)).toBeNull();
    expect(isDraftComplete(cfg, 119)).toBe(false);
    expect(isDraftComplete(cfg, 120)).toBe(true);
  });
});

describe('pick clock', () => {
  const open = 1_000_000;

  it('first pick deadline is open + 4h', () => {
    expect(pickDeadline(cfg, open, null)).toBe(open + 4 * HOUR);
  });

  it('subsequent deadlines run from the previous pick', () => {
    expect(pickDeadline(cfg, open, open + HOUR)).toBe(open + HOUR + 4 * HOUR);
  });

  it('a pick made before open still clocks from open', () => {
    expect(pickDeadline(cfg, open, open - HOUR)).toBe(open + 4 * HOUR);
  });

  it('deadlines are capped by the 72h hard end', () => {
    const late = open + 71 * HOUR;
    expect(pickDeadline(cfg, open, late)).toBe(draftHardEndsAt(cfg, open));
    expect(draftHardEndsAt(cfg, open)).toBe(open + 72 * HOUR);
  });
});

describe('autopick', () => {
  const board: AdpEntry[] = [
    { playerId: 'nfl:rb1', position: 'RB', adp: 1 },
    { playerId: 'nfl:rb2', position: 'RB', adp: 2 },
    { playerId: 'nfl:wr1', position: 'WR', adp: 3 },
    { playerId: 'nfl:qb1', position: 'QB', adp: 4 },
    { playerId: 'nfl:te1', position: 'TE', adp: 5 },
    { playerId: 'nfl:wr2', position: 'WR', adp: 6 },
  ];

  it('takes best available by ADP', () => {
    expect(autopick(board, new Set(), [], nflRosterShape)?.playerId).toBe('nfl:rb1');
  });

  it('skips taken players', () => {
    expect(autopick(board, new Set(['nfl:rb1']), [], nflRosterShape)?.playerId).toBe('nfl:rb2');
  });

  it('starterDeficit counts unfillable slots incl. FLEX leftovers', () => {
    expect(starterDeficit(nflRosterShape, [])).toBe(7);
    expect(starterDeficit(nflRosterShape, ['QB', 'RB', 'RB', 'WR', 'WR', 'TE'])).toBe(1); // FLEX open
    expect(starterDeficit(nflRosterShape, ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'RB'])).toBe(0);
    expect(starterDeficit(nflRosterShape, ['RB', 'RB', 'RB', 'RB'])).toBe(4); // QB, WRx2, TE open
  });

  it('forces a needed position when remaining picks equal the deficit', () => {
    // 10 players, no QB or TE yet → 2 picks left, deficit 2: must not take the RB.
    const myPositions = ['RB', 'RB', 'RB', 'WR', 'WR', 'WR', 'RB', 'WR', 'RB', 'RB'];
    const pick = autopick(board, new Set(['nfl:rb1']), myPositions, nflRosterShape);
    expect(['nfl:qb1', 'nfl:te1']).toContain(pick?.playerId);
  });

  it('returns null on an exhausted board', () => {
    const taken = new Set(board.map((b) => b.playerId));
    expect(autopick(board, taken, [], nflRosterShape)).toBeNull();
  });

  it('breaks ADP ties deterministically by playerId', () => {
    const tied: AdpEntry[] = [
      { playerId: 'nfl:zz', position: 'RB', adp: 1 },
      { playerId: 'nfl:aa', position: 'RB', adp: 1 },
    ];
    expect(autopick(tied, new Set(), [], nflRosterShape)?.playerId).toBe('nfl:aa');
  });
});
