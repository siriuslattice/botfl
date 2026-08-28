import { describe, expect, it } from 'vitest';
import {
  assignDraftSlots,
  computeStartWeek,
  finalPairs,
  regularSeasonSchedule,
  semifinalPairs,
} from '../src/engine/schedule';

const teams = Array.from({ length: 10 }, (_, i) => `t${i + 1}`);

describe('regularSeasonSchedule', () => {
  const sched = regularSeasonSchedule(teams);

  it('produces 14 weeks × 5 matchups', () => {
    expect(sched).toHaveLength(70);
    for (let w = 1; w <= 14; w++) {
      expect(sched.filter((m) => m.week === w)).toHaveLength(5);
    }
  });

  it('every team plays exactly once per week', () => {
    for (let w = 1; w <= 14; w++) {
      const seen = sched.filter((m) => m.week === w).flatMap((m) => [m.home, m.away]);
      expect([...seen].sort()).toEqual([...teams].sort());
    }
  });

  it('weeks 1–9 form a full round robin (each pair exactly once)', () => {
    const pairs = new Set(
      sched
        .filter((m) => m.week <= 9)
        .map((m) => [m.home, m.away].sort().join('|')),
    );
    expect(pairs.size).toBe(45); // C(10,2)
  });

  it('weeks 10–14 repeat rounds 1–5 with home/away flipped', () => {
    for (let w = 10; w <= 14; w++) {
      const early = sched.filter((m) => m.week === w - 9);
      const late = sched.filter((m) => m.week === w);
      for (const m of late) {
        expect(early).toContainEqual({ week: w - 9, home: m.away, away: m.home });
      }
    }
  });

  it('is deterministic and rejects odd team counts', () => {
    expect(regularSeasonSchedule(teams)).toEqual(sched);
    expect(() => regularSeasonSchedule(['a', 'b', 'c'])).toThrow(/even/);
  });
});

describe('regularSeasonSchedule with startWeek (rest-of-season entry)', () => {
  const slate = regularSeasonSchedule(teams, 14, 5);

  it('labels weeks 5..14 only, 5 games each, everyone plays weekly', () => {
    expect(slate).toHaveLength(50);
    expect(slate.some((m) => m.week < 5)).toBe(false);
    for (let w = 5; w <= 14; w++) {
      const wk = slate.filter((m) => m.week === w);
      expect(wk).toHaveLength(5);
      expect(wk.flatMap((m) => [m.home, m.away]).sort()).toEqual([...teams].sort());
    }
  });

  it('no pair meets more than twice in any rest-of-season span', () => {
    const counts = new Map<string, number>();
    for (const m of slate) {
      const k = [m.home, m.away].sort().join('|');
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
  });

  it('startWeek 1 is the exact default slate; out-of-range throws', () => {
    expect(regularSeasonSchedule(teams, 14, 1)).toEqual(regularSeasonSchedule(teams));
    expect(() => regularSeasonSchedule(teams, 14, 0)).toThrow(/startWeek/);
    expect(() => regularSeasonSchedule(teams, 14, 15)).toThrow(/startWeek/);
  });
});

describe('computeStartWeek', () => {
  const wk = (week: number, firstKickoffMs: number) => ({ week, firstKickoffMs });

  it('before any kickoff → week 1', () => {
    expect(computeStartWeek([wk(1, 100), wk(2, 200)], 50)).toBe(1);
  });
  it('week 1 underway (kickoff not strictly future) → week 2', () => {
    expect(computeStartWeek([wk(1, 100), wk(2, 200)], 100)).toBe(2);
    expect(computeStartWeek([wk(1, 100), wk(2, 200)], 150)).toBe(2);
  });
  it('every regular-season week started → null', () => {
    expect(computeStartWeek([wk(1, 100), wk(2, 200)], 999)).toBeNull();
  });
  it('ignores playoff weeks and handles empty input', () => {
    expect(computeStartWeek([wk(15, 999), wk(17, 999)], 0)).toBeNull();
    expect(computeStartWeek([], 0)).toBeNull();
  });
});

describe('assignDraftSlots', () => {
  const agents = Array.from({ length: 10 }, (_, i) => `agent${i + 1}`);

  it('permutes all agents exactly once, deterministically per league', () => {
    const a = assignDraftSlots('league-1', agents);
    const b = assignDraftSlots('league-1', [...agents].reverse());
    expect([...a].sort()).toEqual([...agents].sort());
    expect(a).toEqual(b); // join order does not matter
  });

  it('different leagues get different orders (seeded by league id)', () => {
    const a = assignDraftSlots('league-1', agents);
    const c = assignDraftSlots('league-2', agents);
    expect(a).not.toEqual(c);
  });
});

describe('playoff pairs', () => {
  it('semis: 1v4 and 2v3 in week 15, better seed home', () => {
    expect(semifinalPairs(['s1', 's2', 's3', 's4'])).toEqual([
      { week: 15, home: 's1', away: 's4', stage: 'semi' },
      { week: 15, home: 's2', away: 's3', stage: 'semi' },
    ]);
    expect(() => semifinalPairs(['a', 'b'])).toThrow(/4 seeds/);
  });

  it('weeks 16–17: final + third-place pairings', () => {
    const w16 = finalPairs(['w1', 'w2'], ['l1', 'l2'], 16);
    expect(w16.map((p) => p.stage)).toEqual(['final', 'third']);
    expect(finalPairs(['w1', 'w2'], ['l1', 'l2'], 17)[0]?.week).toBe(17);
    expect(() => finalPairs(['w1'], ['l1', 'l2'], 16)).toThrow(/exactly 2/);
  });
});
