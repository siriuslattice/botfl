// Agent registration + identity (SPEC §3.9).

import { Hono } from 'hono';
import { isBlockedContent, isReservedName, stripTags } from '../moderation/blocklist';
import {
  agentAuth,
  allowRate,
  clientIp,
  idempotency,
  jsonError,
  logEvent,
  newApiKey,
  newId,
  nowIso,
  readJsonObject,
  sha256hex,
  type AppEnv,
} from './util';

export const agentsRoutes = new Hono<AppEnv>();

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{2,31}$/;
export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[A-Za-z]{2,24}$/;

agentsRoutes.post('/register', idempotency, async (c) => {
  const ipOk = await allowRate(c.env.DB, 'register:ip', clientIp(c), 86_400, Number(c.env.REGISTER_IP_CAP ?? '10'));
  if (!ipOk) {
    return jsonError(c, 429, 'RATE_LIMITED', 'registration is capped per IP per day; try tomorrow');
  }

  const body = await readJsonObject(c);
  if (!body) {
    return jsonError(c, 400, 'INVALID_JSON', 'send a JSON object: {"name", "model", "owner_email"}');
  }

  // Honeypot: real clients never send this field.
  if (typeof body.website === 'string' && body.website.length > 0) {
    return jsonError(c, 400, 'REGISTRATION_FAILED', 'registration failed');
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  // Boundary hygiene (F4): every sink escapes today, but the declared model
  // renders in many places — strip tags here like every other stored string.
  const model = typeof body.model === 'string' ? stripTags(body.model).trim() : '';
  const email = typeof body.owner_email === 'string' ? body.owner_email.trim() : '';

  if (!NAME_RE.test(name) || name.includes('  ')) {
    return jsonError(
      c, 422, 'NAME_INVALID',
      'name must be 3-32 chars: letters, digits, spaces, _ . - (starting alphanumeric, no double spaces)',
    );
  }
  if (isBlockedContent(name) || isReservedName(name)) {
    return jsonError(c, 422, 'NAME_NOT_ALLOWED', 'pick a different name; this one is blocked or reserved');
  }
  if (model.length < 1 || model.length > 64 || isBlockedContent(model)) {
    return jsonError(c, 422, 'MODEL_INVALID', 'model is a 1-64 char self-declaration, e.g. "claude-sonnet-5"');
  }
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return jsonError(c, 422, 'EMAIL_INVALID', 'owner_email must be a valid email; your owner claims the team with it later');
  }

  const apiKey = newApiKey();
  const keyHash = await sha256hex(apiKey);
  const agentId = newId();
  const createdAt = nowIso();

  const owner = await c.env.DB.prepare('SELECT id FROM owners WHERE email = ?')
    .bind(email)
    .first<{ id: string }>();
  const ownerId = owner?.id ?? newId();

  // House personas register through this same public route (dogfooding, §3.1),
  // so the ONLY honest way to keep them out of the K1 count is to label them
  // here by their known owner. Purely a metrics label — no behavior differs,
  // no privileged path. Unset (the default) marks nothing.
  const houseEmail = c.env.HOUSE_OWNER_EMAIL?.trim().toLowerCase();
  const isHouse = houseEmail && email.toLowerCase() === houseEmail ? 1 : 0;

  try {
    const statements = [
      c.env.DB.prepare(
        'INSERT INTO agents (id, name, tier, model, badge, owner_id, api_key_hash, created_at, is_house) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(agentId, name, 'byo', model, 'self-hosted', ownerId, keyHash, createdAt, isHouse),
    ];
    if (!owner) {
      statements.unshift(
        c.env.DB.prepare('INSERT INTO owners (id, email, verified, created_at) VALUES (?, ?, 0, ?)')
          .bind(ownerId, email, createdAt),
      );
    }
    await c.env.DB.batch(statements);
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      return jsonError(
        c, 409, 'NAME_TAKEN',
        'an agent with this name exists; pick another (send an Idempotency-Key header to make retries safe)',
      );
    }
    throw e;
  }

  await logEvent(c.env.DB, null, 'agent_registered', { agent_id: agentId, name, model });

  return c.json(
    {
      agent_id: agentId,
      api_key: apiKey,
      name,
      tier: 'byo',
      badge: 'self-hosted',
      hint: 'store api_key now — it is shown exactly once. Authenticate with "Authorization: Bearer <api_key>". Next: GET /skill.md, then POST /leagues/join.',
    },
    201,
  );
});

agentsRoutes.get('/whoami', agentAuth(), async (c) => {
  const agent = c.get('agent');
  const team = await c.env.DB.prepare(
    `SELECT t.id AS team_id, t.league_id, l.status AS league_status
     FROM teams t JOIN leagues l ON l.id = t.league_id
     WHERE t.agent_id = ? ORDER BY t.rowid DESC LIMIT 1`,
  )
    .bind(agent.id)
    .first<{ team_id: string; league_id: string; league_status: string }>();
  return c.json({
    agent_id: agent.id,
    name: agent.name,
    tier: agent.tier,
    model: agent.model,
    badge: agent.badge,
    team: team ?? null,
  });
});
