// The Wire (SPEC §3.6): read-only canonical data API for agents. Public, no
// auth, ?since= + ETag so 15-minute cron polling stays cheap.

import { Hono, type Context } from 'hono';
import { getSportAdapter } from '../sport';
import type { StatLine } from '../sport/adapter';
import { jsonError, type AppEnv } from './util';

export const wireRoutes = new Hono<AppEnv>();

const ATTRIBUTION = 'data: nflverse (openly licensed community sources)';

type Ctx = Context<AppEnv>;

function parseSince(c: Ctx): string | null | 'bad' {
  const since = c.req.query('since');
  if (since === undefined) return null;
  const ms = Date.parse(since);
  return Number.isNaN(ms) ? 'bad' : new Date(ms).toISOString();
}

function withMeta(rows: unknown[], extra: Record<string, unknown> = {}) {
  return { data: rows, meta: { count: rows.length, attribution: ATTRIBUTION, ...extra } };
}

/** Weak ETag from a scope's freshness marker; If-None-Match hit → 304. */
async function etag(c: Ctx, scopeSql: string, binds: unknown[]): Promise<Response | string> {
  const row = await c.env.DB.prepare(scopeSql).bind(...binds).first<{ mark: string | null; n: number }>();
  const tag = `W/"${row?.mark ?? 'empty'}-${row?.n ?? 0}"`;
  if (c.req.header('if-none-match') === tag) {
    return new Response(null, { status: 304, headers: { etag: tag } });
  }
  return tag;
}

function respond(c: Ctx, tag: string, body: unknown) {
  return c.json(body as Record<string, unknown>, 200, {
    etag: tag,
    'cache-control': 'public, max-age=60',
  });
}

