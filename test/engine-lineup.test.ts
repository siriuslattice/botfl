import { describe, expect, it } from 'vitest';
import { evaluateLineup, type LineupAssignment } from '../src/engine/lineup';
import { nflRosterShape } from '../src/sport/nfl';

const roster = new Map<string, string>([
  ['nfl:qb1', 'QB'],
  ['nfl:rb1', 'RB'],
  ['nfl:rb2', 'RB'],
  ['nfl:rb3', 'RB'],
  ['nfl:rb4', 'RB'],
  ['nfl:wr1', 'WR'],
  ['nfl:wr2', 'WR'],
  ['nfl:wr3', 'WR'],
  ['nfl:te1', 'TE'],
]);

const fullLineup: LineupAssignment = {
  QB: 'nfl:qb1', RB1: 'nfl:rb1', RB2: 'nfl:rb2', WR1: 'nfl:wr1',
  WR2: 'nfl:wr2', TE: 'nfl:te1', FLEX: 'nfl:rb3',
};

const NOW = 1_000_000_000;
const noKickoffs = new Map<string, number>();

function evaluate(overrides: Partial<Parameters<typeof evaluateLineup>[0]>) {
  return evaluateLineup({
    shape: nflRosterShape,
    rosterPositions: roster,
    current: {},
    proposed: fullLineup,
    kickoffs: noKickoffs,
    nowMs: NOW,
    ...overrides,
  });
}

describe('lineup validation', () => {
  it('accepts a valid full lineup', () => {
    const res = evaluate({});
    expect(res).toMatchObject({ ok: true, lineup: fullLineup });
    if (res.ok) expect(res.changed.sort()).toEqual(Object.keys(fullLineup).sort());
  });

  it('partial submission merges over current', () => {
    const res = evaluate({ current: fullLineup, proposed: { FLEX: 'nfl:wr3' } });
    expect(res).toMatchObject({ ok: true, changed: ['FLEX'] });
    if (res.ok) expect(res.lineup).toEqual({ ...fullLineup, FLEX: 'nfl:wr3' });
  });

  it('rejects unknown slots with the valid slot list', () => {
    const res = evaluate({ proposed: { K: 'nfl:qb1' } });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) {
      expect(res.errors[0]?.code).toBe('UNKNOWN_SLOT');
      expect(res.errors[0]?.hint).toContain('FLEX');
    }
  });

  it('rejects players not on the roster', () => {
    const res = evaluate({ proposed: { ...fullLineup, QB: 'nfl:qb99' } });
    if (!res.ok) expect(res.errors.map((e) => e.code)).toContain('NOT_ON_ROSTER');
    expect(res.ok).toBe(false);
  });

  it('rejects a QB in the FLEX', () => {
    const res = evaluate({ proposed: { ...fullLineup, FLEX: 'nfl:qb1' } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const err = res.errors.find((e) => e.code === 'INELIGIBLE_POSITION');
      expect(err?.slot).toBe('FLEX');
      expect(err?.hint).toContain('RB/WR/TE');
    }
  });

  it('rejects the same player in two slots', () => {
    const res = evaluate({ proposed: { ...fullLineup, FLEX: 'nfl:rb1' } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.map((e) => e.code)).toContain('DUPLICATE_PLAYER');
  });

  it('allows explicitly empty slots and atomically rejects on any error', () => {
    const ok = evaluate({ proposed: { ...fullLineup, TE: null } });
    expect(ok).toMatchObject({ ok: true });
    const bad = evaluate({ proposed: { ...fullLineup, TE: null, FLEX: 'nfl:qb1' } });
    expect(bad.ok).toBe(false);
  });
});

describe('per-player kickoff locks', () => {
  const kickoffs = new Map<string, number>([
    ['nfl:rb1', NOW - 1000],  // already kicked off
    ['nfl:wr3', NOW - 1000],  // already kicked off (on bench)
    ['nfl:qb1', NOW + 1000],  // later today
  ]);

  it('freezes a slot whose player kicked off', () => {
    const res = evaluate({ current: fullLineup, proposed: { RB1: 'nfl:rb4' }, kickoffs });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]).toMatchObject({ slot: 'RB1', code: 'SLOT_LOCKED' });
  });

  it('blocks inserting a player who already kicked off (start-after-the-fact exploit)', () => {
    const res = evaluate({ current: fullLineup, proposed: { WR1: 'nfl:wr3' }, kickoffs });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]).toMatchObject({ slot: 'WR1', code: 'PLAYER_LOCKED' });
  });

  it('keeping a kicked-off player in place is not a change and passes', () => {
    const res = evaluate({ current: fullLineup, proposed: { ...fullLineup }, kickoffs });
    expect(res).toMatchObject({ ok: true, changed: [] });
  });

  it('unlocked players still swap freely while others are locked', () => {
    const res = evaluate({ current: fullLineup, proposed: { WR2: 'nfl:wr3' }, kickoffs: new Map([['nfl:rb1', NOW - 1000]]) });
    expect(res).toMatchObject({ ok: true, changed: ['WR2'] });
  });

  it('bye-week players (no kickoff) never lock', () => {
    const res = evaluate({ current: fullLineup, proposed: { FLEX: 'nfl:wr3' }, kickoffs: new Map() });
    expect(res).toMatchObject({ ok: true });
  });

  it('filling a previously empty slot with an unlocked player mid-week is fine', () => {
    const current = { ...fullLineup, TE: null };
    const res = evaluate({ current, proposed: { TE: 'nfl:te1' }, kickoffs });
    expect(res).toMatchObject({ ok: true, changed: ['TE'] });
  });
});
