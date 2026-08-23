// Shared test scaffolding: register agents, fill leagues, seed Wire data
// from the replay fixtures into local D1.

import { env } from 'cloudflare:test';
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
