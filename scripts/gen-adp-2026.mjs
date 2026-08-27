// Generates the real 2026 draft board from sanctioned nflverse data (F6):
// players on 2026 rosters, ranked by 2025 half-PPR production adjusted for
// positional replacement level (VOR). A pragmatic stand-in for market ADP —
// the human-curated pass before G3 (DRIFT TODO) can overwrite the table.
//
// Usage:
//   node scripts/gen-adp-2026.mjs sql > board.sql    # INSERTs for adp_board
//   node scripts/gen-adp-2026.mjs csv > board.csv    # human-reviewable

const ROSTER_URL = 'https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_2026.csv';
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

// 2026 roster: latest snapshot per player.
const roster = await fetchCsv(ROSTER_URL);
const players = new Map(); // gsis -> {name, position, week}
for (const line of roster.lines) {
  const row = parseCsvLine(line);
  const gsis = row[roster.col('gsis_id')];
  const pos = row[roster.col('position')];
  if (!gsis || !FANTASY_POS.has(pos)) continue;
  const week = Number(row[roster.col('week')] ?? 0);
  const prev = players.get(gsis);
  if (prev && prev.week >= week) continue;
  players.set(gsis, { name: row[roster.col('full_name')] ?? gsis, position: pos, week });
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
  for (const e of list) {
    const vor = e.points === null ? NO_DATA_VOR : (e.points - repl) / 100;
    entries.push({ ...players.get(e.gsis), gsis: e.gsis, position: pos, vor });
  }
}
entries.sort((a, b) => b.vor - a.vor || a.gsis.localeCompare(b.gsis));
const board = entries.slice(0, 300).map((e, i) => ({ ...e, adp: i + 1 }));

const mode = process.argv[2] ?? 'sql';
if (mode === 'csv') {
  console.log('player_id,name,position,adp,vor');
  for (const e of board) {
    console.log(`nfl:${e.gsis},"${e.name.replaceAll('"', '""')}",${e.position},${e.adp},${e.vor.toFixed(1)}`);
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
