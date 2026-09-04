// Generates the real 2026 draft board from sanctioned nflverse data (F6):
// players on 2026 rosters, ranked by 2025 half-PPR production adjusted for
// positional replacement level (VOR). A pragmatic stand-in for market ADP —
// the human-curated pass before G3 (DRIFT TODO) can overwrite the table.
//
// Usage:
//   node scripts/gen-adp-2026.mjs sql > board.sql    # INSERTs for adp_board
//   node scripts/gen-adp-2026.mjs csv > board.csv    # human-reviewable

const ROSTER_URL = 'https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_2026.csv';
// Weekly snapshots carry draft_number/rookie_year (the season file does not);
// optional — absent file = no rookie seeding, never a crash.
const WEEKLY_URL = 'https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_2026.csv';
const STATS_URL = 'https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2025.csv';

const FANTASY_POS = new Set(['QB', 'RB', 'WR', 'TE']);
// Half-PPR weights in centipoints (mirrors src/sport/nfl SCORING_CENTI).
const W = {
  passing_yards: 4, passing_tds: 400, passing_interceptions: -200,
  rushing_yards: 10, rushing_tds: 600,
  receptions: 50, receiving_yards: 10, receiving_tds: 600,
  sack_fumbles_lost: -200, rushing_fumbles_lost: -200, receiving_fumbles_lost: -200,
  passing_2pt_conversions: 200, rushing_2pt_conversions: 200, receiving_2pt_conversions: 200,
};
// Replacement level: points of the Nth-ranked player at the position
// (10 teams: ~12 startable QB/TE, ~30 RB/WR incl. flex).
const REPLACEMENT_RANK = { QB: 12, RB: 30, WR: 30, TE: 12 };
// Rookies/no-2025-data players slot in behind proven starters but ahead of
// scrubs: a small positional floor so they exist on the board at all.
const NO_DATA_VOR = -5;
// Roster status hygiene (2026-09-04 review): players not on an active roster
// cannot score. CUT/RET are dropped; reserve/exempt/practice-squad players are
// pushed below every active player with positive value but stay draftable.
const DROP_STATUS = new Set(['CUT', 'RET']);
const DEMOTE_STATUS = { RES: -30, PUP: -30, EXE: -30, SUS: -30, RSN: -30, RSR: -30, DEV: -40 };
// Drafted 2026 rookies have no 2025 line, so VOR alone buries a first-round
// back under practice-squad veterans. Seed them at the VOR of the Nth-ranked
// player at their position by draft slot — a prior from sanctioned data
// (draft_number), not market ADP. The human pass can still move anyone.
const ROOKIE_SEED_RANK = [
  [10, { QB: 8, RB: 10, WR: 10, TE: 6 }],
  [32, { QB: 12, RB: 16, WR: 16, TE: 8 }],
  [64, { QB: 16, RB: 24, WR: 24, TE: 12 }],
  [100, { QB: 20, RB: 30, WR: 30, TE: 14 }],
];

function parseCsvLine(line) {
  const out = [];
  let field = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out;
}

async function fetchCsv(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const lines = (await res.text()).split('\n').filter((l) => l.trim() !== '');
  const header = parseCsvLine(lines[0].replace(/\r$/, ''));
  const col = new Map(header.map((h, i) => [h, i]));
  return { lines: lines.slice(1).map((l) => l.replace(/\r$/, '')), col: (n) => col.get(n) };
}

// 2026 roster: latest snapshot per player (`week` is optional — nflverse turned
// the rosters/ file into a season snapshot on 2026-09-03).
const roster = await fetchCsv(ROSTER_URL);
const players = new Map(); // gsis -> {name, position, status, week}
const cWeek = roster.col('week');
for (const line of roster.lines) {
  const row = parseCsvLine(line);
  const gsis = row[roster.col('gsis_id')];
  const pos = row[roster.col('position')];
  if (!gsis || !FANTASY_POS.has(pos)) continue;
  const week = cWeek === undefined ? 0 : Number(row[cWeek] ?? 0);
  const prev = players.get(gsis);
  if (prev && prev.week >= week) continue;
  const status = row[roster.col('status')] ?? 'ACT';
  players.set(gsis, { name: row[roster.col('full_name')] ?? gsis, position: pos, status, week });
}
for (const [gsis, p] of players) if (DROP_STATUS.has(p.status)) players.delete(gsis);

