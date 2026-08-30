// nflverse ingest (SPEC §3.6, F6: sanctioned community data only).
// Sources (openly licensed):
//   rosters   github.com/nflverse/nflverse-data releases: rosters/roster_{season}.csv
//   schedule  github.com/nflverse/nfldata: data/games.csv
//   injuries  nflverse-data releases: injuries/injuries_{season}.csv
//   stats     nflverse-data releases: stats_player/stats_player_week_{season}.csv
// Weekly stats for a season 404 until published — treated as "not yet", not an error.

import type { IngestResult, StatLine, WireIngest } from '../adapter';
import { csvHeader, csvLines, parseCsvLine } from './csv';
import { easternOffsetHours, easternToUtcIso } from './time';
import { NFL_POSITIONS } from './index';

const BASE = 'https://github.com/nflverse';
const URLS = {
  roster: (season: number) => `${BASE}/nflverse-data/releases/download/rosters/roster_${season}.csv`,
  games: () => `${BASE}/nfldata/raw/master/data/games.csv`,
  injuries: (season: number) => `${BASE}/nflverse-data/releases/download/injuries/injuries_${season}.csv`,
  stats: (season: number) => `${BASE}/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`,
};

const FANTASY_POS = new Set<string>(NFL_POSITIONS);

async function fetchCsv(url: string): Promise<string | null> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'deep-league-wire/1.0 (community data ingest)' },
    redirect: 'follow',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`ingest fetch ${url} -> ${res.status}`);
  return res.text();
}

async function batchAll(db: D1Database, stmts: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
}

export async function syncPlayers(db: D1Database, season: number): Promise<IngestResult> {
  const text = await fetchCsv(URLS.roster(season));
  if (text === null) return { source: 'players', rows: 0, skipped: 'roster file not published' };
  const lines = csvLines(text);
  const t = csvHeader(lines[0] ?? '');
  const cGsis = t.col('gsis_id');
  const cPos = t.col('position');
  const cName = t.col('full_name');
  const cTeam = t.col('team');
  const cStatus = t.col('status');
  const cWeek = t.col('week');

  // Roster files accumulate weekly snapshots; keep the latest week per player.
  const latest = new Map<string, { name: string; position: string; team: string; status: string; week: number }>();
  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]!);
    const gsis = row[cGsis];
    const position = row[cPos] ?? '';
    if (!gsis || !FANTASY_POS.has(position)) continue;
    const week = Number(row[cWeek] ?? '0');
    const prev = latest.get(gsis);
    if (prev && prev.week >= week) continue;
    latest.set(gsis, {
      name: row[cName] ?? gsis,
      position,
      team: row[cTeam] ?? '',
      status: (row[cStatus] ?? 'ACT') === 'ACT' ? 'active' : (row[cStatus] ?? '').toLowerCase(),
      week,
    });
  }
  const now = new Date().toISOString();
  await batchAll(
    db,
    [...latest.entries()].map(([gsis, p]) =>
      db
        .prepare(
          `INSERT INTO players (id, sport, name, position, team, status, updated_at)
           VALUES (?, 'nfl', ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, position = excluded.position,
             team = excluded.team, status = excluded.status, updated_at = excluded.updated_at`,
        )
        .bind(`nfl:${gsis}`, p.name, p.position, p.team, p.status, now),
    ),
  );
  return { source: 'players', rows: latest.size };
}

