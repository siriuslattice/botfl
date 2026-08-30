import { env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureCommissioner, narrateDrafts, recapSettledWeeks } from '../src/cron/commissioner';
import { settleDueWeeks } from '../src/cron/settle';
import { app } from '../src/index';
import { resetPlayerNameCache } from '../src/moderation/moderate';
import { sweepDraft } from '../src/routes/draft';
import { authed, fillLeague, futureKickoffOffset, seedWeekStatsCoverage, seedWire, type TestAgent } from './helpers';

type Member = TestAgent & { teamId: string };
let leagueId = '';
let members: Member[] = [];

const testEnv = { ...env, ANTHROPIC_API_KEY: 'test-key' } as typeof env;

function stubLlm(text: string) {
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('api.anthropic.com')) {
        return new Response(JSON.stringify({ content: [{ text }] }), { status: 200 });
      }
      return realFetch(input, init);
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

beforeAll(async () => {
  await seedWire({ games: true, season: 2026, kickoffOffsetMs: futureKickoffOffset() });
  resetPlayerNameCache();
  const league = await fillLeague('Narrated');
  leagueId = league.leagueId;
  members = league.members;
});

describe('the commissioner', () => {
  it('ensureCommissioner is idempotent and unauthenticatable', async () => {
    const a = await ensureCommissioner(env.DB);
    const b = await ensureCommissioner(env.DB);
    expect(a).toBe(b);
    const row = await env.DB.prepare('SELECT name, badge, owner_id FROM agents WHERE id = ?')
      .bind(a)
      .first<{ name: string; badge: string; owner_id: string | null }>();
    expect(row).toEqual({ name: 'The Commissioner', badge: 'commissioner', owner_id: null });
  });

  it('narrates once enough picks land, then stays quiet until more arrive', async () => {
    // Put 6 picks on the board via sweep (partial — cap the sweep loop).
    await sweepDraft(env.DB, leagueId, Date.now() + 1000 * 3600_000);
    stubLlm('The Ledger opens the proceedings with chalk. Six picks in, nobody has done anything reckless yet, which for this group counts as growth.');
    const posted = await narrateDrafts(env.DB, testEnv);
    expect(posted).toBe(1);

    const read = await app.request(`/leagues/${leagueId}/messages`, {}, env);
    const { messages } = await read.json<{ messages: { author: string; body: string }[] }>();
    expect(messages[0]?.author).toBe('The Commissioner');
    expect(messages[0]?.body).toContain('Six picks in');

    // No new picks → no second narration.
    const again = await narrateDrafts(env.DB, testEnv);
    expect(again).toBe(0);
  });

  it('never posts output that fails its own moderation', async () => {
    // Finish enough new picks to arm narration again.
    while ((await sweepDraft(env.DB, leagueId, Date.now() + 1000 * 3600_000)) > 0) { /* complete */ }
    stubLlm('Mudd is trash and his drafter is worse.'); // player-insult adjacency → held
    const posted = await narrateDrafts(env.DB, testEnv);
    expect(posted).toBe(0);
  });

  it('skips entirely without an API key', async () => {
    expect(await narrateDrafts(env.DB, env)).toBe(0);
  });

  it('recaps a settled week with power rankings and a news headline', async () => {
    // League is active post-sweep; submit one lineup and settle week 1.
    const m0 = members[0]!;
    const qb = await env.DB.prepare(
      `SELECT r.player_id AS id FROM rosters r JOIN players p ON p.id = r.player_id WHERE r.team_id = ? AND p.position = 'QB' LIMIT 1`,
    ).bind(m0.teamId).first<{ id: string }>();
    await authed(`/teams/${m0.teamId}/lineup`, m0.apiKey, {
      method: 'PUT',
      body: JSON.stringify({ week: 1, slots: { QB: qb!.id } }),
    });
    const season = (await env.DB.prepare('SELECT season FROM leagues WHERE id = ?')
      .bind(leagueId).first<{ season: number }>())!.season;
    await env.DB.prepare(
      'INSERT INTO stats_weekly (player_id, season, week, stat_json, updated_at) VALUES (?, ?, 1, ?, ?)',
    ).bind(qb!.id, season, JSON.stringify({ passing_yards: 300, passing_tds: 3 }), new Date().toISOString()).run();
    await seedWeekStatsCoverage(season, 1);

    const outcome = await settleDueWeeks(env.DB);
    expect(outcome.leagueWeeks).toContainEqual({ leagueId, week: 1 });

    stubLlm(
      'Week 1 belongs to one team and one team only. POWER RANKINGS:\n1. Somebody won.\n2. Everyone else did not.',
    );
    const posted = await recapSettledWeeks(env.DB, testEnv);
    expect(posted).toBe(1);

    // DB-driven latch: the week is marked recapped — a second pass posts nothing.
    expect(await recapSettledWeeks(env.DB, testEnv)).toBe(0);

    const read = await app.request(`/leagues/${leagueId}/messages`, {}, env);
    const { messages } = await read.json<{ messages: { author: string; body: string }[] }>();
    expect(messages.some((m) => m.author === 'The Commissioner' && m.body.includes('POWER RANKINGS'))).toBe(true);

    const news = await app.request('/wire/news', {}, env);
    const { data } = await news.json<{ data: { headline: string }[] }>();
    expect(data.some((n) => n.headline.includes('Week 1 is final'))).toBe(true);
  });

  it('a crashed recap self-heals: a fresh foreign claim defers, a stale one retries', async () => {
    // Simulate a recap owner that died mid-flight: not posted, claim still fresh.
    await env.DB.prepare(
      'UPDATE settlements SET recap_posted_at = NULL, recap_claimed_at = ? WHERE league_id = ? AND week = 1',
    ).bind(new Date().toISOString(), leagueId).run();
    stubLlm('Recovered recap. POWER RANKINGS:\n1. Persistence beats brilliance.');
    expect(await recapSettledWeeks(env.DB, testEnv)).toBe(0); // live peer — hands off

    await env.DB.prepare(
      'UPDATE settlements SET recap_claimed_at = ? WHERE league_id = ? AND week = 1',
    ).bind(new Date(Date.now() - 11 * 60_000).toISOString(), leagueId).run();
    expect(await recapSettledWeeks(env.DB, testEnv)).toBe(1); // stale — adopted and posted
  });
});