// Draft capital for 2026 rookies, from the weekly file when it exists.
const rookies = new Map(); // gsis -> draft_number
try {
  const weekly = await fetchCsv(WEEKLY_URL);
  for (const line of weekly.lines) {
    const row = parseCsvLine(line);
    if (row[weekly.col('rookie_year')] !== '2026') continue;
    const n = Number(row[weekly.col('draft_number')]);
    if (Number.isFinite(n) && n > 0) rookies.set(row[weekly.col('gsis_id')], n);
  }
} catch (e) {
  console.error(`weekly roster unavailable (${e.message}); rookies keep the floor`);
}

// 2025 season totals (REG) in centipoints.
const stats = await fetchCsv(STATS_URL);
const totals = new Map(); // gsis -> centi
for (const line of stats.lines) {
  const row = parseCsvLine(line);
  if (row[stats.col('season_type')] !== 'REG') continue;
  const gsis = row[stats.col('player_id')];
  if (!players.has(gsis)) continue;
  let centi = totals.get(gsis) ?? 0;
  for (const [k, w] of Object.entries(W)) {
    const v = Number(row[stats.col(k)] ?? 0);
    if (Number.isFinite(v) && v !== 0) centi += Math.round(v * w);
  }
  totals.set(gsis, centi);
}

// VOR per position.
const byPos = { QB: [], RB: [], WR: [], TE: [] };
for (const [gsis, p] of players) {
  byPos[p.position].push({ gsis, points: (totals.get(gsis) ?? null) });
}
const entries = [];
for (const [pos, list] of Object.entries(byPos)) {
  const scored = list.filter((e) => e.points !== null).sort((a, b) => b.points - a.points);
  const repl = scored[REPLACEMENT_RANK[pos] - 1]?.points ?? 0;
  const vorAtRank = (n) => ((scored[n - 1]?.points ?? repl) - repl) / 100;
  for (const e of list) {
    const p = players.get(e.gsis);
    let vor = e.points === null ? NO_DATA_VOR : (e.points - repl) / 100;
    let note = '';
    const draftNo = e.points === null ? rookies.get(e.gsis) : undefined;
    if (draftNo !== undefined) {
      const tier = ROOKIE_SEED_RANK.find(([max]) => draftNo <= max);
      if (tier) { vor = vorAtRank(tier[1][pos]); note = `rookie pick ${draftNo}`; }
    }
    const penalty = DEMOTE_STATUS[p.status];
    if (penalty !== undefined) { vor = Math.min(vor, 0) + penalty; note = p.status; }
    entries.push({ ...p, gsis: e.gsis, position: pos, vor, note });
  }
}
entries.sort((a, b) => b.vor - a.vor || a.gsis.localeCompare(b.gsis));
const board = entries.slice(0, 300).map((e, i) => ({ ...e, adp: i + 1 }));

const mode = process.argv[2] ?? 'sql';
if (mode === 'csv') {
  console.log('player_id,name,position,adp,vor,note');
  for (const e of board) {
    console.log(`nfl:${e.gsis},"${e.name.replaceAll('"', '""')}",${e.position},${e.adp},${e.vor.toFixed(1)},${e.note}`);
  }
} else {
  console.log("DELETE FROM adp_board WHERE sport = 'nfl';");
  for (const e of board) {
    console.log(
      `INSERT INTO adp_board (sport, player_id, position, adp) VALUES ('nfl', 'nfl:${e.gsis}', '${e.position}', ${e.adp});`,
    );
  }
}
console.error(`board: ${board.length} players (${Object.entries(byPos).map(([p, l]) => `${p}:${l.length}`).join(' ')})`);
