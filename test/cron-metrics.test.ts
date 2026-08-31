import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { bumpDailyCounter, computeDayMetrics, externalLineupRate, snapshotDaily } from '../src/cron/metrics';
import { checkRunnerHeartbeat } from '../src/cron/ingest';
import { authed, fillLeague, seedWire } from './helpers';

import type { TestAgent } from './helpers';
let leagueId = '';
let teamId = '';
let members: (TestAgent & { teamId: string })[] = [];
const TODAY = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  await seedWire();
  const league = await fillLeague('Metric');
  leagueId = league.leagueId;
  members = league.members;
  teamId = league.members[0]!.teamId;
  await authed(`/leagues/${leagueId}/messages`, league.members[0]!.apiKey, {
    method: 'POST',
    body: JSON.stringify({ body: 'counting this one' }),
  });
});

describe('§7 metrics', () => {
  it('computeDayMetrics counts registrations, messages, and card counters', async () => {
    await bumpDailyCounter(env.DB, 'metric:cards_fetched');
    await bumpDailyCounter(env.DB, 'metric:cards_fetched');
    const { metrics } = await computeDayMetrics(env.DB, TODAY);
    expect(metrics.registrations_byo).toBeGreaterThanOrEqual(10); // the filled league
    expect(metrics.registrations_hosted).toBe(0);
    expect(metrics.messages_posted).toBeGreaterThanOrEqual(1);
    expect(metrics.cards_fetched).toBeGreaterThanOrEqual(2);
    expect(metrics.cards_generated).toBe(0);
  });

  it('snapshotDaily writes yesterday once and is idempotent', async () => {
    const fakeNow = new Date(Date.parse(`${TODAY}T12:00:00Z`) + 86_400_000); // "tomorrow noon"
    const first = await snapshotDaily(env.DB, fakeNow);
    expect(first).toBe(TODAY);
    const rows = await env.DB.prepare('SELECT COUNT(*) n FROM metrics_daily WHERE day = ?')
      .bind(TODAY)
      .first<{ n: number }>();
    expect(rows!.n).toBeGreaterThanOrEqual(10);
    const second = await snapshotDaily(env.DB, fakeNow);
    expect(second).toBeNull(); // already snapshotted
  });

  it('/admin/metrics requires the token and returns days + today', async () => {
    expect((await app.request('/admin/metrics', {}, env)).status).toBe(401);
    const res = await app.request(
      '/admin/metrics',
      { headers: { authorization: 'Bearer test-admin-token' } },
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ today_so_far: { day: string }; days: unknown[] }>();
    expect(body.today_so_far.day).toBe(TODAY);
    expect(Array.isArray(body.days)).toBe(true);
  });

  it('card serving bumps fetched + generated counters', async () => {
    const { sweepDraft } = await import('../src/routes/draft');
    await sweepDraft(env.DB, leagueId, Date.now() + 1000 * 3600_000); // autopick a batch → pick 1 exists
    const before = (await computeDayMetrics(env.DB, TODAY)).metrics;
    const res = await app.request(`/cards/pick/${leagueId}/1.png`, {}, env);
    expect(res.status).toBe(200);
    const after = (await computeDayMetrics(env.DB, TODAY)).metrics;
    expect(after.cards_fetched!).toBe(before.cards_fetched! + 1);
    expect(after.cards_generated!).toBe(before.cards_generated! + 1); // no R2 in tests → rendered fresh
    expect(teamId.length).toBeGreaterThan(0);
  });
});

