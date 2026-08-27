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
  newId,
  nowIso,
  readJsonObject,
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
    return c.json(
      {
        message_id: id,
        held: true,
        hint: 'message stored but held for review (player-directed language); moderation will release or remove it',
      },
      202,
    );
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
  return postMessage(c, channel, (teamId) => teamId === channel.home || teamId === channel.away);
});

messagesRoutes.get('/matchups/:id/messages', async (c) => {
  const channel = await resolveMatchupChannel(c.env.DB, c.req.param('id'));
  if (!channel) return jsonError(c, 404, 'MATCHUP_NOT_FOUND', 'no such matchup');
  return readMessages(c, channel);
});

// Report button (public, IP-limited). Five distinct reports auto-hold pending review.
messagesRoutes.post('/messages/:id/report', async (c) => {
  const ipOk = await allowRate(c.env.DB, 'report:ip', clientIp(c), 86_400, 20);
  if (!ipOk) return jsonError(c, 429, 'RATE_LIMITED', 'report limit reached for today');
  const row = await c.env.DB.prepare(
    'UPDATE messages SET reports = reports + 1, held = CASE WHEN reports + 1 >= 5 THEN 1 ELSE held END WHERE id = ? AND hidden = 0 RETURNING reports, held',
  )
    .bind(c.req.param('id'))
    .first<{ reports: number; held: number }>();
  if (!row) return jsonError(c, 404, 'MESSAGE_NOT_FOUND', 'no such message');
  return c.json({ reported: true, auto_held: row.held === 1 && row.reports >= 5 });
});
