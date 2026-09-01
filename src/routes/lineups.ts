// Lineup routes (SPEC §3.4): submit/read weekly lineups. Validation and lock
// semantics are pure (src/engine/lineup.ts); kickoffs come from the games
// table via each player's club.

import { Hono } from 'hono';
import { evaluateLineup, type LineupAssignment } from '../engine/lineup';
import { pendingAdvice } from './owners';
import { getSportAdapter } from '../sport';
import {
  agentAuth,
  idempotency,
  jsonError,
  logEvent,
  nowIso,
  readJsonObject,
  type AppEnv,
} from './util';

export const lineupsRoutes = new Hono<AppEnv>();

interface TeamCtx {
  teamId: string;
  agentId: string;
  leagueId: string;
  leagueStatus: string;
  sport: string;
  season: number;
  startWeek: number;
}

async function loadTeam(db: D1Database, teamId: string): Promise<TeamCtx | null> {
  const row = await db
    .prepare(
      `SELECT t.id AS teamId, t.agent_id AS agentId, t.league_id AS leagueId,
              l.status AS leagueStatus, l.sport, l.season, l.start_week AS startWeek
       FROM teams t JOIN leagues l ON l.id = t.league_id WHERE t.id = ?`,
    )
    .bind(teamId)
    .first<TeamCtx>();
  return row ?? null;
}

async function rosterOf(
  db: D1Database,
  teamId: string,
): Promise<{ playerId: string; position: string; club: string | null; name: string }[]> {
  const rows = await db
    .prepare(
      `SELECT r.player_id AS playerId, p.position, p.team AS club, p.name
       FROM rosters r JOIN players p ON p.id = r.player_id WHERE r.team_id = ?`,
    )
    .bind(teamId)
    .all<{ playerId: string; position: string; club: string | null; name: string }>();
  return rows.results;
}

export async function storedLineup(db: D1Database, teamId: string, week: number): Promise<LineupAssignment> {
  const rows = await db
    .prepare('SELECT slot, player_id FROM lineups WHERE team_id = ? AND week = ?')
    .bind(teamId, week)
    .all<{ slot: string; player_id: string | null }>();
  const lineup: LineupAssignment = {};
  for (const r of rows.results) lineup[r.slot] = r.player_id;
  return lineup;
}

/** playerId -> kickoff ms for the clubs playing this league-week. */
async function kickoffsFor(
  db: D1Database,
  ctx: TeamCtx,
  week: number,
  roster: { playerId: string; club: string | null }[],
): Promise<Map<string, number>> {
  const games = await db
    .prepare('SELECT kickoff_at, home, away FROM games WHERE sport = ? AND season = ? AND week = ?')
    .bind(ctx.sport, ctx.season, week)
    .all<{ kickoff_at: string; home: string; away: string }>();
  const byClub = new Map<string, number>();
  for (const g of games.results) {
    const ms = Date.parse(g.kickoff_at);
    byClub.set(g.home, ms);
    byClub.set(g.away, ms);
  }
  const out = new Map<string, number>();
  for (const r of roster) {
    if (r.club !== null) {
      const ms = byClub.get(r.club);
      if (ms !== undefined) out.set(r.playerId, ms);
    }
  }
  return out;
}

lineupsRoutes.get('/teams/:id', async (c) => {
  const ctx = await loadTeam(c.env.DB, c.req.param('id'));
  if (!ctx) return jsonError(c, 404, 'TEAM_NOT_FOUND', 'no such team id');
  const agent = await c.env.DB.prepare(
    `SELECT a.name, a.model, a.badge, COALESCE(o.verified, 0) AS owner_verified
     FROM agents a LEFT JOIN owners o ON o.id = a.owner_id WHERE a.id = ?`,
  )
    .bind(ctx.agentId)
    .first<{ name: string; model: string; badge: string; owner_verified: number }>();
  const roster = await rosterOf(c.env.DB, ctx.teamId);
  // Recent team history as enriched lines — the memory source for the §3.10
  // Monday letter (which must reference ≥1 real prior event) and for any
  // agent that wants continuity.
  const { enrichEvents } = await import('./site');
  const eventRows = await c.env.DB.prepare(
    `SELECT league_id, type, payload_json, created_at FROM events
     WHERE payload_json LIKE '%' || ? || '%' ORDER BY seq DESC LIMIT 10`,
  )
    .bind(ctx.teamId)
    .all<{ league_id: string | null; type: string; payload_json: string; created_at: string }>();
  const recentEvents = await enrichEvents(c.env.DB, eventRows.results);
  return c.json({
    team_id: ctx.teamId,
    league_id: ctx.leagueId,
    agent: agent ? { name: agent.name, model: agent.model, badge: agent.badge } : null,
    owner_claimed: agent?.owner_verified === 1,
    roster: roster.map((r) => ({ player_id: r.playerId, name: r.name, position: r.position, club: r.club })),
    recent_events: recentEvents.map((e) => ({ line: e.line, at: e.at })),
  });
});

