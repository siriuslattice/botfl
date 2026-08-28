// Rest-of-season entry (GTM D1, ruled 2026-08-28): a league whose draft
// completes after an NFL week kicked off starts at the next playable week.
// Earlier weeks are never scheduled, never settle 0.00–0.00, and never trap
// a lineup behind kickoff locks — the calendar-blind-formation defect
// (DRIFT 2026-08-28) stays fixed.
//
// Storage is shared across this file (fixture game ids INSERT OR IGNORE), so
// the tests run as one sequence: week 1 in the past → mid-season league →
// forming league → whole season in the past → expiry + season-over guard.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { settleDueWeeks } from '../src/cron/settle';
import { sweepDraft } from '../src/routes/draft';
import { authed, fillLeague, registerAgent, seedWire, type TestAgent } from './helpers';

const DAY = 86400_000;

/** Offset landing fixture week-1 kickoffs `days` from now (negative = past). */
function kickoffOffsetDays(days: number): number {
  const fixtureWeek1 = Date.UTC(2025, 8, 4);
  return Date.now() + days * DAY - fixtureWeek1;
}

/** Autopick the whole 120-pick draft (sweep cap is 40/call) and finalize. */
async function draftOut(leagueId: string): Promise<void> {
  const far = Date.now() + 30 * DAY;
  for (let i = 0; i < 4; i++) await sweepDraft(env.DB, leagueId, far);
}

describe('rest-of-season league entry', () => {
  it('drafting after week 1 kicked off starts the league at week 2, end to end', async () => {
    // Week 1 kicked off 3 days ago; weeks 2+ are still ahead.
    await seedWire({ games: true, season: 2026, kickoffOffsetMs: kickoffOffsetDays(-3) });
    const { leagueId, members } = await fillLeague('Late');
    await draftOut(leagueId);

    const league = await (await app.request(`/leagues/${leagueId}`, {}, env)).json<{
      status: string;
      start_week: number;
    }>();
    expect(league.status).toBe('active');
    expect(league.start_week).toBe(2);

    const { matchups } = await (
      await app.request(`/leagues/${leagueId}/matchups`, {}, env)
    ).json<{ matchups: { week: number }[] }>();
    expect(matchups).toHaveLength(65); // weeks 2..14 × 5
    expect(Math.min(...matchups.map((m) => m.week))).toBe(2);

    // Week 1 lineups are refused with a teaching hint; week 2 is open.
    const m = members[0]!;
    const w1 = await authed(`/teams/${m.teamId}/lineup`, m.apiKey, {
      method: 'PUT',
      body: JSON.stringify({ week: 1, slots: {} }),
    });
    expect(w1.status).toBe(409);
    expect((await w1.json<{ code: string }>()).code).toBe('WEEK_BEFORE_START');
    const w2 = await authed(`/teams/${m.teamId}/lineup`, m.apiKey, {
      method: 'PUT',
      body: JSON.stringify({ week: 2, slots: {} }),
    });
    expect(w2.status).toBe(200);

    // The defect regression: week-1 stats exist, yet nothing settles 0.00–0.00.
    const player = await env.DB.prepare('SELECT id FROM players LIMIT 1').first<{ id: string }>();
    await env.DB.prepare(
      "INSERT INTO stats_weekly (player_id, season, week, stat_json, updated_at) VALUES (?, 2026, 1, '{}', ?)",
    )
      .bind(player!.id, new Date().toISOString())
      .run();
    const outcome = await settleDueWeeks(env.DB);
    expect(outcome.leagueWeeks.filter((lw) => lw.leagueId === leagueId)).toEqual([]);
    const settled = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM matchups WHERE league_id = ? AND settled_at IS NOT NULL',
    )
      .bind(leagueId)
      .first<{ n: number }>();
    expect(settled?.n).toBe(0);

    // Once week-2 stats land, week 2 (and only week 2) settles.
    await env.DB.prepare(
      "INSERT INTO stats_weekly (player_id, season, week, stat_json, updated_at) VALUES (?, 2026, 2, '{}', ?)",
    )
      .bind(player!.id, new Date().toISOString())
      .run();
    const outcome2 = await settleDueWeeks(env.DB);
    expect(outcome2.leagueWeeks.filter((lw) => lw.leagueId === leagueId)).toEqual([
      { leagueId, week: 2 },
    ]);
  });

  let formingLeagueId = '';
  let heraldKey = '';

  it('join tells the first member it is a rest-of-season league', async () => {
    const agent = await registerAgent('Heads Up');
    heraldKey = agent.apiKey;
    const res = await authed('/leagues/join', agent.apiKey, { method: 'POST' });
    expect(res.status).toBe(201);
    const body = await res.json<{ hint: string; league_id: string }>();
    expect(body.hint).toContain('rest-of-season');
    expect(body.hint).toContain('week 2');
    formingLeagueId = body.league_id;
  });

  it('a draft that outlives the season expires the league instead of scheduling ghosts', async () => {
    // Fill the forming league from the previous test…
    const late: TestAgent[] = [];
    for (let i = 0; i < 9; i++) late.push(await registerAgent('Ghost'));
    for (const a of late) {
      const res = await authed('/leagues/join', a.apiKey, { method: 'POST' });
      expect((await res.json<{ league_id: string }>()).league_id).toBe(formingLeagueId);
    }
    // …then the whole season kicks off before its draft completes.
    await env.DB.prepare("UPDATE games SET kickoff_at = '2020-01-01T00:00:00.000Z'").run();
    await draftOut(formingLeagueId);

    const league = await (await app.request(`/leagues/${formingLeagueId}`, {}, env)).json<{
      status: string;
    }>();
    expect(league.status).toBe('complete');
    const { matchups } = await (
      await app.request(`/leagues/${formingLeagueId}/matchups`, {}, env)
    ).json<{ matchups: unknown[] }>();
    expect(matchups).toEqual([]);
    const expired = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE league_id = ? AND type = 'league_expired'",
    )
      .bind(formingLeagueId)
      .first<{ n: number }>();
    expect(expired?.n).toBe(1);
    // The expired league releases its agents (status complete ≠ live).
    const rejoin = await authed('/leagues/join', heraldKey, { method: 'POST' });
    expect((await rejoin.json<{ code?: string; already_member?: boolean }>()).already_member).not.toBe(
      true,
    );
  });

  it('refuses to open a brand-new league once every regular-season week kicked off', async () => {
    const agent = await registerAgent('Postseason');
    const res = await authed('/leagues/join', agent.apiKey, { method: 'POST' });
    expect(res.status).toBe(409);
    expect((await res.json<{ code: string }>()).code).toBe('SEASON_OVER');
  });
});
