import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { settleDueWeeks } from '../src/cron/settle';
import { sweepDraft } from '../src/routes/draft';
import { authed, fillLeague, futureKickoffOffset, seedWire, type TestAgent } from './helpers';

type Member = TestAgent & { teamId: string };
let leagueId = '';
let members: Member[] = [];

async function html(path: string): Promise<{ status: number; body: string }> {
  const res = await app.request(path, {}, env);
  return { status: res.status, body: await res.text() };
}

beforeAll(async () => {
  await seedWire({ games: true, season: 2026, kickoffOffsetMs: futureKickoffOffset() });
  const league = await fillLeague('Sitey');
  leagueId = league.leagueId;
  members = league.members;

  // First pick carries a spicy note including an injection attempt.
  const s = await app.request(`/leagues/${leagueId}/draft`, {}, env);
  const state = await s.json<{ on_clock: { team_id: string }; board_top: { player_id: string }[] }>();
  const first = members.find((m) => m.teamId === state.on_clock.team_id)!;
  await authed(`/leagues/${leagueId}/draft/pick`, first.apiKey, {
    method: 'POST',
    body: JSON.stringify({
      player_id: state.board_top[0]!.player_id,
      note: 'Fear the shark <script>alert(1)</script>',
    }),
  });
  while ((await sweepDraft(env.DB, leagueId, Date.now() + 1000 * 3600_000)) > 0) { /* finish draft */ }

  // Settle week 1 with a known stat line for one starter.
  const season = (await env.DB.prepare('SELECT season FROM leagues WHERE id = ?')
    .bind(leagueId)
    .first<{ season: number }>())!.season;
  const starter = await env.DB.prepare(
    `SELECT r.player_id AS id FROM rosters r JOIN players p ON p.id = r.player_id
     WHERE r.team_id = ? AND p.position = 'QB' LIMIT 1`,
  )
    .bind(members[0]!.teamId)
    .first<{ id: string }>();
  await authed(`/teams/${members[0]!.teamId}/lineup`, members[0]!.apiKey, {
    method: 'PUT',
    body: JSON.stringify({ week: 1, slots: { QB: starter!.id } }),
  });
  await env.DB.prepare(
    'INSERT INTO stats_weekly (player_id, season, week, stat_json, updated_at) VALUES (?, ?, 1, ?, ?)',
  )
    .bind(starter!.id, season, JSON.stringify({ passing_yards: 300, passing_tds: 2 }), new Date().toISOString())
    .run();
  await settleDueWeeks(env.DB);
});

describe('public site', () => {
  it('home page renders the landing hero, live stats, leagues, and feed', async () => {
    const { status, body } = await html('/');
    expect(status).toBe(200);
    expect(body).toContain('<!doctype html>');
    expect(body).toContain('every team is an AI agent');
    expect(body).toContain('Bring your agent');
    expect(body).toContain('Uses real NFL statistics as facts');
    expect(body).toMatch(/agents/i);
    expect(body).toContain('week 1 is final');
    expect(body).toContain('drafted');
  });

  it('league page renders standings with records and schedule scores', async () => {
    const { status, body } = await html(`/l/${leagueId}`);
    expect(status).toBe(200);
    expect(body).toContain(members[0]!.name);
    expect(body).toContain('standings');
    expect(body).toMatch(/1-0|0-1|0-0-1/);
    expect(body).toContain('self-hosted');
  });

  it('draft page renders picks and escapes hostile notes (F4)', async () => {
    const { status, body } = await html(`/l/${leagueId}/draft`);
    expect(status).toBe(200);
    expect(body).toContain('auto');
    expect(body).toContain('Fear the shark');
    expect(body).not.toContain('<script>alert(1)');
    expect(body).toContain('&lt;script&gt;');
  });

  it('team page renders roster with lineup slots', async () => {
    const { status, body } = await html(`/t/${members[0]!.teamId}`);
    expect(status).toBe(200);
    expect(body).toContain(members[0]!.name);
    expect(body).toContain('QB');
    expect(body).toContain('week 2 lineup'); // week 1 settled → current week is 2
  });

  it('matchup page shows settled score and per-player points', async () => {
    const row = await env.DB.prepare(
      'SELECT id FROM matchups WHERE league_id = ? AND week = 1 AND (home_team_id = ? OR away_team_id = ?)',
    )
      .bind(leagueId, members[0]!.teamId, members[0]!.teamId)
      .first<{ id: string }>();
    const { status, body } = await html(`/m/${row!.id}`);
    expect(status).toBe(200);
    expect(body).toContain('final');
    expect(body).toContain('20.00'); // 300 yds + 2 TD
  });

  it('agents directory and skill.md serve', async () => {
    const dir = await html('/agents');
    expect(dir.status).toBe(200);
    expect(dir.body).toContain(members[0]!.name);
    const skill = await app.request('/skill.md', {}, env);
    expect(skill.status).toBe(200);
    expect(skill.headers.get('content-type')).toContain('markdown');
    expect(await skill.text()).toContain('Deep League');
  });

  it('unknown ids 404', async () => {
    expect((await html('/l/ghost')).status).toBe(404);
    expect((await html('/t/ghost')).status).toBe(404);
    expect((await html('/m/ghost')).status).toBe(404);
  });
});
