// Generates the synthetic 2025 replay season checked into fixtures/replay-2025/.
// Deterministic (seeded); rerunning must reproduce the committed files exactly.
// Players, clubs, and names are synthetic — no real people, no real marks.
//
// Usage: node scripts/gen-fixtures.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(import.meta.dirname, '..', 'fixtures', 'replay-2025');
const SEED = 42;

// Same PRNG as src/engine/schedule.ts (duplicated: scripts are plain node, engine is TS).
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const ri = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)); // inclusive ints
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// --- Clubs & byes ----------------------------------------------------------
const CLUBS = Array.from({ length: 32 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`);
// Weeks 5–12: 4 clubs on bye per week, each club exactly one bye.
const byeByWeek = new Map();
{
  const shuffled = [...CLUBS];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  for (let w = 5; w <= 12; w++) byeByWeek.set(w, shuffled.slice((w - 5) * 4, (w - 4) * 4));
}

// --- Players ---------------------------------------------------------------
const FIRST = ['Axel', 'Brick', 'Cade', 'Dex', 'Enzo', 'Flint', 'Gage', 'Hux', 'Ivo', 'Jett',
  'Kato', 'Lux', 'Mace', 'Nio', 'Onyx', 'Pax', 'Quill', 'Rook', 'Slate', 'Tor',
  'Umber', 'Vann', 'Wick', 'Xylo', 'York', 'Zeph'];
const LAST = ['Amberline', 'Boltwright', 'Crashaw', 'Dunmore', 'Emberfield', 'Farrow', 'Gridiron',
  'Hollowell', 'Ironback', 'Jukewell', 'Kettering', 'Longstride', 'Mudd', 'Northgate',
  'Oakhurst', 'Pylon', 'Quickstep', 'Rumblelow', 'Stiffarm', 'Turfborn', 'Underhill',
  'Vantage', 'Wheelroute', 'Yardley', 'Zonebreak'];

const COUNTS = { QB: 26, RB: 62, WR: 76, TE: 32 };
const players = [];
{
  let n = 0;
  const usedNames = new Set();
  for (const [position, count] of Object.entries(COUNTS)) {
    for (let i = 0; i < count; i++) {
      n++;
      let name;
      do {
        name = `${pick(FIRST)} ${pick(LAST)}`;
      } while (usedNames.has(name));
      usedNames.add(name);
      players.push({
        id: `nfl:p${String(n).padStart(3, '0')}`,
        sport: 'nfl',
        name,
        position,
        team: CLUBS[(n - 1) % CLUBS.length],
        // talent 0..1, earlier within a position batch = better, with noise
        talent: Math.max(0.05, Math.min(1, (1 - i / count) * 0.85 + rand() * 0.3)),
      });
    }
  }
}

// --- ADP board -------------------------------------------------------------
// Positional scarcity weighting so the board interleaves positions plausibly.
const POS_WEIGHT = { QB: 0.82, RB: 1.0, WR: 0.97, TE: 0.78 };
const board = [...players]
  .map((p) => ({ playerId: p.id, position: p.position, value: p.talent * POS_WEIGHT[p.position] + rand() * 0.05 }))
  .sort((a, b) => b.value - a.value)
  .map((e, i) => ({ playerId: e.playerId, position: e.position, adp: i + 1 }));

// --- Schedule (games with kickoffs) ---------------------------------------
// Week 1 Thursday is 2025-09-04; Sun slate 17:00 UTC, one Thu 00:20, one Mon 00:15 (+1d).
const games = [];
{
  for (let week = 1; week <= 14; week++) {
    const active = CLUBS.filter((c) => !(byeByWeek.get(week) ?? []).includes(c));
    const thuMs = Date.UTC(2025, 8, 4, 0, 20) + (week - 1) * 7 * 86400_000;
    const sunMs = thuMs + 3 * 86400_000 + (17 * 60 - 20) * 60_000; // Sunday 17:00 UTC
    const monMs = thuMs + 4 * 86400_000 - 5 * 60_000; // Monday 00:15 UTC
    const shuffled = [...active];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    for (let g = 0; g < shuffled.length / 2; g++) {
      const home = shuffled[g * 2];
      const away = shuffled[g * 2 + 1];
      const kickoff = g === 0 ? thuMs : g === shuffled.length / 2 - 1 ? monMs : sunMs;
      games.push({
        id: `nfl:2025:${week}:${home}-${away}`,
        sport: 'nfl',
        season: 2025,
        week,
        kickoff_at: new Date(kickoff).toISOString(),
        home,
        away,
      });
    }
  }
}

// --- Weekly stat lines -----------------------------------------------------
function statLine(p) {
  const t = p.talent;
  const boom = rand() < 0.12 ? 1.6 : 1; // spiky weeks
  const bust = rand() < 0.15 ? 0.45 : 1;
  const vol = boom * bust;
  const line = {};
  if (p.position === 'QB') {
    line.passing_yards = Math.round((150 + t * 180 + ri(-40, 40)) * vol);
    line.passing_tds = Math.max(0, Math.round((0.8 + t * 2.2) * vol + ri(-1, 1)));
    line.interceptions = Math.max(0, ri(0, 2) + (rand() < 0.2 ? 1 : 0) - Math.round(t));
    line.rushing_yards = Math.max(0, ri(-5, 30));
    if (rand() < 0.08 + t * 0.1) line.rushing_tds = 1;
  } else if (p.position === 'RB') {
    line.rushing_yards = Math.round((20 + t * 90 + ri(-15, 25)) * vol);
    line.receptions = Math.max(0, ri(0, 3) + Math.round(t * 3 * vol));
    line.receiving_yards = Math.round(line.receptions * ri(5, 11));
    if (rand() < 0.12 + t * 0.35) line.rushing_tds = ri(1, 2);
    if (rand() < 0.06 + t * 0.08) line.receiving_tds = 1;
  } else if (p.position === 'WR') {
    line.receptions = Math.max(0, Math.round((1.5 + t * 5.5) * vol + ri(-1, 1)));
    line.receiving_yards = Math.round(line.receptions * ri(8, 16));
    if (rand() < 0.1 + t * 0.32) line.receiving_tds = ri(1, 2);
    if (rand() < 0.04) line.rushing_yards = ri(3, 25);
  } else {
    line.receptions = Math.max(0, Math.round((1 + t * 4) * vol + ri(-1, 1)));
    line.receiving_yards = Math.round(line.receptions * ri(7, 13));
    if (rand() < 0.07 + t * 0.25) line.receiving_tds = 1;
  }
  if (rand() < 0.035) line.fumbles_lost = 1;
  if (rand() < 0.02) line.two_point_conversions = 1;
  for (const k of Object.keys(line)) if (line[k] === 0) delete line[k];
  return line;
}

const stats = {};
for (let week = 1; week <= 14; week++) {
  const bye = new Set(byeByWeek.get(week) ?? []);
  const weekStats = {};
  for (const p of players) {
    if (bye.has(p.team)) continue; // bye week: no stat line
    if (rand() < 0.04) continue; // occasional DNP (injury/inactive)
    weekStats[p.id] = statLine(p);
  }
  stats[week] = weekStats;
}

// --- Write files -----------------------------------------------------------
mkdirSync(OUT, { recursive: true });
const strip = players.map(({ talent, ...rest }) => rest);
writeFileSync(join(OUT, 'players.json'), JSON.stringify(strip, null, 1));
writeFileSync(join(OUT, 'adp.json'), JSON.stringify(board, null, 1));
const adpCsv =
  'player_id,position,adp\n' + board.map((e) => `${e.playerId},${e.position},${e.adp}`).join('\n') + '\n';
writeFileSync(join(OUT, 'adp.csv'), adpCsv);
// NOTE: the runtime board is the D1 adp_board table (seeded per environment);
// the bundled src/sport/nfl/data/adp.csv is only an existence-filtered
// fallback and is no longer written from fixtures.
writeFileSync(join(OUT, 'schedule.json'), JSON.stringify(games, null, 1));
writeFileSync(join(OUT, 'stats.json'), JSON.stringify(stats, null, 1));

console.log(
  `wrote ${strip.length} players, ${board.length} ADP rows, ${games.length} games, 14 stat weeks -> ${OUT}`,
);
