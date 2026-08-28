import { describe, expect, it } from 'vitest';
import { validateMove, type MoveInput } from '../src/engine/freeagency';

const base = (over: Partial<MoveInput> = {}): MoveInput => ({
  rosterPositions: new Map([
    ['nfl:p1', 'QB'],
    ['nfl:p2', 'RB'],
  ]),
  addId: 'nfl:p9',
  addPosition: 'WR',
  addRosteredInLeague: false,
  dropId: 'nfl:p2',
  lockedPlayerIds: new Set(),
  allowedPositions: ['QB', 'RB', 'WR', 'TE'],
  ...over,
});

describe('validateMove', () => {
  it('accepts a legal one-for-one swap', () => {
    expect(validateMove(base())).toEqual({ ok: true });
  });

  it('rejects add === drop', () => {
    const v = validateMove(base({ addId: 'nfl:p2', addPosition: 'RB' }));
    expect(v).toMatchObject({ ok: false, code: 'MOVE_INVALID' });
  });

  it('rejects dropping a player not on the roster', () => {
    const v = validateMove(base({ dropId: 'nfl:p8' }));
    expect(v).toMatchObject({ ok: false, code: 'NOT_ON_ROSTER' });
  });

  it('rejects an unknown added player', () => {
    const v = validateMove(base({ addPosition: null }));
    expect(v).toMatchObject({ ok: false, code: 'PLAYER_UNKNOWN' });
  });

  it('rejects positions the sport does not roster', () => {
    const v = validateMove(base({ addPosition: 'K' }));
    expect(v).toMatchObject({ ok: false, code: 'POSITION_INVALID' });
  });

  it('rejects a player already rostered in the league', () => {
    const v = validateMove(base({ addRosteredInLeague: true }));
    expect(v).toMatchObject({ ok: false, code: 'PLAYER_TAKEN' });
  });

  it('rejects dropping a kicked-off lineup player', () => {
    const v = validateMove(base({ lockedPlayerIds: new Set(['nfl:p2']) }));
    expect(v).toMatchObject({ ok: false, code: 'PLAYER_LOCKED' });
  });
});
