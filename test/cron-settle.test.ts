import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { settleDueWeeks } from '../src/cron/settle';
import { app } from '../src/index';
import { sweepDraft } from '../src/routes/draft';
import { authed, fillLeague, futureKickoffOffset, seedWire, type TestAgent } from './helpers';

type Member = TestAgent & { teamId: string };
let leagueId = '';
let members: Member[] = [];
let season = 0;

async function starterQbOf(teamId: string): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT r.player_id AS id FROM rosters r JOIN players p ON p.id = r.player_id
     WHERE r.team_id = ? AND p.position = 'QB' LIMIT 1`,
  )
    .bind(teamId)
    .first<{ id: string }>();
  return row!.id;
}

beforeAll(async () => {
  await seedWire({ games: true, season: 2026, kickoffOffsetMs: futureKickoffOffset() });
  const league = await fillLeague('Settle');
  leagueId = league.leagueId;
  members = league.members;
  while ((await sweepDraft(env.DB, leagueId, Date.now() + 1000 * 3600_000)) > 0) { /* draft */ }
  season = (await env.DB.prepare('SELECT season FROM leagues WHERE id = ?')
    .bind(leagueId)
    .first<{ season: number }>())!.season;
});

describe('settleDueWeeks', () => {
  it('is a no-op before stats land', async () => {
    expect((await settleDueWeeks(env.DB)).matchups).toBe(0);
  });

  it('settles week 1 exactly once, with exact scores and snapshot hashes', async () => {
    // One team submits a QB-only lineup with a known stat line: 300/2/1 = 18.0.
    const scorer = members[0]!;
    const qb = await starterQbOf(scorer.teamId);
    const put = await authed(`/teams/${scorer.teamId}/lineup`, scorer.apiKey, {
      method: 'PUT',
      body: JSON.stringify({ week: 1, slots: { QB: qb } }),
    });
    expect(put.status).toBe(200);

    await env.DB.prepare(
      'INSERT INTO stats_weekly (player_id, season, week, stat_json, updated_at) VALUES (?, ?, 1, ?, ?)',
    )
      .bind(qb, season, JSON.stringify({ passing_yards: 300, passing_tds: 2, interceptions: 1 }), new Date().toISOString())
      .run();

    const settled = await settleDueWeeks(env.DB);
    expect(settled.matchups).toBe(5); // week 1 of this league
    expect(settled.leagueWeeks).toContainEqual({ leagueId, week: 1 });

    const rows = await env.DB.prepare(
      'SELECT home_team_id, away_team_id, home_score, away_score, settled_at, stat_snapshot_hash FROM matchups WHERE league_id = ? AND week = 1',
    )
      .bind(leagueId)
      .all<{
        home_team_id: string; away_team_id: string;
        home_score: number; away_score: number;
        settled_at: string; stat_snapshot_hash: string;
      }>();
    expect(rows.results).toHaveLength(5);
    for (const m of rows.results) {
      expect(m.settled_at).toBeTruthy();
      expect(m.stat_snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    const mine = rows.results.find(
      (m) => m.home_team_id === scorer.teamId || m.away_team_id === scorer.teamId,
    )!;
    const myScore = mine.home_team_id === scorer.teamId ? mine.home_score : mine.away_score;
    const oppScore = mine.home_team_id === scorer.teamId ? mine.away_score : mine.home_score;
    expect(myScore).toBe(18); // exact half-PPR total
    expect(oppScore).toBe(0); // opponent never set a lineup

    // Week 2 untouched (no stats yet).
    const wk2 = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM matchups WHERE league_id = ? AND week = 2 AND settled_at IS NOT NULL',
    )
      .bind(leagueId)
      .first<{ n: number }>();
    expect(wk2?.n).toBe(0);

    // Re-run: deterministic no-op, values unchanged.
    expect((await settleDueWeeks(env.DB)).matchups).toBe(0);
    const again = await env.DB.prepare(
      'SELECT home_score, away_score, settled_at, stat_snapshot_hash FROM matchups WHERE league_id = ? AND week = 1',
    )
      .bind(leagueId)
      .all();
    expect(again.results).toEqual(
      rows.results.map(({ home_team_id, away_team_id, ...rest }) => rest),
    );

    // Settlement event logged.
    const ev = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE league_id = ? AND type = 'week_settled'",
    )
      .bind(leagueId)
      .first<{ n: number }>();
    expect(ev?.n).toBe(1);
  });

  it('matchups endpoint exposes settled scores publicly', async () => {
    const res = await app.request(`/leagues/${leagueId}/matchups?week=1`, {}, env);
    const { matchups } = await res.json<{ matchups: { settled_at: string | null }[] }>();
    expect(matchups).toHaveLength(5);
    expect(matchups.every((m) => m.settled_at !== null)).toBe(true);
  });
});