export async function syncSchedule(db: D1Database, season: number): Promise<IngestResult> {
  const text = await fetchCsv(URLS.games());
  if (text === null) return { source: 'schedule', rows: 0, skipped: 'games.csv missing' };
  const lines = csvLines(text);
  const t = csvHeader(lines[0] ?? '');
  const cId = t.col('game_id');
  const cSeason = t.col('season');
  const cType = t.col('game_type');
  const cWeek = t.col('week');
  const cDay = t.col('gameday');
  const cTime = t.col('gametime');
  const cAway = t.col('away_team');
  const cHome = t.col('home_team');
  // Optional: their absence upstream must not take down schedule ingest.
  const cAwayCoach = t.colOpt('away_coach');
  const cHomeCoach = t.colOpt('home_coach');
  const cReferee = t.colOpt('referee');

  const stmts: D1PreparedStatement[] = [];
  // Coaches and officials are real humans the F3 heuristic must know about;
  // this CSV is where their names already live (SPEC §1 F3).
  const protectedNames = new Map<string, string>();
  const prefix = `${season}_`;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith(prefix)) continue; // cheap prefilter: game_id begins with season
    const row = parseCsvLine(line);
    if (Number(row[cSeason]) !== season || row[cType] !== 'REG') continue;
    for (const [col, role] of [[cAwayCoach, 'coach'], [cHomeCoach, 'coach'], [cReferee, 'referee']] as const) {
      const name = (row[col] ?? '').trim();
      if (name.length >= 4) protectedNames.set(`${name}|${role}`, name);
    }
    const gameday = row[cDay] ?? '';
    const gametime = row[cTime] ?? '';
    if (!gameday || !gametime) continue; // untimed games can't drive locks; picked up when set
    stmts.push(
      db
        .prepare(
          `INSERT INTO games (id, sport, season, week, kickoff_at, home, away)
           VALUES (?, 'nfl', ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET kickoff_at = excluded.kickoff_at,
             week = excluded.week, home = excluded.home, away = excluded.away`,
        )
        .bind(
          `nfl:${row[cId]}`,
          season,
          Number(row[cWeek]),
          easternToUtcIso(gameday, gametime),
          row[cHome] ?? '',
          row[cAway] ?? '',
        ),
    );
  }
  const gameRows = stmts.length;
  for (const [key, name] of protectedNames) {
    const role = key.slice(key.indexOf('|') + 1);
    stmts.push(
      db
        .prepare("INSERT OR IGNORE INTO protected_names (sport, name, role) VALUES ('nfl', ?, ?)")
        .bind(name, role),
    );
  }
  await batchAll(db, stmts);
  return { source: 'schedule', rows: gameRows };
}

/**
 * Pre-lock ingest window (SPEC §3.6): fast-lane cadence applies inside the
 * Sunday-morning inactives block (07:00–10:00 PT) and within 2h before ANY
 * kickoff — the latter is data-driven off the games table, so Thu/Fri/Sat/Mon
 * windows come free and nothing needs a day-of-week list.
 */
export async function inPreLockWindow(db: D1Database, season: number, nowMs = Date.now()): Promise<boolean> {
  // PT shares the US DST rule with ET at PT = ET − 3h. Converge on the local
  // components with one fixed-point pass so DST-transition mornings resolve
  // against Pacific local time, not UTC.
  const off0 =
    easternOffsetHours(
      new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(),
      new Date(nowMs).getUTCDate(), new Date(nowMs).getUTCHours(),
    ) - 3;
  const guess = new Date(nowMs + off0 * 3600_000);
  const off =
    easternOffsetHours(guess.getUTCFullYear(), guess.getUTCMonth(), guess.getUTCDate(), guess.getUTCHours()) - 3;
  const pt = new Date(nowMs + off * 3600_000);
  if (pt.getUTCDay() === 0 && pt.getUTCHours() >= 7 && pt.getUTCHours() < 10) return true;

  const soon = await db
    .prepare("SELECT 1 AS x FROM games WHERE sport = 'nfl' AND season = ? AND kickoff_at > ? AND kickoff_at <= ? LIMIT 1")
    .bind(season, new Date(nowMs).toISOString(), new Date(nowMs + 2 * 3600_000).toISOString())
    .first();
  return soon !== null;
}

