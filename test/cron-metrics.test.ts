import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { bumpDailyCounter, computeDayMetrics, snapshotDaily } from '../src/cron/metrics';
import { authed, fillLeague, seedWire } from './helpers';

let leagueId = '';
let teamId = '';
const TODAY = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  await seedWire();
  const league = await fillLeague('Metric');
  leagueId = league.leagueId;
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

describe('ops dashboard is NOT on the internet (owner ruling)', () => {
  it('GET /admin serves nothing public; JSON stays token-gated', async () => {
    // No handler + the /admin/* token middleware → an unauthenticated 401,
    // never a page. The visual dashboard lives in scripts/dashboard.mjs.
    const res = await app.request('/admin', {}, env);
    expect(res.status).not.toBe(200);
    expect((await app.request('/admin/metrics', {}, env)).status).toBe(401);
  });
});