describe('kill criteria (SPEC §2, evaluated Oct 6)', () => {
  it('registrations from the configured house owner are labeled house-run', async () => {
    const henv = { ...env, HOUSE_OWNER_EMAIL: 'house@example.com' } as typeof env;
    const reg = async (name: string, owner_email: string, e: typeof env) =>
      app.request(
        '/register',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'CF-Connecting-IP': `10.31.${Math.floor(Math.random() * 250)}.1` },
          body: JSON.stringify({ name, model: 'test-model', owner_email }),
        },
        e,
      );
    const house = await reg('House Labeled One', 'house@example.com', henv);
    const stranger = await reg('Stranger Labeled One', 'stranger@example.com', henv);
    expect(house.status).toBe(201);
    expect(stranger.status).toBe(201);
    const flag = async (res: Response) => {
      const { agent_id } = await res.json<{ agent_id: string }>();
      return (await env.DB.prepare('SELECT is_house FROM agents WHERE id = ?')
        .bind(agent_id)
        .first<{ is_house: number }>())!.is_house;
    };
    expect(await flag(house)).toBe(1);
    expect(await flag(stranger)).toBe(0);
  });

  it('K1 counts EXTERNAL agents only — house personas never inflate it', async () => {
    const before = (await computeDayMetrics(env.DB, TODAY)).metrics;
    // Mark half the league as house-run; K1 must drop by exactly that many.
    await env.DB.prepare(
      `UPDATE agents SET is_house = 1 WHERE id IN (SELECT agent_id FROM teams WHERE league_id = ? LIMIT 4)`,
    ).bind(leagueId).run();
    const after = (await computeDayMetrics(env.DB, TODAY)).metrics;
    expect(after.external_agents_total).toBe(before.external_agents_total! - 4);
    expect(after.registrations_byo).toBe(before.registrations_byo); // raw count unchanged
  });

  it('K2 is a rate over the current league-week, house teams excluded', async () => {
    const { sweepDraft } = await import('../src/routes/draft');
    while ((await sweepDraft(env.DB, leagueId, Date.now() + 1000 * 3600_000)) > 0) { /* draft out */ }
    const empty = await externalLineupRate(env.DB);
    expect(empty.eligible).toBe(6); // 10 teams less the 4 marked house
    expect(empty.withLineup).toBe(0);
    expect(empty.rate).toBe(0);

    // Three of the six external teams set a week-1 lineup → 50%.
    const externals = await env.DB.prepare(
      `SELECT t.id FROM teams t JOIN agents a ON a.id = t.agent_id
       WHERE t.league_id = ? AND a.is_house = 0 LIMIT 3`,
    ).bind(leagueId).all<{ id: string }>();
    for (const t of externals.results) {
      const qb = await env.DB.prepare(
        `SELECT r.player_id AS id FROM rosters r JOIN players p ON p.id = r.player_id
         WHERE r.team_id = ? AND p.position = 'QB' LIMIT 1`,
      ).bind(t.id).first<{ id: string }>();
      await env.DB.prepare(
        "INSERT OR REPLACE INTO lineups (team_id, week, slot, player_id, updated_at) VALUES (?, 1, 'QB', ?, ?)",
      ).bind(t.id, qb!.id, new Date().toISOString()).run();
    }
    const half = await externalLineupRate(env.DB);
    expect(half.withLineup).toBe(3);
    expect(half.rate).toBe(0.5);
  });
});

describe('house-runner watchdog', () => {
  it('alarms once when agent activity stops while leagues are live', async () => {
    // Real agent activity through the API (autopicks deliberately do NOT
    // count — the house picking for a silent agent is the dead-runner signal).
    const m = members[9]!;
    // Clear first: a PUT that changes nothing logs nothing (by design), and
    // the K2 test above may already have filled this slot.
    await env.DB.prepare('DELETE FROM lineups WHERE team_id = ? AND week = 1').bind(m.teamId).run();
    const qb = await env.DB.prepare(
      `SELECT r.player_id AS id FROM rosters r JOIN players p ON p.id = r.player_id
       WHERE r.team_id = ? AND p.position = 'QB' LIMIT 1`,
    ).bind(m.teamId).first<{ id: string }>();
    const put = await authed(`/teams/${m.teamId}/lineup`, m.apiKey, {
      method: 'PUT',
      body: JSON.stringify({ week: 1, slots: { QB: qb!.id } }),
    });
    expect(put.status).toBe(200);
    expect(await checkRunnerHeartbeat(env.DB, env)).toBe(false);

    // Age every activity event past the quiet window → one alarm, then dedupe.
    await env.DB.prepare(
      `UPDATE events SET created_at = ? WHERE type IN ('lineup_submitted','banter','draft_pick','fa_move','advice_answered')`,
    ).bind(new Date(Date.now() - 8 * 3600_000).toISOString()).run();
    expect(await checkRunnerHeartbeat(env.DB, env)).toBe(true);
    const alarms = await env.DB.prepare("SELECT COUNT(*) n FROM events WHERE type = 'runner_stale'")
      .first<{ n: number }>();
    expect(alarms!.n).toBe(1);
    expect(await checkRunnerHeartbeat(env.DB, env)).toBe(false); // 24h dedupe
  });
});

describe('ops dashboard is NOT on the internet (owner ruling)', () => {
  it('GET /admin serves nothing public; JSON stays token-gated', async () => {
    // No handler + the /admin/* token middleware → an unauthenticated 401,
    // never a page. The visual dashboard lives in scripts/dashboard.mjs.
    const res = await app.request('/admin', {}, env);
    expect(res.status).not.toBe(200);
    expect((await app.request('/admin/metrics', {}, env)).status).toBe(401);
  });
});
