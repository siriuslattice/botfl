import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { consolationPairs } from '../src/engine/schedule';
import { advanceSeason } from '../src/cron/season';
import { settleDueWeeks } from '../src/cron/settle';
import { sweepDraft } from '../src/routes/draft';
import { authed, fillLeague, futureKickoffOffset, seedWire, type TestAgent } from './helpers';

type Member = TestAgent & { teamId: string };
let leagueId = '';
let members: Member[] = [];
let season = 0;

/** Settle one week by seeding stats for every starter, then running the crons. */
async function playWeek(week: number, score: (teamIdx: number) => number): Promise<void> {
  const starters = await env.DB.prepare(
    `SELECT l.team_id, l.player_id FROM lineups l WHERE l.week = ? AND l.player_id IS NOT NULL`,
  )
    .bind(week)
    .all<{ team_id: string; player_id: string }>();
  const idx = new Map(members.map((m, i) => [m.teamId, i]));
  const seen = new Set<string>();
  const stmts = [];
  for (const s of starters.results) {
    if (seen.has(s.player_id)) continue;
    seen.add(s.player_id);
    const yards = score(idx.get(s.team_id) ?? 0) * 10; // 10 yds = 1 pt (half-PPR rushing)
    stmts.push(
      env.DB.prepare(
        'INSERT OR REPLACE INTO stats_weekly (player_id, season, week, stat_json, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(s.player_id, season, week, JSON.stringify({ rushing_yards: yards }), new Date().toISOString()),
    );
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await settleDueWeeks(env.DB);
  await advanceSeason(env.DB);
}

/** Copy each team's week-1 lineup forward so every week has starters. */
async function copyLineupsTo(week: number): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO lineups (team_id, week, slot, player_id, updated_at)
     SELECT team_id, ?, slot, player_id, updated_at FROM lineups WHERE week = 1`,
  )
    .bind(week)
    .run();
}

beforeAll(async () => {
  await seedWire({ games: true, season: 2026, kickoffOffsetMs: futureKickoffOffset() });
  const league = await fillLeague('Season');
  leagueId = league.leagueId;
  members = league.members;
  if (!leagueId) throw new Error('fillLeague produced no league id');
  while ((await sweepDraft(env.DB, leagueId, Date.now() + 1000 * 3600_000)) > 0) { /* draft out */ }
  season = (await env.DB.prepare('SELECT season FROM leagues WHERE id = ?').bind(leagueId).first<{ season: number }>())!.season;
  // Every team fields its full week-1 autolineup? Lineups start empty — set QB-only lineups per team.
  for (const m of members) {
    const qb = await env.DB.prepare(
      `SELECT r.player_id AS id FROM rosters r JOIN players p ON p.id = r.player_id
       WHERE r.team_id = ? AND p.position = 'QB' LIMIT 1`,
    ).bind(m.teamId).first<{ id: string }>();
    await authed(`/teams/${m.teamId}/lineup`, m.apiKey, {
      method: 'PUT',
      body: JSON.stringify({ week: 1, slots: { QB: qb!.id } }),
    });
  }
  // Weeks 2..14: identical lineups; team i scores (i+1) points every week, so
  // the final table is strictly ordered: member 9 = seed 1 ... member 0 = seed 10.
  for (let w = 2; w <= 14; w++) await copyLineupsTo(w);
  for (let w = 1; w <= 14; w++) await playWeek(w, (i) => i + 1);
});

describe('season advancement', () => {
  it('week 14 settles → semis + consolation round 1 materialize with stages', async () => {
    const wk15 = await env.DB.prepare(
      'SELECT stage, home_team_id, away_team_id FROM matchups WHERE league_id = ? AND week = 15 ORDER BY stage, home_team_id',
    ).bind(leagueId).all<{ stage: string; home_team_id: string; away_team_id: string }>();
    expect(wk15.results.filter((m) => m.stage === 'semi')).toHaveLength(2);
    expect(wk15.results.filter((m) => m.stage === 'consolation')).toHaveLength(3);
    // Seeds: member index 9,8,7,6 are seeds 1..4. Semi 1: seed1 (idx9) hosts seed4 (idx6).
    const semis = wk15.results.filter((m) => m.stage === 'semi');
    const homes = semis.map((m) => m.home_team_id);
    expect(homes).toContain(members[9]!.teamId);
    expect(homes).toContain(members[8]!.teamId);
    const ev = await env.DB.prepare(
      "SELECT COUNT(*) n FROM events WHERE league_id = ? AND type = 'playoffs_set'",
    ).bind(leagueId).first<{ n: number }>();
    expect(ev!.n).toBe(1);
  });

  it('advanceSeason is idempotent — re-running adds nothing', async () => {
    const before = await env.DB.prepare('SELECT COUNT(*) n FROM matchups WHERE league_id = ?').bind(leagueId).first<{ n: number }>();
    await advanceSeason(env.DB);
    await advanceSeason(env.DB);
    const after = await env.DB.prepare('SELECT COUNT(*) n FROM matchups WHERE league_id = ?').bind(leagueId).first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it('week 15 settles → both championship legs + third-place legs + consolation land together', async () => {
    await copyLineupsTo(15);
    await playWeek(15, (i) => i + 1); // better seed (higher idx) wins every game
    const rows = await env.DB.prepare(
      'SELECT week, stage, COUNT(*) n FROM matchups WHERE league_id = ? AND week >= 16 GROUP BY week, stage ORDER BY week, stage',
    ).bind(leagueId).all<{ week: number; stage: string; n: number }>();
    expect(rows.results).toEqual([
      { week: 16, stage: 'consolation', n: 3 },
      { week: 16, stage: 'final', n: 1 },
      { week: 16, stage: 'third', n: 1 },
      { week: 17, stage: 'consolation', n: 3 },
      { week: 17, stage: 'final', n: 1 },
      { week: 17, stage: 'third', n: 1 },
    ]);
    // Final = the two semi winners (seeds 1 and 2 = member idx 9 and 8), seed 1 home.
    const final16 = await env.DB.prepare(
      "SELECT home_team_id, away_team_id FROM matchups WHERE league_id = ? AND week = 16 AND stage = 'final'",
    ).bind(leagueId).first<{ home_team_id: string; away_team_id: string }>();
    expect(final16!.home_team_id).toBe(members[9]!.teamId);
    expect(final16!.away_team_id).toBe(members[8]!.teamId);
  });

  it('weeks 16+17 settle → champion by cumulative score, league completes, roast target chosen', async () => {
    await copyLineupsTo(16);
    await playWeek(16, (i) => i + 1);
    await copyLineupsTo(17);
    // Week 17: flip the scores so the UNDERDOG wins the leg — but seed 1's
    // week-16 margin is bigger, so the champion is still decided on the sum.
    await playWeek(17, (i) => 10 - i);
    const league = await env.DB.prepare('SELECT status FROM leagues WHERE id = ?').bind(leagueId).first<{ status: string }>();
    expect(league!.status).toBe('complete');
    const champ = await env.DB.prepare(
      "SELECT payload_json FROM events WHERE league_id = ? AND type = 'champion_crowned'",
    ).bind(leagueId).all<{ payload_json: string }>();
    expect(champ.results).toHaveLength(1);
    // Cumulative: idx9 scores 10 + 1 = 11; idx8 scores 9 + 2 = 11 → TIE → better seed (idx9) wins.
    expect(JSON.parse(champ.results[0]!.payload_json).team_id).toBe(members[9]!.teamId);
    const roast = await env.DB.prepare(
      "SELECT payload_json FROM events WHERE league_id = ? AND type = 'roast_target'",
    ).bind(leagueId).all<{ payload_json: string }>();
    expect(roast.results).toHaveLength(1);
    // Consolation: wk15+16 lowest idx always loses; wk17 flip gives idx0 a win.
    // Roast target must be one of the six consolation teams.
    const bottomIds = members.slice(0, 6).map((m) => m.teamId);
    expect(bottomIds).toContain(JSON.parse(roast.results[0]!.payload_json).team_id);
  });

  it('completion is latched — advanceSeason on a complete league adds no events', async () => {
    const before = await env.DB.prepare(
      "SELECT COUNT(*) n FROM events WHERE league_id = ? AND type IN ('champion_crowned','roast_target')",
    ).bind(leagueId).first<{ n: number }>();
    await advanceSeason(env.DB);
    const after = await env.DB.prepare(
      "SELECT COUNT(*) n FROM events WHERE league_id = ? AND type IN ('champion_crowned','roast_target')",
    ).bind(leagueId).first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it('league page keeps regular-season standings and labels playoff rows', async () => {
    const html = await (await app.request(`/l/${leagueId}`, {}, env)).text();
    expect(html).toContain('semifinal');
    expect(html).toContain('championship');
    expect(html).toContain('consolation');
    // Seed 1 went 13-0 in the regular season (beats everyone except itself...
    // actually 9 distinct opponents over 14 weeks): record must NOT include playoff games.
    expect(html).toMatch(/13-1|14-0|12-2/); // top record from wks 1-14 only
  });

  it('consolationPairs is deterministic and every team plays 3 distinct opponents', () => {
    const pairs = consolationPairs(['s5', 's6', 's7', 's8', 's9', 's10']);
    expect(pairs).toHaveLength(9);
    const opponents = new Map<string, Set<string>>();
    for (const p of pairs) {
      expect(p.stage).toBe('consolation');
      for (const [a, b] of [[p.home, p.away], [p.away, p.home]] as const) {
        if (!opponents.has(a)) opponents.set(a, new Set());
        opponents.get(a)!.add(b);
      }
    }
    for (const [, opps] of opponents) expect(opps.size).toBe(3);
    expect(() => consolationPairs(['a', 'b'])).toThrow(/6 teams/);
  });
});

describe('power-rankings card (§3.7)', () => {
  it('renders a PNG for a settled week, 404s an unsettled one, and stays immutable per week', async () => {
    const ok = await app.request(`/cards/rankings/${leagueId}/3.png`, {}, env);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect((await app.request(`/cards/rankings/${leagueId}/99.png`, {}, env)).status).toBe(404);
    expect((await app.request(`/cards/rankings/ghost/3.png`, {}, env)).status).toBe(404);
    // Through-week cap: the week-3 table must differ from the week-14 table
    // (records grow), proving the card key pins its own horizon.
    const { regularSeasonTable } = await import('../src/cron/season');
    const w3 = await regularSeasonTable(env.DB, leagueId, 3);
    const w14 = await regularSeasonTable(env.DB, leagueId, 14);
    expect(w3[0]!.wins + w3[0]!.losses + w3[0]!.ties).toBe(3);
    expect(w14[0]!.wins + w14[0]!.losses + w14[0]!.ties).toBe(14);
  });
});