wireRoutes.get('/wire/players', async (c) => {
  const tag = await etag(c, 'SELECT MAX(updated_at) AS mark, COUNT(*) AS n FROM players', []);
  if (tag instanceof Response) return tag;

  const since = parseSince(c);
  if (since === 'bad') return jsonError(c, 422, 'SINCE_INVALID', 'since must be an ISO-8601 timestamp');
  const position = c.req.query('position');
  const q = c.req.query('q');
  const limit = Math.min(Number(c.req.query('limit') ?? '100') || 100, 200);
  const offset = Math.max(Number(c.req.query('offset') ?? '0') || 0, 0);

  const where: string[] = ["sport = 'nfl'"];
  const binds: unknown[] = [];
  if (position) {
    if (!getSportAdapter('nfl').positions.includes(position)) {
      return jsonError(c, 422, 'POSITION_INVALID', `position must be one of ${getSportAdapter('nfl').positions.join(', ')}`);
    }
    where.push('position = ?');
    binds.push(position);
  }
  if (q) {
    if (q.length > 64) return jsonError(c, 422, 'QUERY_TOO_LONG', 'q is capped at 64 chars');
    where.push("name LIKE ? ESCAPE '\\'");
    binds.push(`%${q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
  }
  if (since) {
    where.push('updated_at > ?');
    binds.push(since);
  }
  const rows = await c.env.DB.prepare(
    `SELECT id, name, position, team, status, updated_at FROM players
     WHERE ${where.join(' AND ')} ORDER BY name ASC LIMIT ? OFFSET ?`,
  )
    .bind(...binds, limit, offset)
    .all();
  return respond(c, tag, withMeta(rows.results, { limit, offset }));
});

wireRoutes.get('/wire/injuries', async (c) => {
  const tag = await etag(c, 'SELECT MAX(updated_at) AS mark, COUNT(*) AS n FROM injuries', []);
  if (tag instanceof Response) return tag;
  const since = parseSince(c);
  if (since === 'bad') return jsonError(c, 422, 'SINCE_INVALID', 'since must be an ISO-8601 timestamp');
  const rows = since
    ? await c.env.DB.prepare(
        `SELECT i.player_id, p.name, p.position, p.team, i.status, i.note, i.updated_at
         FROM injuries i JOIN players p ON p.id = i.player_id WHERE i.updated_at > ? ORDER BY i.updated_at DESC LIMIT 500`,
      ).bind(since).all()
    : await c.env.DB.prepare(
        `SELECT i.player_id, p.name, p.position, p.team, i.status, i.note, i.updated_at
         FROM injuries i JOIN players p ON p.id = i.player_id ORDER BY i.updated_at DESC LIMIT 500`,
      ).all();
  return respond(c, tag, withMeta(rows.results));
});

wireRoutes.get('/wire/schedule', async (c) => {
  const season = Number(c.req.query('season') ?? c.env.CURRENT_SEASON ?? '2026');
  const week = c.req.query('week');
  const tag = await etag(
    c,
    'SELECT MAX(kickoff_at) AS mark, COUNT(*) AS n FROM games WHERE season = ?',
    [season],
  );
  if (tag instanceof Response) return tag;
  const rows = week
    ? await c.env.DB.prepare(
        'SELECT id, week, kickoff_at, home, away FROM games WHERE season = ? AND week = ? ORDER BY kickoff_at ASC',
      ).bind(season, Number(week)).all()
    : await c.env.DB.prepare(
        'SELECT id, week, kickoff_at, home, away FROM games WHERE season = ? ORDER BY week ASC, kickoff_at ASC',
      ).bind(season).all();
  return respond(c, tag, withMeta(rows.results, { season }));
});

wireRoutes.get('/wire/stats/:week', async (c) => {
  const week = Number(c.req.param('week'));
  if (!Number.isInteger(week) || week < 1 || week > 18) {
    return jsonError(c, 422, 'WEEK_INVALID', 'week must be 1..18');
  }
  const season = Number(c.req.query('season') ?? c.env.CURRENT_SEASON ?? '2026');
  const tag = await etag(
    c,
    'SELECT MAX(updated_at) AS mark, COUNT(*) AS n FROM stats_weekly WHERE season = ? AND week = ?',
    [season, week],
  );
  if (tag instanceof Response) return tag;
  const adapter = getSportAdapter('nfl');
  const rows = await c.env.DB.prepare(
    `SELECT s.player_id, p.name, p.position, p.team, s.stat_json, s.updated_at
     FROM stats_weekly s JOIN players p ON p.id = s.player_id
     WHERE s.season = ? AND s.week = ? ORDER BY s.player_id ASC`,
  )
    .bind(season, week)
    .all<{ player_id: string; name: string; position: string; team: string; stat_json: string; updated_at: string }>();
  const data = rows.results.map((r) => {
    const stat = JSON.parse(r.stat_json) as StatLine;
    return {
      player_id: r.player_id,
      name: r.name,
      position: r.position,
      team: r.team,
      stats: stat,
      points: adapter.scoreStatLine(stat),
      updated_at: r.updated_at,
    };
  });
  return respond(c, tag, withMeta(data, { season, week, scoring: 'half-ppr' }));
});

wireRoutes.get('/wire/transactions', async (c) => {
  const tag = await etag(c, 'SELECT MAX(occurred_at) AS mark, COUNT(*) AS n FROM transactions', []);
  if (tag instanceof Response) return tag;
  const since = parseSince(c);
  if (since === 'bad') return jsonError(c, 422, 'SINCE_INVALID', 'since must be an ISO-8601 timestamp');
  const rows = since
    ? await c.env.DB.prepare(
        'SELECT id, type, player_id, detail, occurred_at FROM transactions WHERE occurred_at > ? ORDER BY occurred_at DESC LIMIT 200',
      ).bind(since).all()
    : await c.env.DB.prepare(
        'SELECT id, type, player_id, detail, occurred_at FROM transactions ORDER BY occurred_at DESC LIMIT 200',
      ).all();
  return respond(c, tag, withMeta(rows.results));
});

wireRoutes.get('/wire/news', async (c) => {
  const tag = await etag(
    c,
    "SELECT MAX(created_at) AS mark, COUNT(*) AS n FROM events WHERE type = 'news'",
    [],
  );
  if (tag instanceof Response) return tag;
  const rows = await c.env.DB.prepare(
    "SELECT payload_json, created_at FROM events WHERE type = 'news' ORDER BY seq DESC LIMIT 50",
  ).all<{ payload_json: string; created_at: string }>();
  const data = rows.results.map((r) => ({
    ...(JSON.parse(r.payload_json) as Record<string, unknown>),
    at: r.created_at,
  }));
  return respond(c, tag, withMeta(data));
});
