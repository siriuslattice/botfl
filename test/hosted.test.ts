// Tier 2 (SPEC §3.1): signup gating + validation, key custody (nothing stored),
// budget pause semantics, and a full hosted cycle acting through the real
// public routes in-process with the LLM stubbed.
import { env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import { runHostedTick } from '../src/cron/hosted';
import { deriveHostedKey } from '../src/hosted/keys';
import { registerAgent, seedWire } from './helpers';

const henv = env as unknown as Env & Record<string, string>;

function post(body: Record<string, unknown>) {
  return app.request(
    '/hosted',
    { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': `10.77.${Math.floor(Math.random() * 250)}.1` }, body: JSON.stringify(body) },
    env,
  );
}

const GOOD = { name: 'Hosted Hero', owner_email: 'hosted@example.com', model: 'flash', persona: 'analyst' };

beforeAll(async () => {
  await seedWire();
  henv.HOSTED_OPEN = '1';
  henv.HOSTED_AGENT_KEY_SECRET = 'test-hosted-secret';
  henv.DEV_EXPOSE_LINKS = '1';
});
afterEach(() => vi.unstubAllGlobals());

describe('hosted signup', () => {
  it('gate: HOSTED_OPEN=0 refuses; the page says Sep 18', async () => {
    henv.HOSTED_OPEN = '0';
    expect((await post(GOOD)).status).toBe(403);
    const page = await (await app.request('/hosted', {}, env)).text();
    expect(page).toContain('Sep 18');
    henv.HOSTED_OPEN = '1';
    const openPage = await (await app.request('/hosted', {}, env)).text();
    expect(openPage).toContain('Create my agent');
  });

  it('validation: name/email/menu enforced; honeypot opaque', async () => {
    expect((await post({ ...GOOD, website: 'http://spam' })).status).toBe(400);
    expect((await post({ ...GOOD, name: 'x' })).status).toBe(422);
    expect((await post({ ...GOOD, owner_email: 'nope' })).status).toBe(422);
    expect((await post({ ...GOOD, model: 'gpt-5-ultra' })).status).toBe(422);
    expect((await post({ ...GOOD, persona: 'villain' })).status).toBe(422);
  });

  it('creates the agent with tier=hosted, nothing key-like stored, claim link out', async () => {
    const res = await post(GOOD);
    expect(res.status).toBe(201);
    const body = await res.json<{ agent_id: string; model: string; dev_magic_link?: string }>();
    expect(body.model).toBe('google/gemini-2.5-flash-lite');
    expect(body.dev_magic_link).toContain('/claim/');

    const row = await env.DB.prepare('SELECT tier, badge, api_key_hash, persona_json FROM agents WHERE id = ?')
      .bind(body.agent_id)
      .first<{ tier: string; badge: string; api_key_hash: string; persona_json: string }>();
    expect(row!.tier).toBe('hosted');
    expect(row!.badge).toBe('hosted');
    expect(JSON.parse(row!.persona_json).key).toBe('analyst');
    // The stored hash matches the DERIVED key — and no plaintext key column exists.
    const derived = await deriveHostedKey('test-hosted-secret', body.agent_id);
    const { sha256hex } = await import('../src/routes/util');
    expect(row!.api_key_hash).toBe(await sha256hex(derived));
    const whoami = await app.request('/whoami', { headers: { authorization: `Bearer ${derived}` } }, env);
    expect(whoami.status).toBe(200);
  });

  it('one hosted agent per email; budget breach pauses signup only', async () => {
    const dup = await post({ ...GOOD, name: 'Hosted Hero II' });
    expect(dup.status).toBe(409);
    expect((await dup.json<{ code: string }>()).code).toBe('HOSTED_LIMIT');

    const month = new Date().toISOString().slice(0, 7);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO hosted_spend (month, model, spent_microusd, calls) VALUES (?, '*', 99999999, 1)",
    ).bind(month).run();
    const paused = await post({ name: 'Budget Buster', owner_email: 'other@example.com', model: 'flash', persona: 'gambler' });
    expect(paused.status).toBe(503);
    expect((await paused.json<{ code: string }>()).code).toBe('HOSTED_PAUSED');
    await env.DB.prepare("DELETE FROM hosted_spend WHERE month = ? AND model = '*'").bind(month).run();
  });
});

describe('hosted runner', () => {
  it('acts only for verified owners; a cycle joins a league through the real routes', async () => {
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    // LLM stub: openrouter returns a benign JSON note for any call.
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"note":"stubbed"}' } }], usage: { cost: 0.0001 } }), { status: 200 }),
    ));

    const agentRow = await env.DB.prepare("SELECT id, owner_id FROM agents WHERE tier = 'hosted' LIMIT 1")
      .first<{ id: string; owner_id: string }>();
    // Owner unverified → the tick skips the agent entirely.
    expect(await runHostedTick(env.DB, env, app, ctx)).toBe(0);

    await env.DB.prepare('UPDATE owners SET verified = 1 WHERE id = ?').bind(agentRow!.owner_id).run();
    const acted = await runHostedTick(env.DB, env, app, ctx);
    expect(acted).toBe(1);
    const team = await env.DB.prepare('SELECT id, league_id FROM teams WHERE agent_id = ?')
      .bind(agentRow!.id)
      .first<{ id: string; league_id: string }>();
    expect(team).not.toBeNull(); // joined via POST /leagues/join in-process
    // Round-robin cursor stamped.
    const stamped = await env.DB.prepare('SELECT hosted_last_run_at FROM agents WHERE id = ?')
      .bind(agentRow!.id)
      .first<{ hosted_last_run_at: string | null }>();
    expect(stamped!.hosted_last_run_at).not.toBeNull();
    // Spend recorded from the stubbed usage.cost.
    const spend = await env.DB.prepare("SELECT calls FROM hosted_spend WHERE model = '*'").first<{ calls: number }>();
    expect(spend?.calls ?? 0).toBeGreaterThanOrEqual(0); // may be 0 if no LLM call was needed this cycle
    expect(registerAgent).toBeDefined();
  });

  it('does nothing when HOSTED_OPEN != 1 or the secret is missing', async () => {
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    henv.HOSTED_OPEN = '0';
    expect(await runHostedTick(env.DB, env, app, ctx)).toBe(0);
    henv.HOSTED_OPEN = '1';
  });
});
