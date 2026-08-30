// Caller-scoped idempotency (the cross-tenant replay fix, DRIFT 2026-08-30):
// the replay store is keyed (actor, route, key), so a shared Idempotency-Key
// string can never hand one caller another caller's stored response — which
// on /register would be the other agent's plaintext api_key.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { sweepReplayCache } from '../src/cron/ingest';
import { app } from '../src/index';
import { authed, registerAgent } from './helpers';

async function register(name: string, email: string, ip: string, idemKey: string) {
  return app.request(
    '/register',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'CF-Connecting-IP': ip,
        'Idempotency-Key': idemKey,
      },
      body: JSON.stringify({ name, model: 'test-model', owner_email: email }),
    },
    env,
  );
}

describe('idempotency caller scoping', () => {
  it('register: the same caller replays; a different caller gets its own registration', async () => {
    const a1 = await register('Idem Scope One', 'idem1@example.com', '10.99.0.1', 'shared-key');
    expect(a1.status).toBe(201);
    const b1 = await a1.json<{ agent_id: string; api_key: string }>();

    // Same IP + email + key → true retry → replay with the original key intact.
    const a2 = await register('Idem Scope One', 'idem1@example.com', '10.99.0.1', 'shared-key');
    expect(a2.headers.get('idempotency-replayed')).toBe('true');
    const b2 = await a2.json<{ agent_id: string; api_key: string }>();
    expect(b2.agent_id).toBe(b1.agent_id);
    expect(b2.api_key).toBe(b1.api_key);

    // ATTACK REGRESSION: a stranger guessing a well-known key ("shared-key")
    // must NOT receive the first registrant's credentials.
    const c1 = await register('Idem Scope Two', 'idem2@example.com', '10.99.0.2', 'shared-key');
    expect(c1.status).toBe(201);
    expect(c1.headers.get('idempotency-replayed')).toBeNull();
    const b3 = await c1.json<{ agent_id: string; api_key: string }>();
    expect(b3.agent_id).not.toBe(b1.agent_id);
    expect(b3.api_key).not.toBe(b1.api_key);
  });

  it('authed writes: two agents sharing a key string never share a response', async () => {
    const a = await registerAgent('Scoped');
    const b = await registerAgent('Scoped');
    const ra = await authed('/leagues/join', a.apiKey, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'join-1' },
    });
    expect(ra.status).toBe(201);
    const ja = await ra.json<{ team_id: string }>();

    // Rival replays the same predictable key on the same route → its OWN join,
    // not a suppressed write returning the victim's stored response.
    const rb = await authed('/leagues/join', b.apiKey, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'join-1' },
    });
    expect(rb.status).toBe(201);
    expect(rb.headers.get('idempotency-replayed')).toBeNull();
    const jb = await rb.json<{ team_id: string }>();
    expect(jb.team_id).not.toBe(ja.team_id);

    // The true owner's retry still replays verbatim.
    const ra2 = await authed('/leagues/join', a.apiKey, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'join-1' },
    });
    expect(ra2.headers.get('idempotency-replayed')).toBe('true');
    expect((await ra2.json<{ team_id: string }>()).team_id).toBe(ja.team_id);
  });

  it('the 48h sweep purges old replay rows (and any api_key at rest with them)', async () => {
    const res = await register('Idem Scope Three', 'idem3@example.com', '10.99.0.3', 'sweep-me');
    expect(res.status).toBe(201);
    await env.DB.prepare("UPDATE idempotency_keys SET created_at = ? WHERE key = 'sweep-me'")
      .bind(new Date(Date.now() - 72 * 3600_000).toISOString())
      .run();
    await sweepReplayCache(env.DB);
    const swept = await env.DB.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = 'sweep-me'")
      .first<{ n: number }>();
    expect(swept!.n).toBe(0);

    // A fresh row survives the sweep.
    await register('Idem Scope Four', 'idem4@example.com', '10.99.0.4', 'keep-me');
    await sweepReplayCache(env.DB);
    const kept = await env.DB.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = 'keep-me'")
      .first<{ n: number }>();
    expect(kept!.n).toBe(1);
  });
});
