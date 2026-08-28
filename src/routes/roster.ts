// Free agency routes (SPEC §3.4): POST /teams/:id/moves — first-come add/drop,
// 2 moves/agent/day, roster stays at 12 — and the public availability read
// agents use to find candidates. Validation is pure (engine/freeagency.ts).

import { Hono } from 'hono';
import { validateMove } from '../engine/freeagency';
import { getSportAdapter } from '../sport';
import {
  agentAuth,
  allowRate,
  idempotency,
  jsonError,
  logEvent,
  nowIso,
  readJsonObject,
  type AppEnv,
} from './util';

export const rosterRoutes = new Hono<AppEnv>();

interface TeamRow {
  teamId: string;
  agentId: string;
  leagueId: string;
  leagueStatus: string;
  sport: string;
  season: number;
}

rosterRoutes.get('/leagues/:id/available', async (c) => {
  const db = c.env.DB;
  const league = await db
    .prepare('SELECT id, sport FROM leagues WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ id: string; sport: string }>();
  if (!league) return jsonError(c, 404, 'LEAGUE_NOT_FOUND', 'no such league id');
  const adapter = getSportAdapter(league.sport);
  const position = c.req.query('position') ?? null;
  if (position !== null && !adapter.positions.includes(position)) {
    return jsonError(c, 422, 'POSITION_INVALID', `pass position=${adapter.positions.join('|')} or omit it`);
  }
  const limitRaw = Number(c.req.query('limit') ?? '25');
  const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 25;
  const rows = await db
    .prepare(
      `SELECT b.player_id, p.name, p.position, p.team AS club, b.adp
       FROM adp_board b JOIN players p ON p.id = b.player_id
       WHERE b.sport = ? AND (? IS NULL OR p.position = ?)
         AND b.player_id NOT IN (
           SELECT r.player_id FROM rosters r JOIN teams t ON t.id = r.team_id WHERE t.league_id = ?
         )
       ORDER BY b.adp ASC LIMIT ?`,
    )
    .bind(league.sport, position, position, league.id, limit)
    .all<{ player_id: string; name: string; position: string; club: string | null; adp: number }>();
  return c.json({
    league_id: league.id,
    players: rows.results,
    meta: { pool: 'draft board, unrostered in this league', hint: 'add one via POST /teams/{team_id}/moves {"add", "drop"}' },
  });
});

rosterRoutes.post('/teams/:id/moves', agentAuth(), idempotency, async (c) => {
  const db = c.env.DB;
  const team = await db
    .prepare(
      `SELECT t.id AS teamId, t.agent_id AS agentId, t.league_id AS leagueId,
              l.status AS leagueStatus, l.sport, l.season
       FROM teams t JOIN leagues l ON l.id = t.league_id WHERE t.id = ?`,
    )
    .bind(c.req.param('id'))
    .first<TeamRow>();
  if (!team) return jsonError(c, 404, 'TEAM_NOT_FOUND', 'no such team id');
  const agent = c.get('agent');
  if (team.agentId !== agent.id) {
    return jsonError(c, 403, 'NOT_YOUR_TEAM', 'only the owning agent makes roster moves');
  }
  if (team.leagueStatus !== 'active') {
    return jsonError(
      c, 409, 'LEAGUE_NOT_ACTIVE',
      team.leagueStatus === 'drafting'
        ? 'free agency opens when the draft completes'
        : `league status is ${team.leagueStatus}`,
    );
  }

  const body = await readJsonObject(c);
  const addId = typeof body?.add === 'string' && body.add.length <= 64 ? body.add : null;
  const dropId = typeof body?.drop === 'string' && body.drop.length <= 64 ? body.drop : null;
  if (!addId || !dropId) {
    return jsonError(c, 422, 'MOVE_INVALID', 'send {"add": "<player_id>", "drop": "<player_id>"} — one for one, roster stays at 12');
  }

  const roster = await db
    .prepare('SELECT player_id, acquired_via, acquired_at FROM rosters WHERE team_id = ?')
    .bind(team.teamId)
    .all<{ player_id: string; acquired_via: string; acquired_at: string }>();
  const positions = await db
    .prepare(
      `SELECT id, position FROM players WHERE id IN (${roster.results.map(() => '?').join(',')}, ?)`,
    )
    .bind(...roster.results.map((r) => r.player_id), addId)
    .all<{ id: string; position: string }>();
  const positionOf = new Map(positions.results.map((p) => [p.id, p.position]));
  const addRostered = await db
    .prepare(
      'SELECT 1 AS x FROM rosters r JOIN teams t ON t.id = r.team_id WHERE t.league_id = ? AND r.player_id = ? LIMIT 1',
    )
    .bind(team.leagueId, addId)
    .first<{ x: number }>();

  // Locks: players occupying a kicked-off slot of the earliest unsettled week.
  const currentWeek = await db
    .prepare('SELECT MIN(week) AS w FROM matchups WHERE league_id = ? AND settled_at IS NULL')
    .bind(team.leagueId)
    .first<{ w: number | null }>();
  const week = currentWeek?.w ?? null;
  const locked = new Set<string>();
  if (week !== null) {
    const rows = await db
      .prepare(
        `SELECT lu.player_id FROM lineups lu
         JOIN rosters r ON r.team_id = lu.team_id AND r.player_id = lu.player_id
         JOIN players p ON p.id = lu.player_id
         JOIN games g ON g.sport = ? AND g.season = ? AND g.week = ? AND (g.home = p.team OR g.away = p.team)
         WHERE lu.team_id = ? AND lu.week = ? AND lu.player_id IS NOT NULL AND g.kickoff_at <= ?`,
      )
      .bind(team.sport, team.season, week, team.teamId, week, nowIso())
      .all<{ player_id: string }>();
    for (const r of rows.results) locked.add(r.player_id);
  }

  const adapter = getSportAdapter(team.sport);
  const verdict = validateMove({
    rosterPositions: new Map(roster.results.map((r) => [r.player_id, positionOf.get(r.player_id) ?? '?'])),
    addId,
    addPosition: positionOf.get(addId) ?? null,
    addRosteredInLeague: addRostered !== null,
    dropId,
    lockedPlayerIds: locked,
    allowedPositions: adapter.positions,
  });
  if (!verdict.ok) {
    const status = verdict.code === 'PLAYER_TAKEN' || verdict.code === 'PLAYER_LOCKED' ? 409 : 422;
    return jsonError(c, status, verdict.code, verdict.hint);
  }

  const capOk = await allowRate(db, 'fa', team.teamId, 86_400, 2);
  if (!capOk) return jsonError(c, 429, 'FA_CAP', '2 roster moves per day; the wire reopens tomorrow');

  const dropRow = roster.results.find((r) => r.player_id === dropId)!;
  const now = nowIso();
  // The INSERT re-checks league-wide availability atomically — the losing side
  // of a same-player race inserts 0 rows and is compensated below.
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO rosters (team_id, player_id, acquired_via, acquired_at)
         SELECT ?, ?, 'fa', ?
         WHERE NOT EXISTS (
           SELECT 1 FROM rosters r JOIN teams t ON t.id = r.team_id
           WHERE t.league_id = ? AND r.player_id = ?
         )`,
      )
      .bind(team.teamId, addId, now, team.leagueId, addId),
    db.prepare('DELETE FROM rosters WHERE team_id = ? AND player_id = ?').bind(team.teamId, dropId),
    // Clear the dropped player from every unsettled week's lineup (locked slots
    // were refused above; settled weeks are history and stay untouched).
    ...(week !== null
      ? [
          db
            .prepare('UPDATE lineups SET player_id = NULL, updated_at = ? WHERE team_id = ? AND player_id = ? AND week >= ?')
            .bind(now, team.teamId, dropId, week),
        ]
      : []),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0) {
    // Lost the race after validation: restore the dropped player exactly.
    await db
      .prepare('INSERT OR IGNORE INTO rosters (team_id, player_id, acquired_via, acquired_at) VALUES (?, ?, ?, ?)')
      .bind(team.teamId, dropRow.player_id, dropRow.acquired_via, dropRow.acquired_at)
      .run();
    return jsonError(c, 409, 'PLAYER_TAKEN', 'another team signed that player first; pick another from GET /leagues/{id}/available');
  }

  await logEvent(db, team.leagueId, 'fa_move', { team_id: team.teamId, player_id: addId, dropped_id: dropId });
  const names = await db
    .prepare('SELECT id, name, position FROM players WHERE id IN (?, ?)')
    .bind(addId, dropId)
    .all<{ id: string; name: string; position: string }>();
  const byId = new Map(names.results.map((n) => [n.id, n]));
  return c.json(
    {
      added: { player_id: addId, name: byId.get(addId)?.name, position: byId.get(addId)?.position },
      dropped: { player_id: dropId, name: byId.get(dropId)?.name, position: byId.get(dropId)?.position },
      hint: 'roster updated; empty lineup slots refill via PUT /teams/{id}/lineup',
    },
    201,
  );
});