export async function syncInjuries(db: D1Database, season: number): Promise<IngestResult> {
  const text = await fetchCsv(URLS.injuries(season));
  if (text === null) return { source: 'injuries', rows: 0, skipped: 'injuries not published yet' };
  const lines = csvLines(text);
  const t = csvHeader(lines[0] ?? '');
  const cGsis = t.col('gsis_id');
  const cPos = t.col('position');
  const cWeek = t.col('week');
  const cReport = t.col('report_status');
  const cPractice = t.col('practice_status');
  const cPrimary = t.col('report_primary_injury');
  const cPracticePrimary = t.col('practice_primary_injury');

  // Keep each player's latest-week row.
  const latest = new Map<string, { week: number; status: string; note: string }>();
  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]!);
    const gsis = row[cGsis];
    if (!gsis || !FANTASY_POS.has(row[cPos] ?? '')) continue;
    const week = Number(row[cWeek] ?? '0');
    const prev = latest.get(gsis);
    if (prev && prev.week > week) continue;
    const status = row[cReport] || row[cPractice] || '';
    if (!status) continue;
    latest.set(gsis, {
      week,
      status,
      note: row[cPrimary] || row[cPracticePrimary] || '',
    });
  }
  const now = new Date().toISOString();
  await batchAll(
    db,
    [...latest.entries()].map(([gsis, inj]) =>
      db
        .prepare(
          `INSERT INTO injuries (player_id, status, note, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (player_id) DO UPDATE SET status = excluded.status,
             note = excluded.note, updated_at = excluded.updated_at`,
        )
        .bind(`nfl:${gsis}`, inj.status, inj.note, now),
    ),
  );
  return { source: 'injuries', rows: latest.size };
}

/** Normalized fantasy stat line from one stats_player_week row. */
export function mapStatRow(t: ReturnType<typeof csvHeader>, row: string[]): StatLine {
  const n = (name: string): number => {
    const v = row[t.col(name)];
    const x = v === undefined || v === '' ? 0 : Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  const line: Record<string, number> = {
    passing_yards: n('passing_yards'),
    passing_tds: n('passing_tds'),
    interceptions: n('passing_interceptions'),
    rushing_yards: n('rushing_yards'),
    rushing_tds: n('rushing_tds'),
    receptions: n('receptions'),
    receiving_yards: n('receiving_yards'),
    receiving_tds: n('receiving_tds'),
    fumbles_lost: n('sack_fumbles_lost') + n('rushing_fumbles_lost') + n('receiving_fumbles_lost'),
    two_point_conversions:
      n('passing_2pt_conversions') + n('rushing_2pt_conversions') + n('receiving_2pt_conversions'),
  };
  for (const k of Object.keys(line)) if (line[k] === 0) delete line[k];
  return line;
}

export async function syncWeekStats(db: D1Database, season: number, week: number): Promise<IngestResult> {
  const text = await fetchCsv(URLS.stats(season));
  if (text === null) return { source: 'stats', rows: 0, skipped: `season ${season} stats not published yet` };
  const lines = csvLines(text);
  const t = csvHeader(lines[0] ?? '');
  const cPlayer = t.col('player_id');
  const cPos = t.col('position');
  const cSeason = t.col('season');
  const cWeek = t.col('week');
  const cType = t.col('season_type');

  const now = new Date().toISOString();
  const prefilter = `,${season},${week},REG,`; // season,week,season_type are adjacent columns
  const stmts: D1PreparedStatement[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes(prefilter)) continue;
    const row = parseCsvLine(line);
    if (Number(row[cSeason]) !== season || Number(row[cWeek]) !== week || row[cType] !== 'REG') continue;
    const gsis = row[cPlayer];
    if (!gsis || !FANTASY_POS.has(row[cPos] ?? '')) continue;
    stmts.push(
      db
        .prepare(
          `INSERT INTO stats_weekly (player_id, season, week, stat_json, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (player_id, season, week) DO UPDATE SET stat_json = excluded.stat_json,
             updated_at = excluded.updated_at`,
        )
        .bind(`nfl:${gsis}`, season, week, JSON.stringify(mapStatRow(t, row)), now),
    );
  }
  await batchAll(db, stmts);
  return { source: 'stats', rows: stmts.length };
}

export const nflIngest: WireIngest = {
  syncPlayers,
  syncSchedule,
  syncInjuries,
  syncWeekStats,
  inPreLockWindow,
};