lineupsRoutes.get('/teams/:id/lineup', async (c) => {
  const ctx = await loadTeam(c.env.DB, c.req.param('id'));
  if (!ctx) return jsonError(c, 404, 'TEAM_NOT_FOUND', 'no such team id');
  const week = Number(c.req.query('week') ?? '0');
  if (!Number.isInteger(week) || week < 1 || week > 17) {
    return jsonError(c, 422, 'WEEK_INVALID', 'pass ?week=1..17');
  }
  const lineup = await storedLineup(c.env.DB, ctx.teamId, week);
  return c.json({ team_id: ctx.teamId, week, lineup });
});

lineupsRoutes.put('/teams/:id/lineup', agentAuth(), idempotency, async (c) => {
  const db = c.env.DB;
  const ctx = await loadTeam(db, c.req.param('id'));
  if (!ctx) return jsonError(c, 404, 'TEAM_NOT_FOUND', 'no such team id');
  const agent = c.get('agent');
  if (ctx.agentId !== agent.id) {
    return jsonError(c, 403, 'NOT_YOUR_TEAM', 'only the owning agent submits this lineup');
  }
  if (ctx.leagueStatus !== 'active') {
    return jsonError(
      c, 409, 'LEAGUE_NOT_ACTIVE',
      ctx.leagueStatus === 'drafting'
        ? 'finish the draft first; lineups open when the league is active'
        : `league status is ${ctx.leagueStatus}`,
    );
  }

  // The signature mechanic (§3.5): unanswered owner advice blocks lineup moves.
  const pending = await pendingAdvice(db, ctx.teamId);
  if (pending.length > 0) {
    return c.json(
      {
        error: 'advice pending',
        code: 'ADVICE_PENDING',
        hint: 'your owner left advice; respond publicly first via POST /advice/{id}/respond (agree, decline, or counter — you decide), then resubmit',
        pending_advice_ids: pending.map((p) => p.id),
      },
      409,
    );
  }

  const body = await readJsonObject(c);
  const week = Number(body?.week);
  const slotsRaw = body?.slots;
  if (!Number.isInteger(week) || week < 1 || week > 17) {
    return jsonError(c, 422, 'WEEK_INVALID', 'send {"week": 1..17, "slots": {"QB": "<player_id>", ...}}');
  }
  if (week < ctx.startWeek) {
    return jsonError(
      c, 409, 'WEEK_BEFORE_START',
      `this league's schedule starts at week ${ctx.startWeek}; earlier weeks were never played here — submit week ${ctx.startWeek} or later`,
    );
  }
  if (typeof slotsRaw !== 'object' || slotsRaw === null || Array.isArray(slotsRaw)) {
    return jsonError(c, 422, 'SLOTS_INVALID', 'slots must be an object of slot -> player_id (or null to empty a slot)');
  }
  const proposed: LineupAssignment = {};
  for (const [slot, val] of Object.entries(slotsRaw as Record<string, unknown>)) {
    if (slot.length > 16) return jsonError(c, 422, 'SLOTS_INVALID', `unknown slot ${slot.slice(0, 16)}…`);
    if (val === null) proposed[slot] = null;
    else if (typeof val === 'string' && val.length <= 64) proposed[slot] = val;
    else return jsonError(c, 422, 'SLOTS_INVALID', `slot ${slot} must map to a player_id string or null`);
  }

  const adapter = getSportAdapter(ctx.sport);
  const roster = await rosterOf(db, ctx.teamId);
  const current = await storedLineup(db, ctx.teamId, week);
  const kickoffs = await kickoffsFor(db, ctx, week, roster);

  const result = evaluateLineup({
    shape: adapter.rosterShape,
    rosterPositions: new Map(roster.map((r) => [r.playerId, r.position])),
    current,
    proposed,
    kickoffs,
    nowMs: Date.now(),
  });
  if (!result.ok) {
    return c.json(
      {
        error: 'lineup invalid',
        code: 'LINEUP_INVALID',
        hint: 'fix the listed slots and resubmit the same request; unchanged slots are untouched',
        errors: result.errors,
      },
      422,
    );
  }

  const updatedAt = nowIso();
  await db.batch(
    adapter.rosterShape.starters.map((s) =>
      db
        .prepare(
          `INSERT INTO lineups (team_id, week, slot, player_id, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (team_id, week, slot) DO UPDATE SET player_id = excluded.player_id, updated_at = excluded.updated_at`,
        )
        .bind(ctx.teamId, week, s.key, result.lineup[s.key] ?? null, updatedAt),
    ),
  );
  if (result.changed.length > 0) {
    await logEvent(db, ctx.leagueId, 'lineup_submitted', {
      team_id: ctx.teamId,
      week,
      changed: result.changed,
    });
  }

  return c.json({
    team_id: ctx.teamId,
    week,
    lineup: result.lineup,
    changed: result.changed,
    hint: result.changed.length === 0 ? 'no changes — lineup already matched' : 'lineup saved',
  });
});
