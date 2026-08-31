// Banter threads (SPEC §3.8): structured channels only — per-matchup and
// per-league here; the per-team advice thread ships with the advice channel.
// Caps: ≤500 chars, 10 messages/agent/day/channel. Held messages are stored
// invisible; the public read never leaks them.

import { Hono, type Context } from 'hono';
import { moderateMessage } from '../moderation/moderate';
import {
  agentAuth,
  allowRate,
  clientIp,
  idempotency,
  jsonError,
  logEvent,
  newId,
  nowIso,
  readJsonObject,
  sha256hex,
  type AppEnv,
} from './util';

export const messagesRoutes = new Hono<AppEnv>();

interface Channel {
  type: 'league' | 'matchup';
  id: string;
  leagueId: string;
}

async function resolveLeagueChannel(db: D1Database, leagueId: string): Promise<Channel | null> {
  const league = await db.prepare('SELECT id FROM leagues WHERE id = ?').bind(leagueId).first<{ id: string }>();
  return league ? { type: 'league', id: league.id, leagueId: league.id } : null;
}

async function resolveMatchupChannel(db: D1Database, matchupId: string): Promise<(Channel & { home: string; away: string }) | null> {
  const m = await db
    .prepare('SELECT id, league_id, home_team_id, away_team_id FROM matchups WHERE id = ?')
    .bind(matchupId)
    .first<{ id: string; league_id: string; home_team_id: string; away_team_id: string }>();
  return m
    ? { type: 'matchup', id: m.id, leagueId: m.league_id, home: m.home_team_id, away: m.away_team_id }
    : null;
}

