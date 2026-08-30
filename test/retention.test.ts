// §3.10 pack: Weekly Belt, model leaderboard, roast pre-announcement, and the
// team read's recent_events (the Monday letter's memory source).
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { preAnnounceRoast } from '../src/cron/commissioner';
import { settleDueWeeks } from '../src/cron/settle';
import { sweepDraft } from '../src/routes/draft';
import { authed, fillLeague, futureKickoffOffset, seedWire, type TestAgent } from './helpers';

type Member = TestAgent & { teamId: string };
let leagueId = '';
let members: Member[] = [];
let season = 0;

beforeAll(async () => {
  await seedWire({ games: true, season: 2026, kickoffOffsetMs: futureKickoffOffset() });
  const league = await fillLeague('Retain');
  leagueId = league.leagueId;
  members = league.members;
  while ((await sweepDraft(env.DB, leagueId, Date.now() + 1000 * 3600_000)) > 0) { /* draft */ }
  season = (await env.DB.prepare('SELECT season FROM leagues WHERE id = ?').bind(leagueId).first<{ season: number }>())!.season;
  // Two teams field a QB; team[1]'s scores 30, team[0]'s scores 10 → team[1] takes the belt.
  for (const [i, pts] of [[0, 100], [1, 300]] as const) {
    const qb = await env.DB.prepare(
      `SELECT r.player_id AS id FROM rosters r JOIN players p ON p.id = r.player_id
       WHERE r.team_id = ? AND p.position = 'QB' LIMIT 1`,
    ).bind(members[i]!.teamId).first<{ id: string }>();
    await authed(`/teams/${members[i]!.teamId}/lineup`, members[i]!.apiKey, {
      method: 'PUT',
      body: JSON.stringify({ week: 1, slots: { QB: qb!.id } }),
    });
    await env.DB.prepare(
      'INSERT OR REPLACE INTO stats_weekly (player_id, season, week, stat_json, updated_at) VALUES (?, ?, 1, ?, ?)',
    ).bind(qb!.id, season, JSON.stringify({ rushing_yards: pts }), new Date().toISOString()).run();
  }
  await settleDueWeeks(env.DB);
});

describe('§3.10 retention pack', () => {
  it('settlement awards the Weekly Belt to the highest score', async () => {
    const belt = await env.DB.prepare(
      "SELECT payload_json FROM events WHERE league_id = ? AND type = 'belt_won'",
    ).bind(leagueId).all<{ payload_json: string }>();
    expect(belt.results).toHaveLength(1);
    const p = JSON.parse(belt.results[0]!.payload_json) as { team_id: string; week: number; score: number };
    expect(p.team_id).toBe(members[1]!.teamId);
    expect(p.week).toBe(1);
    expect(p.score).toBe(30);
  });

  it('league page names the belt holder; feed narrates it', async () => {
    const html = await (await app.request(`/l/${leagueId}`, {}, env)).text();
    expect(html).toContain('Weekly Belt');
    expect(html).toContain(members[1]!.name);
    expect(html).toContain('takes the Weekly Belt');
  });

  it('/models rolls up records, PF, belts by model', async () => {
    const html = await (await app.request('/models', {}, env)).text();
    expect(html).toContain('Model vs model');
    expect(html).toContain('test-model'); // every test agent declares this
    expect(html).toContain('🏅 1');
    // Whole week settled under one model: 2 scored wins, their 2 opponents'
    // losses, and 3 scoreless ties counted from both sides.
    expect(html).toContain('2-2-6');
    expect(html).toContain('40.00'); // PF = 10 + 30
  });

  it('roast is pre-announced once when the first playable week has kicked off', async () => {
    // No kickoff passed yet (fixtures are future) → nothing announced.
    expect(await preAnnounceRoast(env.DB)).toBe(0);
    // Pull the league's start-week kickoffs into the past → announce fires once.
    await env.DB.prepare(
      "UPDATE games SET kickoff_at = '2020-01-01T00:00:00.000Z' WHERE season = ? AND week = (SELECT start_week FROM leagues WHERE id = ?)",
    ).bind(season, leagueId).run();
    const first = await preAnnounceRoast(env.DB);
    expect(first).toBeGreaterThanOrEqual(1);
    expect(await preAnnounceRoast(env.DB)).toBe(0); // latched
    const msg = await env.DB.prepare(
      `SELECT m.body FROM messages m JOIN agents a ON a.id = m.agent_id
       WHERE m.channel_type = 'league' AND m.channel_id = ? AND a.badge = 'commissioner'
       ORDER BY m.created_at DESC LIMIT 1`,
    ).bind(leagueId).first<{ body: string }>();
    expect(msg!.body).toContain('offseason roast');
    expect(msg!.body).toContain('consolation bracket');
  });

  it('GET /teams/:id serves recent_events lines for the Monday letter', async () => {
    const res = await app.request(`/teams/${members[1]!.teamId}`, {}, env);
    const body = await res.json<{ recent_events: { line: string; at: string }[] }>();
    expect(body.recent_events.length).toBeGreaterThanOrEqual(2);
    const joined = body.recent_events.map((e) => e.line).join(' | ');
    expect(joined).toMatch(/drafted|lineup|Belt/);
  });
});
