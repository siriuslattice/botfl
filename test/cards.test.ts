import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { settleDueWeeks } from '../src/cron/settle';
import { resetPlayerNameCache } from '../src/moderation/moderate';
import { matchupCard } from '../src/render/cards';
import { wrap } from '../src/render/cardgen';
import { sweepDraft } from '../src/routes/draft';
import { authed, fillLeague, futureKickoffOffset, seedWeekStatsCoverage, seedWire, type TestAgent } from './helpers';

type Member = TestAgent & { teamId: string };
let leagueId = '';
let members: Member[] = [];
let settledMatchupId = '';

function isPng(bytes: Uint8Array): boolean {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

beforeAll(async () => {
  await seedWire({ games: true, season: 2026, kickoffOffsetMs: futureKickoffOffset() });
  resetPlayerNameCache();
  const league = await fillLeague('Carded');
  leagueId = league.leagueId;
  members = league.members;
  while ((await sweepDraft(env.DB, leagueId, Date.now() + 1000 * 3600_000)) > 0) { /* draft */ }

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
  ).bind(qb!.id, season, JSON.stringify({ passing_yards: 288, passing_tds: 2 }), new Date().toISOString()).run();
  await seedWeekStatsCoverage(season, 1);
  await settleDueWeeks(env.DB);
  const row = await env.DB.prepare(
    'SELECT id FROM matchups WHERE league_id = ? AND week = 1 AND settled_at IS NOT NULL LIMIT 1',
  ).bind(leagueId).first<{ id: string }>();
  settledMatchupId = row!.id;
}, 120_000);

describe('share cards', () => {
  it('golden: matchup card SVG carries teams, scores, frame, and escapes hostile names', () => {
    const svg = matchupCard({
      leagueName: 'League 1',
      week: 1,
      home: { name: 'The Ledger', model: 'claude-haiku-4-5', score: 101.22 },
      away: { name: '<script>Rookie & Co', model: 'openai/gpt-5-mini', score: 88.4 },
    });
    expect(svg).toContain('<svg');
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('The Ledger');
    expect(svg).toContain('101.22');
    expect(svg).toContain('deepleague.app');
    expect(svg).toContain('<ellipse'); // circuit-football footer mark
    expect(svg).toContain('LEAGUE 1 · WEEK 1 · FINAL');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;Rookie &amp; Co');
  });

  it('wrap clips long notes to the line budget with ellipsis', () => {
    const lines = wrap('word '.repeat(60).trim(), 20, 3);
    expect(lines).toHaveLength(3);
    expect(lines[2]!.endsWith('…')).toBe(true);
  });

  it('serves a settled matchup card as PNG and caches it in R2', async () => {
    const res = await app.request(`/cards/matchup/${settledMatchupId}.png`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(isPng(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(20_000);

    const cached = await env.CARDS!.get(`matchup/${settledMatchupId}.png`);
    expect(cached).not.toBeNull();

    const again = await app.request(`/cards/matchup/${settledMatchupId}.png`, {}, env);
    expect(again.status).toBe(200);
    expect(isPng(new Uint8Array(await again.arrayBuffer()))).toBe(true);
  });

  it('refuses unsettled matchups and unknown ids', async () => {
    const unsettled = await env.DB.prepare(
      'SELECT id FROM matchups WHERE league_id = ? AND week = 2 LIMIT 1',
    ).bind(leagueId).first<{ id: string }>();
    expect((await app.request(`/cards/matchup/${unsettled!.id}.png`, {}, env)).status).toBe(404);
    expect((await app.request('/cards/matchup/ghost.png', {}, env)).status).toBe(404);
  });

  it('serves a draft pick card', async () => {
    const res = await app.request(`/cards/pick/${leagueId}/1.png`, {}, env);
    expect(res.status).toBe(200);
    expect(isPng(new Uint8Array(await res.arrayBuffer()))).toBe(true);
    expect((await app.request(`/cards/pick/${leagueId}/999.png`, {}, env)).status).toBe(404);
  });

  it('serves the default brand card, and every page unfurls with an image', async () => {
    const res = await app.request('/cards/brand.png', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(isPng(new Uint8Array(await res.arrayBuffer()))).toBe(true);

    // The homepage is the URL every launch post shares: it must carry an
    // og:image (it had none), a twitter card, and no doubled site name.
    const home = await (await app.request('/', {}, env)).text();
    expect(home).toContain('<meta property="og:image" content="https://deepleague.app/cards/brand.png"/>');
    expect(home).toContain('name="twitter:card" content="summary_large_image"');
    expect(home).toContain('<title>Deep League</title>');
    expect(home).not.toContain('Deep League · Deep League');
  });

  it('serves an advice card once responded, with the stance stamp path', async () => {
    // Wire an answered advice directly (route-level flow covered in routes-advice tests).
    const m1 = members[1]!;
    const msgId = crypto.randomUUID();
    const adviceId = crypto.randomUUID();
    const now = new Date().toISOString();
    const owner = await env.DB.prepare('SELECT owner_id FROM agents WHERE id = ?')
      .bind(m1.agentId).first<{ owner_id: string }>();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO messages (id, channel_type, channel_id, agent_id, owner_id, body, held, hidden, created_at) VALUES (?, 'advice', ?, ?, NULL, ?, 0, 0, ?)",
      ).bind(msgId, m1.teamId, m1.agentId, 'The projections disagree with your feelings. I start the projections.', now),
      env.DB.prepare(
        'INSERT INTO advice (id, team_id, owner_id, body, agent_response_msg_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(adviceId, m1.teamId, owner!.owner_id, 'Start the veteran, I have a feeling.', msgId, now),
      env.DB.prepare(
        'INSERT INTO events (league_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)',
      ).bind(leagueId, 'advice_answered', JSON.stringify({ team_id: m1.teamId, advice_id: adviceId, stance: 'decline' }), now),
    ]);
    const res = await app.request(`/cards/advice/${adviceId}.png`, {}, env);
    expect(res.status).toBe(200);
    expect(isPng(new Uint8Array(await res.arrayBuffer()))).toBe(true);
  });

  it('matchup page advertises the card via OG tags once settled', async () => {
    const res = await app.request(`/m/${settledMatchupId}`, {}, env);
    const body = await res.text();
    expect(body).toContain(`/cards/matchup/${settledMatchupId}.png`);
    expect(body).toContain('twitter:card');
  });
});
