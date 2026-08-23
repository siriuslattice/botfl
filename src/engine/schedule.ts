// Matchmaking + schedule engine — pure functions only, no I/O (SPEC Appendix B).
// 10 teams, weeks 1–14 regular season (§3.2): a full 9-round round-robin, then
// rounds 1–5 repeat with home/away flipped. Playoffs weeks 15–17, 4 teams.

export interface ScheduledMatchup {
  week: number;
  home: string;
  away: string;
}

export const REGULAR_SEASON_WEEKS = 14;
export const PLAYOFF_WEEKS = [15, 16, 17] as const;

/**
 * Deterministic draft-slot assignment: seeded shuffle keyed on the league id,
 * so join order confers no draft-position advantage and re-runs agree.
 * Returns agentIds in slot order (index 0 = slot 1).
 */
export function assignDraftSlots(leagueId: string, agentIds: readonly string[]): string[] {
  const rand = mulberry32(fnv1a(leagueId));
  const out = [...agentIds].sort();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = out[i]!;
    out[i] = out[j]!;
    out[j] = a;
  }
  return out;
}

/**
 * Circle-method round robin. For n teams there are n-1 unique rounds; weeks
 * beyond that repeat from round 1 with home/away flipped.
 */
export function regularSeasonSchedule(
  teamIds: readonly string[],
  weeks: number = REGULAR_SEASON_WEEKS,
): ScheduledMatchup[] {
  const n = teamIds.length;
  if (n % 2 !== 0 || n < 2) throw new Error(`team count must be even, got ${n}`);
  const rounds = n - 1;
  const half = n / 2;
  const out: ScheduledMatchup[] = [];

  for (let week = 1; week <= weeks; week++) {
    const round = (week - 1) % rounds;
    const repeat = Math.floor((week - 1) / rounds) % 2 === 1;
    // positions: index 0 fixed, the rest rotate by `round`.
    const pos: string[] = [teamIds[0]!];
    for (let i = 1; i < n; i++) {
      pos.push(teamIds[1 + ((i - 1 + round) % (n - 1))]!);
    }
    for (let i = 0; i < half; i++) {
      const a = pos[i]!;
      const b = pos[n - 1 - i]!;
      // Alternate orientation by pair index so home/away spreads out; flip on repeat rounds.
      const homeFirst = (i % 2 === 0) !== repeat;
      out.push({ week, home: homeFirst ? a : b, away: homeFirst ? b : a });
    }
  }
  return out;
}

export interface PlayoffPair {
  week: number;
  home: string; // better seed
  away: string;
  stage: 'semi' | 'final' | 'third';
}

/** Week 15: semifinals — 1v4 and 2v3, better seed at home. */
export function semifinalPairs(seeds: readonly string[]): PlayoffPair[] {
  if (seeds.length !== 4) throw new Error(`playoffs take 4 seeds, got ${seeds.length}`);
  return [
    { week: 15, home: seeds[0]!, away: seeds[3]!, stage: 'semi' },
    { week: 15, home: seeds[1]!, away: seeds[2]!, stage: 'semi' },
  ];
}

/**
 * Weeks 16–17: two-week cumulative championship for the semifinal winners and
 * a two-week third-place game for the losers (settled by summed score).
 */
export function finalPairs(
  semiWinners: readonly string[],
  semiLosers: readonly string[],
  week: 16 | 17,
): PlayoffPair[] {
  if (semiWinners.length !== 2 || semiLosers.length !== 2) {
    throw new Error('finals take exactly 2 winners and 2 losers');
  }
  return [
    { week, home: semiWinners[0]!, away: semiWinners[1]!, stage: 'final' },
    { week, home: semiLosers[0]!, away: semiLosers[1]!, stage: 'third' },
  ];
}

// Deterministic PRNG (no Math.random in the engine — reproducibility is a rule).
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export { fnv1a, mulberry32 };
