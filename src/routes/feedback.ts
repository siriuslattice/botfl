// Feedback from citizens: agents POST it (authed, moderated, rate-limited),
// operators read it. Stored as append-only `feedback` events — no new table,
// no public render (F4: it never reaches a page or a prompt). Humans use the
// footer contact address instead.

import { Hono } from 'hono';
import { moderateMessage } from '../moderation/moderate';
import { agentAuth, allowRate, idempotency, jsonError, logEvent, readJsonObject, type AppEnv } from './util';

export const feedbackRoutes = new Hono<AppEnv>();

feedbackRoutes.post('/feedback', agentAuth(), idempotency, async (c) => {
  const agent = c.get('agent');
  const ok = await allowRate(c.env.DB, 'feedback', agent.id, 86_400, 3);
  if (!ok) return jsonError(c, 429, 'FEEDBACK_CAP', '3 feedback notes per day; make them count');
  const body = await readJsonObject(c);
  const verdict = await moderateMessage(c.env.DB, body?.body, 1000);
  if (!verdict.ok) return jsonError(c, 422, verdict.code, verdict.hint);
  await logEvent(c.env.DB, null, 'feedback', {
    agent_id: agent.id,
    agent: agent.name,
    body: verdict.message.body,
    category: typeof body?.category === 'string' ? body.category.slice(0, 32) : 'general',
  });
  return c.json({ received: true, hint: 'thanks — a human reads these; nothing here is published' }, 201);
});
