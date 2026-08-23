// Emits SQL to seed local D1 from the replay fixtures (e2e + G1 seeding).
//
// Usage:
//   node scripts/fixtures-to-sql.mjs players
//   node scripts/fixtures-to-sql.mjs games --season 2025 --offset-ms 123456
//   node scripts/fixtures-to-sql.mjs stats --week 1 --season 2025

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIX = join(import.meta.dirname, '..', 'fixtures', 'replay-2025');
const load = (f) => JSON.parse(readFileSync(join(FIX, f), 'utf8'));
const q = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replaceAll("'", "''")}'`);

const [, , kind, ...rest] = process.argv;
const args = {};
for (let i = 0; i < rest.length; i += 2) args[rest[i].replace(/^--/, '')] = rest[i + 1];
const now = new Date().toISOString();

if (kind === 'players') {
  for (const p of load('players.json')) {
    console.log(
      `INSERT OR IGNORE INTO players (id, sport, name, position, team, status, updated_at) VALUES (${q(p.id)}, ${q(p.sport)}, ${q(p.name)}, ${q(p.position)}, ${q(p.team)}, 'active', ${q(now)});`,
    );
  }
} else if (kind === 'games') {
  const season = Number(args.season ?? 2025);
  const offset = Number(args['offset-ms'] ?? 0);
  for (const g of load('schedule.json')) {
    const kickoff = new Date(Date.parse(g.kickoff_at) + offset).toISOString();
    console.log(
      `INSERT OR IGNORE INTO games (id, sport, season, week, kickoff_at, home, away) VALUES (${q(g.id)}, ${q(g.sport)}, ${season}, ${g.week}, ${q(kickoff)}, ${q(g.home)}, ${q(g.away)});`,
    );
  }
} else if (kind === 'stats') {
  const week = Number(args.week ?? 1);
  const season = Number(args.season ?? 2025);
  const stats = load('stats.json')[String(week)] ?? {};
  for (const [playerId, line] of Object.entries(stats)) {
    console.log(
      `INSERT OR IGNORE INTO stats_weekly (player_id, season, week, stat_json, updated_at) VALUES (${q(playerId)}, ${season}, ${week}, ${q(JSON.stringify(line))}, ${q(now)});`,
    );
  }
} else {
  console.error('usage: fixtures-to-sql.mjs players|games|stats [--season N] [--offset-ms N] [--week N]');
  process.exit(2);
}
