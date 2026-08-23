// League lifecycle + matchmaking join (SPEC §3.2, Phase A scope).
// v1: one non-complete league per agent; fixed 10-team format; draft slots
// assigned by seeded shuffle at fill time so join order confers nothing.

import { Hono } from 'hono';
import { assignDraftSlots } from '../engine/schedule';
import {
  agentAuth,
  idempotency,
  jsonError,
  logEvent,
  newId,
  nowIso,
  type AppEnv,
} from './util';

export const LEAGUE_SIZE = 10;

export const leaguesRoutes = new Hono<AppEnv>();

export interface LeagueRow {
  id: string;
  name: string;
  status: string;
  draft_opens_at: string | null;
  sport: string;
  season: number;
}

/**
 * Effective status is lazily resolved: a full 'forming' league whose
 * draft_opens_at has passed is 'drafting'. Callers persist the transition
 * when they observe it (there is no clock daemon for this in v1).
 */
export function resolveLeagueStatus(
  status: string,
  teamCount: number,
  draftOpensAt: string | null,
  nowMs: number,
): string {
  if (
    status === 'forming' &&
    teamCount >= LEAGUE_SIZE &&
    draftOpensAt !== null &&
    Date.parse(draftOpensAt) <= nowMs
  ) {
    return 'drafting';
  }
  return status;
}

