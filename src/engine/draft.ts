// Draft engine — pure functions only, no I/O (SPEC Appendix B).
// Slow snake draft: 72h window, 4h pick clock, ADP autopick on expiry (§3.3).

import type { RosterShape } from '../sport/adapter';
import { rosterSize } from '../sport/adapter';

export interface DraftConfig {
  teamCount: number;
  rounds: number;
  clockMs: number;
  windowMs: number;
}

export const DEFAULT_CLOCK_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_WINDOW_MS = 72 * 60 * 60 * 1000;

export function draftConfig(teamCount: number, shape: RosterShape): DraftConfig {
  return {
    teamCount,
    rounds: rosterSize(shape),
    clockMs: DEFAULT_CLOCK_MS,
    windowMs: DEFAULT_WINDOW_MS,
  };
}

export function totalPicks(cfg: DraftConfig): number {
  return cfg.teamCount * cfg.rounds;
}

export function roundForPick(cfg: DraftConfig, overallPick: number): number {
  return Math.floor((overallPick - 1) / cfg.teamCount) + 1;
}

/** Team slot (1-based) on the clock for an overall pick number, snake order. */
export function teamSlotForPick(cfg: DraftConfig, overallPick: number): number {
  const round = roundForPick(cfg, overallPick);
  const idx = (overallPick - 1) % cfg.teamCount;
  return round % 2 === 1 ? idx + 1 : cfg.teamCount - idx;
}

export interface NextPick {
  overall: number;
  round: number;
  teamSlot: number;
}

/** The pick currently on the clock given how many picks exist, or null when done. */
export function nextPick(cfg: DraftConfig, pickCount: number): NextPick | null {
  if (pickCount >= totalPicks(cfg)) return null;
  const overall = pickCount + 1;
  return { overall, round: roundForPick(cfg, overall), teamSlot: teamSlotForPick(cfg, overall) };
}

export function isDraftComplete(cfg: DraftConfig, pickCount: number): boolean {
  return pickCount >= totalPicks(cfg);
}

/** Hard end of the whole draft: everything unpicked autopicks after this. */
export function draftHardEndsAt(cfg: DraftConfig, draftOpensAtMs: number): number {
  return draftOpensAtMs + cfg.windowMs;
}

/**
 * Deadline for the pick currently on the clock. The 4h clock runs from the
 * later of draft open / previous pick, capped by the 72h hard end.
 */
export function pickDeadline(
  cfg: DraftConfig,
  draftOpensAtMs: number,
  lastPickAtMs: number | null,
): number {
  const base = Math.max(draftOpensAtMs, lastPickAtMs ?? draftOpensAtMs);
  return Math.min(base + cfg.clockMs, draftHardEndsAt(cfg, draftOpensAtMs));
}

// --- Autopick -------------------------------------------------------------

export type { AdpEntry } from '../sport/adapter';
import type { AdpEntry } from '../sport/adapter';

/**
 * Count of starter slots the given position multiset cannot fill. Dedicated
 * slots take players first; FLEX takes one leftover. Exact for shapes whose
 * only multi-eligible slot is a single leftover-eating FLEX (the v1 shape).
 */
export function starterDeficit(shape: RosterShape, positions: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const p of positions) counts.set(p, (counts.get(p) ?? 0) + 1);

  const dedicated = shape.starters.filter((s) => s.eligible.length === 1);
  const flexes = shape.starters.filter((s) => s.eligible.length > 1);

  let filled = 0;
  const used = new Map<string, number>();
  for (const slot of dedicated) {
    const pos = slot.eligible[0]!;
    if ((used.get(pos) ?? 0) < (counts.get(pos) ?? 0)) {
      used.set(pos, (used.get(pos) ?? 0) + 1);
      filled++;
    }
  }
  for (const slot of flexes) {
    const leftoverPos = slot.eligible.find(
      (pos) => (counts.get(pos) ?? 0) - (used.get(pos) ?? 0) > 0,
    );
    if (leftoverPos) {
      used.set(leftoverPos, (used.get(leftoverPos) ?? 0) + 1);
      filled++;
    }
  }
  return shape.starters.length - filled;
}

/**
 * Best available from the ADP board. Once remaining picks are down to the
 * starter deficit, only players that reduce the deficit are eligible, so an
 * auto-drafted team always ends with a startable roster.
 */
export function autopick(
  board: readonly AdpEntry[],
  taken: ReadonlySet<string>,
  myPositions: readonly string[],
  shape: RosterShape,
): AdpEntry | null {
  const available = board
    .filter((e) => !taken.has(e.playerId))
    .sort((a, b) => a.adp - b.adp || a.playerId.localeCompare(b.playerId));
  if (available.length === 0) return null;

  const deficit = starterDeficit(shape, myPositions);
  const remaining = rosterSize(shape) - myPositions.length;
  if (remaining <= deficit) {
    const helpful = available.find(
      (e) => starterDeficit(shape, [...myPositions, e.position]) < deficit,
    );
    if (helpful) return helpful;
  }
  return available[0] ?? null;
}
