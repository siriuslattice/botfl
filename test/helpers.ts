// Shared test scaffolding: register agents, fill leagues, seed Wire data
// from the replay fixtures into local D1.

import { env } from 'cloudflare:test';
import adpJson from '../fixtures/replay-2025/adp.json';
import playersJson from '../fixtures/replay-2025/players.json';
import scheduleJson from '../fixtures/replay-2025/schedule.json';
import { app } from '../src/index';

let ipCounter = 0;
let agentCounter = 0;

export interface TestAgent {
  name: string;
  apiKey: string;
  agentId: string;
}

export async function registerAgent(prefix = 'Agent'): Promise<TestAgent> {
  const name = `${prefix} ${++agentCounter}`;
  const res = await app.request(
    '/register',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': `10.20.${++ipCounter}.1` },
      body: JSON.stringify({ name, model: 'test-model', owner_email: `t${agentCounter}@example.com` }),
    },
    env,
  );
  if (res.status !== 201) throw new Error(`register failed: ${await res.text()}`);
  const body = await res.json<{ api_key: string; agent_id: string }>();
  return { name, apiKey: body.api_key, agentId: body.agent_id };
}

export async function authed(path: string, key: string, init: RequestInit = {}) {
  return app.request(
    path,
    {
      ...init,
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    },
    env,
  );
}

/** Register 10 agents and fill one league; returns members + league id. */
export async function fillLeague(prefix = 'Team'): Promise<{
  leagueId: string;
  members: (TestAgent & { teamId: string })[];
}> {
  const members: (TestAgent & { teamId: string })[] = [];
  let leagueId = '';
  for (let i = 0; i < 10; i++) {
    const agent = await registerAgent(prefix);
    const res = await authed('/leagues/join', agent.apiKey, { method: 'POST' });
    const body = await res.json<{ league_id: string; team_id: string }>();
    leagueId = body.league_id;
    members.push({ ...agent, teamId: body.team_id });
  }
  return { leagueId, members };
}

/** Seed fixture players (and optionally games for a season) into D1. */
export async function seedWire(
  opts: { games?: boolean; season?: number; kickoffOffsetMs?: number } = {},
): Promise<void> {
  const now = new Date().toISOString();
  const players = playersJson as { id: string; sport: string; name: string; position: string; team: string }[];
  const stmts = players.map((p) =>
    env.DB.prepare(
      "INSERT OR IGNORE INTO players (id, sport, name, position, team, status, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
    ).bind(p.id, p.sport, p.name, p.position, p.team, now),
  );
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));

  const board = adpJson as { playerId: string; position: string; adp: number }[];
  const adpStmts = board.map((e) =>
    env.DB.prepare(
      "INSERT OR IGNORE INTO adp_board (sport, player_id, position, adp) VALUES ('nfl', ?, ?, ?)",
    ).bind(e.playerId, e.position, e.adp),
  );
  for (let i = 0; i < adpStmts.length; i += 50) await env.DB.batch(adpStmts.slice(i, i + 50));

  if (opts.games) {
    const games = scheduleJson as {
      id: string; sport: string; season: number; week: number; kickoff_at: string; home: string; away: string;
    }[];
    const gameStmts = games.map((g) => {
      const kickoff = new Date(Date.parse(g.kickoff_at) + (opts.kickoffOffsetMs ?? 0)).toISOString();
      return env.DB.prepare(
        'INSERT OR IGNORE INTO games (id, sport, season, week, kickoff_at, home, away) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(g.id, g.sport, opts.season ?? g.season, g.week, kickoff, g.home, g.away);
    });
    for (let i = 0; i < gameStmts.length; i += 50) await env.DB.batch(gameStmts.slice(i, i + 50));
  }
}

/** Offset that lands fixture week-1 kickoffs ~3 days in the future. */
export function futureKickoffOffset(): number {
  const fixtureWeek1 = Date.UTC(2025, 8, 4);
  return Date.now() + 3 * 86400_000 - fixtureWeek1;
}

/**
 * Make (season, week) COVERED for the settlement gate: one inert '{}' stat row
 * per fixture club playing that week (settle only consumes starters' lines, so
 * scores and snapshot hashes are untouched). Call AFTER inserting a test's own
 * real stat lines — this uses INSERT OR IGNORE and never overwrites them.
 */
export async function seedWeekStatsCoverage(season: number, week: number): Promise<void> {
  const games = scheduleJson as { week: number; home: string; away: string }[];
  const clubs = new Set<string>();
  for (const g of games) {
    if (g.week === week) {
      clubs.add(g.home);
      clubs.add(g.away);
    }
  }
  const players = playersJson as { id: string; team: string }[];
  const byClub = new Map<string, string>();
  for (const p of players) {
    // Keep the LAST-listed player per club — least likely to be a drafted starter.
    if (clubs.has(p.team)) byClub.set(p.team, p.id);
  }
  const now = new Date().toISOString();
  const stmts = [...byClub.values()].map((pid) =>
    env.DB.prepare(
      "INSERT OR IGNORE INTO stats_weekly (player_id, season, week, stat_json, updated_at) VALUES (?, ?, ?, '{}', ?)",
    ).bind(pid, season, week, now),
  );
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}
