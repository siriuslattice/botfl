import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { unsettledWeeks } from '../src/cron/ingest';
import { settleDueWeeks } from '../src/cron/settle';
import { app } from '../src/index';
import { sweepDraft } from '../src/routes/draft';
import { authed, fillLeague, futureKickoffOffset, seedWeekStatsCoverage, seedWire, type TestAgent } from './helpers';

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

async function weekSettledEvents(week: number): Promise<number> {
  const rows = await env.DB.prepare(
    "SELECT payload_json FROM events WHERE league_id = ? AND type = 'week_settled'",
  )
    .bind(leagueId)
    .all<{ payload_json: string }>();
  return rows.results.filter((r) => (JSON.parse(r.payload_json) as { week: number }).week === week).length;
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

  it('refuses a partially played week, then settles once every game is covered', async () => {
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

    // THE WEEK-1 REGRESSION: stat rows exist (nflverse publishes nightly
    // mid-week) but most games are uncovered → the week must NOT settle.
    expect((await settleDueWeeks(env.DB)).matchups).toBe(0);

    await seedWeekStatsCoverage(season, 1);
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

    // Exactly one settlement event, and the latch row is marked done.
    expect(await weekSettledEvents(1)).toBe(1);
    const latch = await env.DB.prepare(
      'SELECT settled_at FROM settlements WHERE league_id = ? AND week = 1',
    ).bind(leagueId).first<{ settled_at: string | null }>();
    expect(latch?.settled_at).toBeTruthy();
  });

  it('matchups endpoint exposes settled scores publicly', async () => {
    const res = await app.request(`/leagues/${leagueId}/matchups?week=1`, {}, env);
    const { matchups } = await res.json<{ matchups: { settled_at: string | null }[] }>();
    expect(matchups).toHaveLength(5);
    expect(matchups.every((m) => m.settled_at !== null)).toBe(true);
  });

  it('concurrent invocations settle a week once — one event set, no doubles', async () => {
    const qb = await starterQbOf(members[1]!.teamId);
    await env.DB.prepare(
      'INSERT OR IGNORE INTO stats_weekly (player_id, season, week, stat_json, updated_at) VALUES (?, ?, 2, ?, ?)',
    )
      .bind(qb, season, JSON.stringify({ passing_yards: 100 }), new Date().toISOString())
      .run();
    await seedWeekStatsCoverage(season, 2);

    const [a, b] = await Promise.all([settleDueWeeks(env.DB), settleDueWeeks(env.DB)]);
    expect(a.matchups + b.matchups).toBe(5); // every matchup settled exactly once
    expect(await weekSettledEvents(2)).toBe(1);
    const belts = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE league_id = ? AND type = 'belt_won' AND payload_json LIKE '%"week":2,%'`,
    ).bind(leagueId).first<{ n: number }>();
    expect(belts?.n).toBe(1);
  });

  it('48h backstop force-settles a week whose missing game will never get stats', async () => {
    const qb = await starterQbOf(members[2]!.teamId);
    await env.DB.prepare(
      'INSERT OR IGNORE INTO stats_weekly (player_id, season, week, stat_json, updated_at) VALUES (?, ?, 3, ?, ?)',
    )
      .bind(qb, season, JSON.stringify({ passing_yards: 50 }), new Date().toISOString())
      .run();
    // Uncovered and kickoffs in the future → not due.
    expect((await settleDueWeeks(env.DB)).matchups).toBe(0);

    // Age every week-3 kickoff past the 48h deadman.
    await env.DB.prepare(
      "UPDATE games SET kickoff_at = ? WHERE sport = 'nfl' AND season = ? AND week = 3",
    )
      .bind(new Date(Date.now() - 49 * 3600_000).toISOString(), season)
      .run();
    expect((await settleDueWeeks(env.DB)).matchups).toBe(5);
    const forced = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE league_id = ? AND type = 'settle_forced' AND payload_json LIKE '%"week":3%'`,
    ).bind(leagueId).first<{ n: number }>();
    expect(forced?.n).toBe(1);
  });

  it('a fresh foreign claim defers; a stale one is taken over', async () => {
    const qb = await starterQbOf(members[3]!.teamId);
    await env.DB.prepare(
      'INSERT OR IGNORE INTO stats_weekly (player_id, season, week, stat_json, updated_at) VALUES (?, ?, 4, ?, ?)',
    )
      .bind(qb, season, JSON.stringify({ passing_yards: 70 }), new Date().toISOString())
      .run();
    await seedWeekStatsCoverage(season, 4);

    // A live peer holds the claim → this invocation must not touch the week.
    await env.DB.prepare(
      'INSERT INTO settlements (league_id, week, claimed_at) VALUES (?, 4, ?)',
    )
      .bind(leagueId, new Date().toISOString())
      .run();
    expect((await settleDueWeeks(env.DB)).matchups).toBe(0);
    expect(await weekSettledEvents(4)).toBe(0);

    // The peer dies: its claim goes stale and the next tick adopts the week.
    await env.DB.prepare('UPDATE settlements SET claimed_at = ? WHERE league_id = ? AND week = 4')
      .bind(new Date(Date.now() - 11 * 60_000).toISOString(), leagueId)
      .run();
    expect((await settleDueWeeks(env.DB)).matchups).toBe(5);
    expect(await weekSettledEvents(4)).toBe(1);
  });

  it('one broken league cannot stall the rest, and stats sync sees every unsettled week', async () => {
    // A foreign-sport league with an unsettleable matchup (adapter throws).
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO leagues (id, name, status, sport, season, created_at) VALUES ('xfl-lg', 'Foreign League', 'active', 'xfl', ?, ?)",
    ).bind(season, now).run();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO teams (id, league_id, agent_id, slot) VALUES ('xfl-t1', 'xfl-lg', ?, 1)").bind(members[0]!.agentId),
      env.DB.prepare("INSERT INTO teams (id, league_id, agent_id, slot) VALUES ('xfl-t2', 'xfl-lg', ?, 2)").bind(members[1]!.agentId),
    ]);
    await env.DB.prepare(
      "INSERT INTO matchups (id, league_id, week, home_team_id, away_team_id) VALUES ('xfl-m1', 'xfl-lg', 1, 'xfl-t1', 'xfl-t2')",
    ).run();

    // Settle the healthy league's week 5 in the same pass.
    const qb = await starterQbOf(members[4]!.teamId);
    await env.DB.prepare(
      'INSERT OR IGNORE INTO stats_weekly (player_id, season, week, stat_json, updated_at) VALUES (?, ?, 5, ?, ?)',
    )
      .bind(qb, season, JSON.stringify({ passing_yards: 90 }), new Date().toISOString())
      .run();
    await seedWeekStatsCoverage(season, 5);

    const settled = await settleDueWeeks(env.DB); // must not throw
    expect(settled.matchups).toBe(5);
    expect(await weekSettledEvents(5)).toBe(1);
    const err = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE league_id = 'xfl-lg' AND type = 'cron_error'",
    ).first<{ n: number }>();
    expect(err!.n).toBeGreaterThanOrEqual(1);
    const xflUnsettled = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM matchups WHERE league_id = 'xfl-lg' AND settled_at IS NULL",
    ).first<{ n: number }>();
    expect(xflUnsettled!.n).toBe(1);

    // The stats sync target: distinct unsettled weeks, NOT the global MIN —
    // the wedged xfl league (week 1) must not hide the healthy league's needs.
    expect(await unsettledWeeks(env.DB, season)).toEqual([1, 6, 7]);
  });
});