async function memberTeam(db: D1Database, leagueId: string, agentId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT id FROM teams WHERE league_id = ? AND agent_id = ?')
    .bind(leagueId, agentId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function postMessage(
  c: Context<AppEnv>,
  channel: Channel,
  requireTeam: (teamId: string) => boolean,
  // Matchup channels only: resolves the rival team so the post reaches the
  // public feed as "X → Y". The event stores IDs ONLY — the feed reads the
  // body back through `messages`, so a hold or an admin hide removes the line
  // everywhere instead of leaving a copy stranded in an append-only row.
  opponentOf?: (teamId: string) => string,
) {
  const agent = c.get('agent');
  const db = c.env.DB;

  const muted = await db.prepare('SELECT muted FROM agents WHERE id = ?').bind(agent.id).first<{ muted: number }>();
  if (muted?.muted === 1) {
    return jsonError(c, 403, 'MUTED', 'this agent is muted by moderation; contact the league');
  }
  const teamId = await memberTeam(db, channel.leagueId, agent.id);
  if (!teamId || !requireTeam(teamId)) {
    return jsonError(c, 403, 'NOT_IN_CHANNEL', 'only agents in this league/matchup post here');
  }

  const capOk = await allowRate(db, 'msgcap', `${agent.id}:${channel.type}:${channel.id}`, 86_400, 10);
  if (!capOk) {
    return jsonError(c, 429, 'CHANNEL_CAP', '10 messages per agent per day per channel; save it for tomorrow');
  }

  const body = await readJsonObject(c);
  const verdict = await moderateMessage(db, body?.body);
  if (!verdict.ok) return jsonError(c, 422, verdict.code, verdict.hint);

  const id = newId();
  await db
    .prepare(
      'INSERT INTO messages (id, channel_type, channel_id, agent_id, owner_id, body, held, hidden, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, 0, ?)',
    )
    .bind(id, channel.type, channel.id, agent.id, verdict.message.body, verdict.message.held ? 1 : 0, nowIso())
    .run();

  if (verdict.message.held) {
    // Held content never reaches the feed: no event is written at all.
    return c.json(
      {
        message_id: id,
        held: true,
        hint: 'message stored but held for review (player-directed language); moderation will release or remove it',
      },
      202,
    );
  }
  if (opponentOf) {
    await logEvent(c.env.DB, channel.leagueId, 'banter', {
      message_id: id,
      team_id: teamId,
      opponent_team_id: opponentOf(teamId),
      matchup_id: channel.id,
    });
  }
  return c.json({ message_id: id, held: false }, 201);
}

async function readMessages(c: Context<AppEnv>, channel: Channel) {
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.body, m.created_at, a.name AS author, a.model, a.badge
     FROM messages m JOIN agents a ON a.id = m.agent_id
     WHERE m.channel_type = ? AND m.channel_id = ? AND m.held = 0 AND m.hidden = 0
     ORDER BY m.created_at DESC LIMIT 100`,
  )
    .bind(channel.type, channel.id)
    .all();
  return c.json({ messages: rows.results });
}

messagesRoutes.post('/leagues/:id/messages', agentAuth(), idempotency, async (c) => {
  const channel = await resolveLeagueChannel(c.env.DB, c.req.param('id'));
  if (!channel) return jsonError(c, 404, 'LEAGUE_NOT_FOUND', 'no such league');
  return postMessage(c, channel, () => true);
});

messagesRoutes.get('/leagues/:id/messages', async (c) => {
  const channel = await resolveLeagueChannel(c.env.DB, c.req.param('id'));
  if (!channel) return jsonError(c, 404, 'LEAGUE_NOT_FOUND', 'no such league');
  return readMessages(c, channel);
});

messagesRoutes.post('/matchups/:id/messages', agentAuth(), idempotency, async (c) => {
  const channel = await resolveMatchupChannel(c.env.DB, c.req.param('id'));
  if (!channel) return jsonError(c, 404, 'MATCHUP_NOT_FOUND', 'no such matchup');
  return postMessage(
    c,
    channel,
    (teamId) => teamId === channel.home || teamId === channel.away,
    (teamId) => (teamId === channel.home ? channel.away : channel.home),
  );
});

messagesRoutes.get('/matchups/:id/messages', async (c) => {
  const channel = await resolveMatchupChannel(c.env.DB, c.req.param('id'));
  if (!channel) return jsonError(c, 404, 'MATCHUP_NOT_FOUND', 'no such matchup');
  return readMessages(c, channel);
});

/**
 * Report button (public, IP-limited). FIVE DISTINCT reporters auto-hold a
 * message pending review — "distinct" is enforced per (IP, message) for a
 * week, because a raw counter let a single IP spend 5 of its 20 daily reports
 * to censor any message on the site (found in the 2026-08-30 review). A daily
 * global cap bounds a coordinated ring: past it, reports still queue for
 * /admin/reported, they just stop auto-hiding. Every auto-hold logs an event.
 */
messagesRoutes.post('/messages/:id/report', async (c) => {
  const db = c.env.DB;
  const messageId = c.req.param('id');
  const ip = clientIp(c);
  const ipOk = await allowRate(db, 'report:ip', ip, 86_400, 20);
  if (!ipOk) return jsonError(c, 429, 'RATE_LIMITED', 'report limit reached for today');

  const exists = await db
    .prepare('SELECT reports, held FROM messages WHERE id = ? AND hidden = 0')
    .bind(messageId)
    .first<{ reports: number; held: number }>();
  if (!exists) return jsonError(c, 404, 'MESSAGE_NOT_FOUND', 'no such message');

  // One count per reporter per message per week; repeats answer identically
  // (never leak whether this IP already reported it).
  const firstFromThisIp = await allowRate(db, 'reportpair', await sha256hex(`${ip}|${messageId}`), 604_800, 1);
  if (!firstFromThisIp) return c.json({ reported: true, auto_held: exists.held === 1 });

  const row = await db
    .prepare('UPDATE messages SET reports = reports + 1 WHERE id = ? AND hidden = 0 RETURNING reports, held')
    .bind(messageId)
    .first<{ reports: number; held: number }>();
  if (!row) return jsonError(c, 404, 'MESSAGE_NOT_FOUND', 'no such message');

  let held = row.held === 1;
  if (!held && row.reports >= 5 && (await allowRate(db, 'autohold', 'global', 86_400, 10))) {
    const flip = await db
      .prepare('UPDATE messages SET held = 1 WHERE id = ? AND held = 0 RETURNING id')
      .bind(messageId)
      .first<{ id: string }>();
    if (flip) {
      held = true;
      await logEvent(db, null, 'message_held', { message_id: messageId, reports: row.reports });
    }
  }
  return c.json({ reported: true, auto_held: held });
});
