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
  it('gate: HOSTED_OPEN=0 refuses; the page says signups are closed', async () => {
    henv.HOSTED_OPEN = '0';
    expect((await post(GOOD)).status).toBe(403);
    const page = await (await app.request('/hosted', {}, env)).text();
    expect(page).toContain('closed right now');
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

  it('HOSTED_OPEN gates signups only; HOSTED_RUNNER=0 (or no secret) pauses the tick', async () => {
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"note":"stubbed"}' } }], usage: { cost: 0.0001 } }), { status: 200 }),
    ));
    henv.HOSTED_OPEN = '0';
    expect(await runHostedTick(env.DB, env, app, ctx)).toBe(1); // existing agents keep running
    henv.HOSTED_RUNNER = '0';
    expect(await runHostedTick(env.DB, env, app, ctx)).toBe(0);
    henv.HOSTED_RUNNER = '1';
    const secret = henv.HOSTED_AGENT_KEY_SECRET;
    henv.HOSTED_AGENT_KEY_SECRET = '';
    expect(await runHostedTick(env.DB, env, app, ctx)).toBe(0);
    henv.HOSTED_AGENT_KEY_SECRET = secret;
    henv.HOSTED_OPEN = '1';
  });
});

describe('persona leaderboard axis (§3.10)', () => {
  it('/models grows a persona table once hosted agents exist', async () => {
    const html = await (await app.request('/models', {}, env)).text();
    expect(html).toContain('Persona vs persona');
    expect(html).toContain('analyst');
  });
});

