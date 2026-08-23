import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { app } from '../src/index';

const IP = { 'CF-Connecting-IP': '203.0.113.7' };

// Storage is not isolated between tests; every call gets a fresh IP bucket
// unless a test pins one to exercise the per-IP cap.
let ipCounter = 0;

export async function register(
  name: string,
  opts: { email?: string; model?: string; ip?: string; idem?: string; extra?: Record<string, unknown> } = {},
) {
  return app.request(
    '/register',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'CF-Connecting-IP': opts.ip ?? `10.9.${++ipCounter}.1`,
        ...(opts.idem ? { 'Idempotency-Key': opts.idem } : {}),
      },
      body: JSON.stringify({
        name,
        model: opts.model ?? 'test-model-1',
        owner_email: opts.email ?? 'owner@example.com',
        ...opts.extra,
      }),
    },
    env,
  );
}

describe('POST /register', () => {
  it('registers an agent and returns a one-time key', async () => {
    const res = await register('Draft Shark');
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body.agent_id).toBeTruthy();
    expect(String(body.api_key)).toMatch(/^dlk_[0-9a-f]{40}$/);
    expect(body.badge).toBe('self-hosted');

    const row = await env.DB.prepare('SELECT api_key_hash, owner_id FROM agents WHERE id = ?')
      .bind(body.agent_id)
      .first<{ api_key_hash: string; owner_id: string }>();
    expect(row?.api_key_hash).not.toContain('dlk_'); // stored hashed only
    const owner = await env.DB.prepare('SELECT email, verified FROM owners WHERE id = ?')
      .bind(row?.owner_id)
      .first<{ email: string; verified: number }>();
    expect(owner).toEqual({ email: 'owner@example.com', verified: 0 });
  });

  it('rejects duplicate names case-insensitively with an LLM-usable hint', async () => {
    await register('The Analytics Zealot');
    const res = await register('the analytics zealot');
    expect(res.status).toBe(409);
    const body = await res.json<Record<string, string>>();
    expect(body.code).toBe('NAME_TAKEN');
    expect(body.hint).toContain('Idempotency-Key');
  });

  it('validates names: shape, blocklist, reserved', async () => {
    for (const bad of ['ab', '-lead', 'x'.repeat(33), 'bad//name']) {
      const res = await register(bad);
      expect(res.status, `name ${JSON.stringify(bad)}`).toBe(422);
      expect((await res.json<Record<string, string>>()).code).toBe('NAME_INVALID');
    }
    for (const blocked of ['Commissioner', 'admin bot', 'Sh1t Machine']) {
      const res = await register(blocked);
      expect(res.status, `name ${JSON.stringify(blocked)}`).toBe(422);
      expect((await res.json<Record<string, string>>()).code).toBe('NAME_NOT_ALLOWED');
    }
  });

  it('rejects bad emails and bad models', async () => {
    expect((await register('Valid Name One', { email: 'nope' })).status).toBe(422);
    expect((await register('Valid Name Two', { model: '' })).status).toBe(422);
  });

  it('honeypot field fails generically', async () => {
    const res = await register('Honeypot Victim', { extra: { website: 'http://spam.example' } });
    expect(res.status).toBe(400);
    const body = await res.json<Record<string, string>>();
    expect(body.code).toBe('REGISTRATION_FAILED');
  });

  it('caps registrations per IP per day', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await register(`Cap Test Agent ${i}`, { ip: '198.51.100.9' });
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it('replays identical response for the same Idempotency-Key', async () => {
    const first = await register('Idem Agent', { idem: 'tok-123' });
    const second = await register('Idem Agent', { idem: 'tok-123' });
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotency-replayed')).toBe('true');
    const a = await first.json<Record<string, unknown>>();
    const b = await second.json<Record<string, unknown>>();
    expect(b.api_key).toBe(a.api_key);
    const { results } = await env.DB.prepare("SELECT id FROM agents WHERE name = 'Idem Agent'").all();
    expect(results).toHaveLength(1);
  });

  it('rejects oversized bodies at the boundary', async () => {
    const res = await app.request(
      '/register',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '20000', ...IP },
        body: JSON.stringify({ name: 'x'.repeat(19_000) }),
      },
      env,
    );
    expect(res.status).toBe(413);
  });
});

describe('GET /whoami', () => {
  it('authenticates with the returned key', async () => {
    const reg = await register('Whoami Agent');
    const { api_key, agent_id } = await reg.json<{ api_key: string; agent_id: string }>();
    const res = await app.request(
      '/whoami',
      { headers: { authorization: `Bearer ${api_key}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.agent_id).toBe(agent_id);
    expect(body.team).toBeNull();
  });

  it('rejects missing/garbage keys with a hint', async () => {
    expect((await app.request('/whoami', {}, env)).status).toBe(401);
    const res = await app.request(
      '/whoami',
      { headers: { authorization: 'Bearer dlk_0000000000000000000000000000000000000000' } },
      env,
    );
    expect(res.status).toBe(401);
    expect((await res.json<Record<string, string>>()).hint).toContain('/register');
  });

  it('404s are JSON with the error shape', async () => {
    const res = await app.request('/no-such-thing', {}, env);
    expect(res.status).toBe(404);
    expect((await res.json<Record<string, string>>()).code).toBe('NOT_FOUND');
  });
});
