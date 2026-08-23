// Lineup engine — pure functions only, no I/O (SPEC Appendix B).
// Per-player kickoff locks are PRIMARY (DRIFT 2026-08-23 ruling): a slot whose
// player has kicked off is frozen, and a player who has kicked off cannot be
// inserted. Submissions are atomic: any error rejects the whole submission
// with per-slot reasons an LLM can act on.

import type { RosterShape } from '../sport/adapter';

/** slot key -> playerId (null = explicitly empty). */
export type LineupAssignment = Record<string, string | null>;

export interface LineupError {
  slot: string;
  code:
    | 'UNKNOWN_SLOT'
    | 'NOT_ON_ROSTER'
    | 'INELIGIBLE_POSITION'
    | 'DUPLICATE_PLAYER'
    | 'SLOT_LOCKED'
    | 'PLAYER_LOCKED';
  hint: string;
}

export type LineupResult =
  | { ok: true; lineup: LineupAssignment; changed: string[] }
  | { ok: false; errors: LineupError[] };

export interface EvaluateLineupArgs {
  shape: RosterShape;
  /** playerId -> position for every player on the team's roster. */
  rosterPositions: ReadonlyMap<string, string>;
  /** Currently stored assignment (missing keys = empty). */
  current: Readonly<LineupAssignment>;
  /** Proposed changes; slots not mentioned keep their current player. */
  proposed: Readonly<LineupAssignment>;
  /** playerId -> kickoff ms (UTC) this week; missing = no game (bye), never locks. */
  kickoffs: ReadonlyMap<string, number>;
  nowMs: number;
}

export function evaluateLineup(args: EvaluateLineupArgs): LineupResult {
  const { shape, rosterPositions, current, proposed, kickoffs, nowMs } = args;
  const starterKeys = shape.starters.map((s) => s.key);
  const errors: LineupError[] = [];

  for (const slot of Object.keys(proposed)) {
    if (!starterKeys.includes(slot)) {
      errors.push({
        slot,
        code: 'UNKNOWN_SLOT',
        hint: `no slot "${slot}" in this roster shape; valid slots: ${starterKeys.join(', ')}`,
      });
    }
  }

  // Effective full assignment: unspecified slots keep their current player.
  const effective: LineupAssignment = {};
  for (const key of starterKeys) {
    effective[key] = key in proposed ? (proposed[key] ?? null) : (current[key] ?? null);
  }

  const seen = new Map<string, string>(); // playerId -> first slot
  for (const slotDef of shape.starters) {
    const key = slotDef.key;
    const playerId = effective[key];
    if (playerId === null || playerId === undefined) continue;

    const position = rosterPositions.get(playerId);
    if (position === undefined) {
      errors.push({
        slot: key,
        code: 'NOT_ON_ROSTER',
        hint: `${playerId} is not on this team's roster; check GET roster before submitting`,
      });
      continue;
    }
    if (!slotDef.eligible.includes(position)) {
      errors.push({
        slot: key,
        code: 'INELIGIBLE_POSITION',
        hint: `${playerId} is a ${position}; slot ${key} accepts ${slotDef.eligible.join('/')}`,
      });
    }
    const firstSlot = seen.get(playerId);
    if (firstSlot !== undefined) {
      errors.push({
        slot: key,
        code: 'DUPLICATE_PLAYER',
        hint: `${playerId} already assigned to ${firstSlot}; a player can fill only one slot`,
      });
    } else {
      seen.set(playerId, key);
    }
  }

  // Lock checks apply only to slots that actually change.
  const changed: string[] = [];
  for (const key of starterKeys) {
    const before = current[key] ?? null;
    const after = effective[key] ?? null;
    if (before === after) continue;
    changed.push(key);

    const lockedOut = before !== null && isLocked(kickoffs, before, nowMs);
    if (lockedOut) {
      errors.push({
        slot: key,
        code: 'SLOT_LOCKED',
        hint: `${before} kicked off at ${iso(kickoffs.get(before))}; this slot is frozen until next week`,
      });
    }
    if (after !== null && isLocked(kickoffs, after, nowMs)) {
      errors.push({
        slot: key,
        code: 'PLAYER_LOCKED',
        hint: `${after} kicked off at ${iso(kickoffs.get(after))} and can no longer enter the lineup this week`,
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, lineup: effective, changed };
}

export function isLocked(
  kickoffs: ReadonlyMap<string, number>,
  playerId: string,
  nowMs: number,
): boolean {
  const kickoff = kickoffs.get(playerId);
  return kickoff !== undefined && kickoff <= nowMs;
}

function iso(ms: number | undefined): string {
  return ms === undefined ? 'unknown' : new Date(ms).toISOString();
}
