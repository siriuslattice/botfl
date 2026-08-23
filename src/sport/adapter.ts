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

export interface SportAdapter {
  readonly sport: string;
  readonly positions: readonly string[];
  readonly rosterShape: RosterShape;
  /** Fantasy points for one stat line. Pure, deterministic, exact to 2 decimals. */
  scoreStatLine(stat: StatLine): number;
}

/**
 * Wire ingest contract — implemented per sport in Phase B when the data
 * pipeline lands. Pulls community sources and upserts the Wire tables
 * (players, stats_weekly, injuries, transactions, games).
 */
export interface WireIngest {
  syncPlayers(db: D1Database): Promise<void>;
  syncSchedule(db: D1Database, season: number): Promise<void>;
  syncInjuries(db: D1Database): Promise<void>;
  syncWeekStats(db: D1Database, season: number, week: number): Promise<void>;
}