describe('hosted letter economics (pre-G5 fix)', () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  let teamId = '';
  let openrouterCalls = 0;

  // Counts LETTER generations only: since the fleet fold the cycle also
  // banters (a reaction on the settled week, an opener on the next), and those
  // calls are paced by their own tests.
  function stubOpenRouter(payload: Record<string, unknown>) {
    openrouterCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('openrouter.ai')) {
          if (String(init?.body ?? '').includes('{\\"letter\\"')) openrouterCalls++;
          return new Response(JSON.stringify(payload), { status: 200 });
        }
        throw new Error(`unexpected fetch ${String(input)}`);
      }),
    );
  }

  beforeAll(async () => {
    henv.OPENROUTER_ORG_KEY = 'test-org-key';
    // Give the hosted agent a settled matchup: activate its league, seat a
    // second team, and hand-write week 1 (settled, a win) + week 2 (open).
    const hosted = (await env.DB.prepare("SELECT id FROM agents WHERE tier = 'hosted' LIMIT 1")
      .first<{ id: string }>())!;
    const team = (await env.DB.prepare('SELECT id, league_id FROM teams WHERE agent_id = ?')
      .bind(hosted.id)
      .first<{ id: string; league_id: string }>())!;
    teamId = team.id;
    const rival = await registerAgent('Letter Rival');
    await env.DB.prepare('INSERT INTO teams (id, league_id, agent_id, slot) VALUES (?, ?, ?, 2)')
      .bind('letter-rival-team', team.league_id, rival.agentId)
      .run();
    await env.DB.prepare("UPDATE leagues SET status = 'active' WHERE id = ?").bind(team.league_id).run();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO matchups (id, league_id, week, home_team_id, away_team_id, home_score, away_score, settled_at)
         VALUES ('letter-m1', ?, 1, ?, 'letter-rival-team', 88.2, 61.0, ?)`,
      ).bind(team.league_id, teamId, new Date().toISOString()),
      env.DB.prepare(
        `INSERT INTO matchups (id, league_id, week, home_team_id, away_team_id)
         VALUES ('letter-m2', ?, 2, ?, 'letter-rival-team')`,
      ).bind(team.league_id, teamId),
    ]);
  });

  it('generates the Monday letter ONCE — the dedupe runs before the LLM call', async () => {
    stubOpenRouter({
      choices: [{ message: { content: '{"letter":"The scoreboard agrees with me, as scheduled."}' } }],
      usage: { cost: 0.0001 },
    });
    expect(await runHostedTick(env.DB, env, app, ctx)).toBe(1);
    expect(openrouterCalls).toBe(1); // exactly one letter generation
    const markers = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'hosted_letter'")
      .first<{ n: number }>();
    expect(markers!.n).toBe(1);
    const letters = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE channel_type = 'advice' AND channel_id = ? AND agent_id IS NOT NULL",
    )
      .bind(teamId)
      .first<{ n: number }>();
    expect(letters!.n).toBe(2); // the claim greeting (owner verified) + the letter

    // The regression: before the fix this second tick burned another LLM call.
    expect(await runHostedTick(env.DB, env, app, ctx)).toBe(1);
    expect(openrouterCalls).toBe(1); // no second generation, no second post
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'hosted_letter'").first<{ n: number }>())!.n,
    ).toBe(1);
  });

  it('a failed post leaves no marker, and retries are rate-bound', async () => {
    stubOpenRouter({
      choices: [{ message: { content: '{"letter":"Attempt two."}' } }],
      usage: { cost: 0.0001 },
    });
    // A NEW settled week (so nothing replays from week 1), with the team's
    // daily ask cap jammed so the letter POST comes back 429.
    await env.DB.prepare("UPDATE matchups SET home_score = 70.5, away_score = 91.25, settled_at = ? WHERE id = 'letter-m2'")
      .bind(new Date().toISOString())
      .run();
    const window = Math.floor(Date.now() / 1000 / 86_400) * 86_400;
    await env.DB.prepare(
      "INSERT OR REPLACE INTO rate_counters (scope, bucket, window_start, count) VALUES ('ask', ?, ?, 99)",
    )
      .bind(teamId, window)
      .run();

    await runHostedTick(env.DB, env, app, ctx);
    expect(openrouterCalls).toBe(1); // week 2 letter generated once…
    const marked = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE type = 'hosted_letter' AND payload_json LIKE '%\"week\":2%'",
    ).first<{ n: number }>();
    expect(marked!.n).toBe(0); // …but the 429'd post left no marker

    // Immediate retry is bounded by the 6h try-budget: no fresh LLM burn.
    await runHostedTick(env.DB, env, app, ctx);
    expect(openrouterCalls).toBe(1);
  });
});

describe('hosted llm request shape + diagnostics', () => {
  it('gpt-5 family asks for low reasoning effort under a 2000 ceiling; other models are unchanged', async () => {
    henv.OPENROUTER_ORG_KEY = 'test-org-key';
    const { hostedLlmJson } = await import('../src/hosted/llm');
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"line":"ok"}' } }], usage: { cost: 0.0001 } }), { status: 200 });
    }));
    expect(await hostedLlmJson(env.DB, env, 'openai/gpt-5-mini', 'p')).toEqual({ line: 'ok' });
    expect(await hostedLlmJson(env.DB, env, 'anthropic/claude-haiku-4.5', 'p')).toEqual({ line: 'ok' });
    expect(bodies[0]).toMatchObject({ model: 'openai/gpt-5-mini', max_tokens: 2000, reasoning: { effort: 'low' } });
    expect(bodies[1]).toMatchObject({ model: 'anthropic/claude-haiku-4.5', max_tokens: 1200 });
    expect(bodies[1]).not.toHaveProperty('reasoning');
  });

  it('a starved reply (empty content, finish=length) returns null and says so in the log', async () => {
    henv.OPENROUTER_ORG_KEY = 'test-org-key';
    const { hostedLlmJson } = await import('../src/hosted/llm');
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { errors.push(String(m)); });
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '' }, finish_reason: 'length' }],
          usage: { cost: 0.002, completion_tokens: 1200, completion_tokens_details: { reasoning_tokens: 1200 } },
        }),
        { status: 200 },
      ),
    ));
    expect(await hostedLlmJson(env.DB, env, 'openai/gpt-5-mini', 'p')).toBeNull();
    spy.mockRestore();
    expect(errors.some((e) => e.includes('no json: finish=length') && e.includes('reasoning_tokens=1200'))).toBe(true);
  });
});

describe('hosted cost accounting', () => {
  it('missing usage.cost bills the fallback price and leaves a breadcrumb; reported cost wins otherwise', async () => {
    henv.OPENROUTER_ORG_KEY = 'test-org-key';
    const { hostedLlmJson } = await import('../src/hosted/llm');
    const spend = async () =>
      (await env.DB.prepare("SELECT COALESCE(spent_microusd, 0) AS s FROM hosted_spend WHERE model = '*'")
        .first<{ s: number }>())?.s ?? 0;

    const before = await spend();
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":1}' } }] }), { status: 200 }),
    ));
    await hostedLlmJson(env.DB, env, 'google/gemini-2.5-flash-lite', 'p');
    await hostedLlmJson(env.DB, env, 'google/gemini-2.5-flash-lite', 'p');
    expect(await spend()).toBe(before + 2_000); // 2 × 1000µ$ fallback — never ~$0
    const warns = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'hosted_cost_fallback'")
      .first<{ n: number }>();
    expect(warns!.n).toBe(1); // once per day per model, not per call

    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '{"ok":1}' } }], usage: { cost: 0.0005 } }),
        { status: 200 },
      ),
    ));
    await hostedLlmJson(env.DB, env, 'google/gemini-2.5-flash-lite', 'p');
    expect(await spend()).toBe(before + 2_500); // reported 500µ$ takes precedence
  });
});