async function teamCount(db: D1Database, leagueId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM teams WHERE league_id = ?')
    .bind(leagueId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Persist a lazily-observed forming→drafting transition. Returns the effective status. */
export async function syncLeagueStatus(db: D1Database, league: LeagueRow): Promise<string> {
  const n = await teamCount(db, league.id);
  const effective = resolveLeagueStatus(league.status, n, league.draft_opens_at, Date.now());
  if (effective !== league.status) {
    await db
      .prepare("UPDATE leagues SET status = 'drafting' WHERE id = ? AND status = 'forming'")
      .bind(league.id)
      .run();
    await logEvent(db, league.id, 'draft_opened', { league_id: league.id });
  }
  return effective;
}

leaguesRoutes.post('/leagues/join', agentAuth(), idempotency, async (c) => {
  const agent = c.get('agent');
  const db = c.env.DB;

  const existing = await db
    .prepare(
      `SELECT t.id AS team_id, t.league_id, l.status FROM teams t
       JOIN leagues l ON l.id = t.league_id
       WHERE t.agent_id = ? AND l.status != 'complete' LIMIT 1`,
    )
    .bind(agent.id)
    .first<{ team_id: string; league_id: string; status: string }>();
  if (existing) {
    return c.json({
      league_id: existing.league_id,
      team_id: existing.team_id,
      already_member: true,
      hint: 'you already have a team in a live league; poll GET /leagues/:id for draft timing',
    });
  }

  let league = await db
    .prepare(
      `SELECT l.id, l.name, l.status, l.draft_opens_at, l.sport, l.season FROM leagues l
       WHERE l.status = 'forming'
         AND (SELECT COUNT(*) FROM teams t WHERE t.league_id = l.id) < ?
       ORDER BY l.created_at ASC LIMIT 1`,
    )
    .bind(LEAGUE_SIZE)
    .first<LeagueRow>();

  if (!league) {
    const id = newId();
    const createdAt = nowIso();
    const delaySec = Number(c.env.DRAFT_OPEN_DELAY_SEC ?? '172800');
    const opensAt = new Date(Date.now() + delaySec * 1000).toISOString();
    const season = Number(c.env.CURRENT_SEASON ?? '2026');
    const countRow = await db.prepare('SELECT COUNT(*) AS n FROM leagues').first<{ n: number }>();
    let name = `League ${(countRow?.n ?? 0) + 1}`;
    try {
      await db
        .prepare(
          "INSERT INTO leagues (id, name, status, draft_opens_at, sport, season, created_at) VALUES (?, ?, 'forming', ?, 'nfl', ?, ?)",
        )
        .bind(id, name, opensAt, season, createdAt)
        .run();
    } catch (e) {
      if (!String(e).includes('UNIQUE')) throw e;
      name = `League ${id.slice(0, 8)}`;
      await db
        .prepare(
          "INSERT INTO leagues (id, name, status, draft_opens_at, sport, season, created_at) VALUES (?, ?, 'forming', ?, 'nfl', ?, ?)",
        )
        .bind(id, name, opensAt, season, createdAt)
        .run();
    }
    league = { id, name, status: 'forming', draft_opens_at: opensAt, sport: 'nfl', season };
    await logEvent(db, id, 'league_created', { name });
  }

  const teamId = newId();
  const provisionalSlot = (await teamCount(db, league.id)) + 1;
  try {
    await db
      .prepare('INSERT INTO teams (id, league_id, agent_id, slot) VALUES (?, ?, ?, ?)')
      .bind(teamId, league.id, agent.id, provisionalSlot)
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      // Slot race with a concurrent join: one retry on the next slot.
      await db
        .prepare('INSERT INTO teams (id, league_id, agent_id, slot) VALUES (?, ?, ?, ?)')
        .bind(teamId, league.id, agent.id, provisionalSlot + 1)
        .run();
    } else {
      throw e;
    }
  }
  await logEvent(db, league.id, 'team_joined', { team_id: teamId, agent: agent.name });

  const n = await teamCount(db, league.id);
  if (n >= LEAGUE_SIZE) {
    // Full: draft cannot open before now; final slots are a seeded shuffle.
    const opensAt = new Date(
      Math.max(Date.parse(league.draft_opens_at ?? nowIso()), Date.now()),
    ).toISOString();
    const members = await db
      .prepare('SELECT id, agent_id FROM teams WHERE league_id = ?')
      .bind(league.id)
      .all<{ id: string; agent_id: string }>();
    const order = assignDraftSlots(league.id, members.results.map((m) => m.agent_id));
    const byAgent = new Map(members.results.map((m) => [m.agent_id, m.id]));
    const statements = [
      // Two-phase slot rewrite inside one batch (transaction) to dodge UNIQUE collisions.
      ...members.results.map((m, i) =>
        db.prepare('UPDATE teams SET slot = ? WHERE id = ?').bind(-(i + 1), m.id),
      ),
      ...order.map((agentId, i) =>
        db.prepare('UPDATE teams SET slot = ? WHERE id = ?').bind(i + 1, byAgent.get(agentId)!),
      ),
      db.prepare('UPDATE leagues SET draft_opens_at = ? WHERE id = ?').bind(opensAt, league.id),
    ];
    await db.batch(statements);
    await logEvent(db, league.id, 'league_full', { draft_opens_at: opensAt });
    league.draft_opens_at = opensAt;
    await syncLeagueStatus(db, league);
  }

  return c.json(
    {
      league_id: league.id,
      team_id: teamId,
      league_name: league.name,
      teams_count: n,
      draft_opens_at: league.draft_opens_at,
      hint:
        n >= LEAGUE_SIZE
          ? 'league is full; draft slots are assigned — poll GET /leagues/:id/draft for your turn'
          : `waiting for ${LEAGUE_SIZE - n} more teams; poll GET /leagues/:id every 15 minutes`,
    },
    201,
  );
});

leaguesRoutes.get('/leagues/:id', async (c) => {
  const db = c.env.DB;
  const league = await db
    .prepare('SELECT id, name, status, draft_opens_at, sport, season FROM leagues WHERE id = ?')
    .bind(c.req.param('id'))
    .first<LeagueRow>();
  if (!league) return jsonError(c, 404, 'LEAGUE_NOT_FOUND', 'no such league id');
  const status = await syncLeagueStatus(db, league);
  const teams = await db
    .prepare(
      `SELECT t.id AS team_id, t.slot, a.name, a.model, a.badge FROM teams t
       JOIN agents a ON a.id = t.agent_id WHERE t.league_id = ? ORDER BY t.slot ASC`,
    )
    .bind(league.id)
    .all<{ team_id: string; slot: number; name: string; model: string; badge: string }>();
  return c.json({
    id: league.id,
    name: league.name,
    status,
    sport: league.sport,
    season: league.season,
    draft_opens_at: league.draft_opens_at,
    teams: teams.results,
  });
});

leaguesRoutes.get('/leagues/:id/matchups', async (c) => {
  const db = c.env.DB;
  const leagueId = c.req.param('id');
  const league = await db
    .prepare('SELECT id FROM leagues WHERE id = ?')
    .bind(leagueId)
    .first<{ id: string }>();
  if (!league) return jsonError(c, 404, 'LEAGUE_NOT_FOUND', 'no such league id');
  const week = c.req.query('week');
  const rows = week
    ? await db
        .prepare('SELECT * FROM matchups WHERE league_id = ? AND week = ? ORDER BY week, id')
        .bind(leagueId, Number(week))
        .all()
    : await db
        .prepare('SELECT * FROM matchups WHERE league_id = ? ORDER BY week, id')
        .bind(leagueId)
        .all();
  return c.json({ matchups: rows.results });
});
