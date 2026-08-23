import type { RosterShape, SportAdapter, StatLine } from '../adapter';

export const NFL_POSITIONS = ['QB', 'RB', 'WR', 'TE'] as const;

export const nflRosterShape: RosterShape = {
  starters: [
    { key: 'QB', eligible: ['QB'] },
    { key: 'RB1', eligible: ['RB'] },
    { key: 'RB2', eligible: ['RB'] },
    { key: 'WR1', eligible: ['WR'] },
    { key: 'WR2', eligible: ['WR'] },
    { key: 'TE', eligible: ['TE'] },
    { key: 'FLEX', eligible: ['RB', 'WR', 'TE'] },
  ],
  benchSize: 5,
};

// Half-PPR (SPEC §3.2), in centipoints so integer stat values score exactly.
// Stat keys follow nflverse weekly-stats naming.
const SCORING_CENTI: Readonly<Record<string, number>> = {
  passing_yards: 4,
  passing_tds: 400,
  interceptions: -200,
  rushing_yards: 10,
  rushing_tds: 600,
  receptions: 50,
  receiving_yards: 10,
  receiving_tds: 600,
  fumbles_lost: -200,
  two_point_conversions: 200,
};

export function scoreStatLine(stat: StatLine): number {
  let centi = 0;
  for (const [key, weight] of Object.entries(SCORING_CENTI)) {
    const v = stat[key];
    if (v !== undefined) centi += Math.round(v * weight);
  }
  return centi / 100;
}

export const nfl: SportAdapter = {
  sport: 'nfl',
  positions: NFL_POSITIONS,
  rosterShape: nflRosterShape,
  scoreStatLine,
};
