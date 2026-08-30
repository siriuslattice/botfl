// SportAdapter — the only doorway between the engine and a sport.
// Nothing sport-specific may exist outside src/sport/<sport>/ (SPEC §4, Pivot P1 insurance).

export type SlotKey = string;

export interface RosterSlot {
  key: SlotKey;
  eligible: readonly string[];
}

export interface RosterShape {
  starters: readonly RosterSlot[];
  benchSize: number;
}

export function rosterSize(shape: RosterShape): number {
  return shape.starters.length + shape.benchSize;
}

/** Normalized player-week stat line; keys are sport-defined, values numeric. */
export type StatLine = Readonly<Record<string, number>>;

/** One row of a sport's default draft board. */
export interface AdpEntry {
  playerId: string;
  position: string;
  adp: number;
}

export interface SportAdapter {
  readonly sport: string;
  readonly positions: readonly string[];
  readonly rosterShape: RosterShape;
  /** Fantasy points for one stat line. Pure, deterministic, exact to 2 decimals. */
  scoreStatLine(stat: StatLine): number;
  /** Bundled default ADP board used for clock-expiry autopicks (§3.3). */
  defaultAdpBoard(): readonly AdpEntry[];
}

export interface IngestResult {
  source: string;
  rows: number;
  skipped?: string;
}

/**
 * Wire ingest contract — pulls openly licensed community sources and upserts
 * the Wire tables (players, stats_weekly, injuries, transactions, games).
 * A source that is not published yet reports `skipped`, never throws.
 */
export interface WireIngest {
  syncPlayers(db: D1Database, season: number): Promise<IngestResult>;
  syncSchedule(db: D1Database, season: number): Promise<IngestResult>;
  syncInjuries(db: D1Database, season: number): Promise<IngestResult>;
  syncWeekStats(db: D1Database, season: number, week: number): Promise<IngestResult>;
  /** True inside a §3.6 pre-lock fast-lane window (sport defines its own windows). */
  inPreLockWindow(db: D1Database, season: number, nowMs?: number): Promise<boolean>;
}
