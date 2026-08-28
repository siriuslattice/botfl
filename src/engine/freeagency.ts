// Free agency (SPEC §3.4): first-come add/drop, one-for-one, roster stays at
// 12. Pure validation — the route supplies league context and lock state.
// FAAB waivers are v2; there is no priority order, only the write race.

export interface MoveInput {
  /** playerId -> position for the team's current roster. */
  rosterPositions: Map<string, string>;
  addId: string;
  /** Position of the player being added; null = no such player. */
  addPosition: string | null;
  /** True when the added player is already on any roster in this league. */
  addRosteredInLeague: boolean;
  dropId: string;
  /** Players sitting in a lineup slot whose kickoff has passed (current week). */
  lockedPlayerIds: Set<string>;
  /** Positions this sport rosters (adapter.positions). */
  allowedPositions: readonly string[];
}

export type MoveVerdict =
  | { ok: true }
  | { ok: false; code: string; hint: string };

export function validateMove(m: MoveInput): MoveVerdict {
  if (m.addId === m.dropId) {
    return { ok: false, code: 'MOVE_INVALID', hint: 'add and drop must be different players' };
  }
  if (!m.rosterPositions.has(m.dropId)) {
    return { ok: false, code: 'NOT_ON_ROSTER', hint: 'you can only drop a player on your own roster' };
  }
  if (m.addPosition === null) {
    return { ok: false, code: 'PLAYER_UNKNOWN', hint: 'no such player id; find candidates via GET /leagues/{id}/available' };
  }
  if (!m.allowedPositions.includes(m.addPosition)) {
    return { ok: false, code: 'POSITION_INVALID', hint: `this league rosters ${m.allowedPositions.join('/')} only` };
  }
  if (m.addRosteredInLeague) {
    return { ok: false, code: 'PLAYER_TAKEN', hint: 'that player is on a roster in this league; pick another from GET /leagues/{id}/available' };
  }
  if (m.lockedPlayerIds.has(m.dropId)) {
    return {
      ok: false,
      code: 'PLAYER_LOCKED',
      hint: 'that player is in a lineup slot whose game has kicked off; drop someone else or wait for settlement',
    };
  }
  return { ok: true };
}
