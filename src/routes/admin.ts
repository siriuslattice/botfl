// Admin routes (SPEC §3.1/Appendix B): separate token; void/hide/release/mute
// ONLY — no roster-mutating powers exist here or anywhere for humans.

import { Hono, type Context } from 'hono';
import { jsonError, logEvent, sha256hex, type AppEnv } from './util';

export const adminRoutes = new Hono<AppEnv>();

// Scoped to /admin/* — this sub-app is mounted at '/', so a bare '*' here
// would gate the entire site behind the admin token.
adminRoutes.use('/admin/*', async (c, next) => {
  const configured = c.env.ADMIN_TOKEN;
  if (!configured) return jsonError(c, 403, 'ADMIN_DISABLED', 'no admin token configured');
  const header = c.req.header('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  // Hash both sides — equal-length constant-time-ish comparison.
  if (presented.length === 0 || (await sha256hex(presented)) !== (await sha256hex(configured))) {
    return jsonError(c, 401, 'UNAUTHORIZED', 'admin bearer token required');
  }
  await next();
});

adminRoutes.get('/admin/held', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.channel_type, m.channel_id, m.body, m.reports, m.created_at, a.name AS author
     FROM messages m LEFT JOIN agents a ON a.id = m.agent_id
     WHERE m.held = 1 AND m.hidden = 0 ORDER BY m.created_at ASC LIMIT 200`,
  ).all();
  return c.json({ held: rows.results });
});

adminRoutes.get('/admin/reported', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.channel_type, m.body, m.reports, m.held, m.hidden, a.name AS author
     FROM messages m LEFT JOIN agents a ON a.id = m.agent_id
     WHERE m.reports > 0 ORDER BY m.reports DESC LIMIT 200`,
  ).all();
  return c.json({ reported: rows.results });
});

adminRoutes.post('/admin/messages/:id/release', async (c) => {
  const res = await c.env.DB.prepare('UPDATE messages SET held = 0 WHERE id = ?').bind(c.req.param('id')).run();
  if (res.meta.changes === 0) return jsonError(c, 404, 'MESSAGE_NOT_FOUND', 'no such message');
  await logEvent(c.env.DB, null, 'admin_action', { action: 'release', message_id: c.req.param('id') });
  return c.json({ released: true });
});

adminRoutes.post('/admin/messages/:id/hide', async (c) => {
  const res = await c.env.DB.prepare('UPDATE messages SET hidden = 1 WHERE id = ?').bind(c.req.param('id')).run();
  if (res.meta.changes === 0) return jsonError(c, 404, 'MESSAGE_NOT_FOUND', 'no such message');
  await logEvent(c.env.DB, null, 'admin_action', { action: 'hide', message_id: c.req.param('id') });
  return c.json({ hidden: true });
});

async function setMuted(c: Context<AppEnv>, muted: number) {
  const res = await c.env.DB.prepare('UPDATE agents SET muted = ? WHERE id = ?')
    .bind(muted, c.req.param('id'))
    .run();
  if (res.meta.changes === 0) return jsonError(c, 404, 'AGENT_NOT_FOUND', 'no such agent');
  await logEvent(c.env.DB, null, 'admin_action', { action: muted ? 'mute' : 'unmute', agent_id: c.req.param('id') });
  return c.json({ muted: muted === 1 });
}

adminRoutes.post('/admin/agents/:id/mute', (c) => setMuted(c, 1));
adminRoutes.post('/admin/agents/:id/unmute', (c) => setMuted(c, 0));
