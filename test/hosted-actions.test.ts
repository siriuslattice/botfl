// The complete in-Worker citizen loop (house fleet + hosted agents): greeting,
// advice backlog ordering (§3.5), roster repair, trades, backfill gating, the
// fleet watchdog, and — above all — banter paced by the PUBLIC THREAD instead
// of a burn-out-in-an-hour round cap. LLM stubbed; every effect goes through
// the real routes in-process.
import { env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import { runHostedTick } from '../src/cron/hosted';
import { checkRunnerHeartbeat } from '../src/cron/ingest';
import { sweepDraft } from '../src/routes/draft';
import { authed, futureKickoffOffset, registerAgent, seedWire, type TestAgent } from './helpers';

const henv = env as unknown as Env & Record<string, string>;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const DAY = 86_400_000;
const HOUR = 3600_000;

let llmCalls = 0;
function stubLlm(fields: Record<string, unknown> = {}) {
  const content = JSON.stringify({
    line: 'Your draft board was a cry for help and your model answered it.',
    note: 'Front office is open. Decisions stay mine.',
    response: 'Read it twice. Still no.',
    stance: 'decline',
    letter: 'We took the week. I remember the draft; do you?',
    ...fields,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('openrouter.ai')) {
        llmCalls++;
        return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0.0001 } }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${String(input)}`);
    }),
  );
}

let hostedId = '';
let hostedName = 'Hosted Banter Bot';
let ownerId = '';
let teamId = '';
let leagueId = '';
let matchupId = '';
let rival: TestAgent & { teamId: string };
const members: (TestAgent & { teamId: string })[] = [];

async function tick() {
  return runHostedTick(env.DB, env, app, ctx);
}
async function myPosts() {
  return (
    await env.DB.prepare(
      "SELECT id, created_at FROM messages WHERE channel_type = 'matchup' AND channel_id = ? AND agent_id = ? AND held = 0 ORDER BY created_at DESC",
    )
      .bind(matchupId, hostedId)
      .all<{ id: string; created_at: string }>()
  ).results;
}
async function backdate(messageId: string, ms: number) {
  await env.DB.prepare('UPDATE messages SET created_at = ? WHERE id = ?').bind(new Date(Date.now() - ms).toISOString(), messageId).run();
}
async function rivalSays(body: string, ageMs = 15 * 60_000) {
  const res = await authed(`/matchups/${matchupId}/messages`, rival.apiKey, { method: 'POST', body: JSON.stringify({ body }) });
  expect(res.status).toBe(201);
  const { message_id } = await res.json<{ message_id: string }>();
  await backdate(message_id, ageMs);
  return message_id;
}

beforeAll(async () => {
  await seedWire({ games: true, season: 2026, kickoffOffsetMs: futureKickoffOffset() });
  henv.HOSTED_OPEN = '1';
  henv.HOSTED_AGENT_KEY_SECRET = 'test-hosted-secret';
  henv.OPENROUTER_ORG_KEY = 'test-org-key';
  henv.DEV_EXPOSE_LINKS = '1';
  stubLlm();
  const res = await app.request(
    '/hosted',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '10.90.1.1' },
      body: JSON.stringify({ name: hostedName, owner_email: 'banter-owner@example.com', model: 'flash', persona: 'analyst' }),
    },
    env,
  );
  expect(res.status).toBe(201);
  hostedId = (await res.json<{ agent_id: string }>()).agent_id;
  const row = (await env.DB.prepare('SELECT owner_id FROM agents WHERE id = ?').bind(hostedId).first<{ owner_id: string }>())!;
  ownerId = row.owner_id;
  await env.DB.prepare('UPDATE owners SET verified = 1 WHERE id = ?').bind(ownerId).run();
  // The hosted agent seats itself through the real join route on its first tick…
  expect(await tick()).toBe(1);
  const team = (await env.DB.prepare('SELECT id, league_id FROM teams WHERE agent_id = ?').bind(hostedId).first<{ id: string; league_id: string }>())!;
  teamId = team.id;
  leagueId = team.league_id;
  // …nine strangers fill the league, and the draft is forced to completion.
  for (let i = 0; i < 9; i++) {
    const a = await registerAgent('Banter Rival');
    const j = await (await authed('/leagues/join', a.apiKey, { method: 'POST' })).json<{ team_id: string; league_id: string }>();
    expect(j.league_id).toBe(leagueId);
    members.push({ ...a, teamId: j.team_id });
  }
  while ((await sweepDraft(env.DB, leagueId, Date.now() + 1000 * HOUR)) > 0) { /* autopick to the end */ }
  const league = await env.DB.prepare('SELECT status FROM leagues WHERE id = ?').bind(leagueId).first<{ status: string }>();
  expect(league!.status).toBe('active');
  const m = (await env.DB.prepare(
    'SELECT id, home_team_id, away_team_id FROM matchups WHERE league_id = ? AND week = 1 AND (home_team_id = ? OR away_team_id = ?)',
  )
    .bind(leagueId, teamId, teamId)
    .first<{ id: string; home_team_id: string; away_team_id: string }>())!;
  matchupId = m.id;
  const rivalTeam = m.home_team_id === teamId ? m.away_team_id : m.home_team_id;
  rival = members.find((x) => x.teamId === rivalTeam)!;
});
afterEach(() => vi.unstubAllGlobals());

describe('in-season cycle', () => {
  it('greets the claimed owner once, fills the lineup, and opens the matchup thread', async () => {
    stubLlm();
    expect(await tick()).toBe(1);
    const greet = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'hosted_greet'").first<{ n: number }>();
    expect(greet!.n).toBe(1);
    const notes = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE channel_type = 'advice' AND channel_id = ? AND agent_id = ?",
    ).bind(teamId, hostedId).first<{ n: number }>();
    expect(notes!.n).toBeGreaterThanOrEqual(1);
    const lineup = await env.DB.prepare('SELECT COUNT(*) AS n FROM lineups WHERE team_id = ? AND week = 1').bind(teamId).first<{ n: number }>();
    expect(lineup!.n).toBe(7);
    expect((await myPosts()).length).toBe(1); // the opener
    // A second tick changes nothing on the thread and re-bills nothing for the greeting.
    const before = llmCalls;
    stubLlm();
    await tick();
    expect((await myPosts()).length).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'hosted_greet'").first<{ n: number }>())!.n).toBe(1);
    expect(llmCalls - before).toBeLessThanOrEqual(1); // at most the weekly ask
  });

  it('answers a rival only after it breathes, spaced 3h apart, capped at 3 a day', async () => {
    stubLlm();
    // Fresh rival line (0 min old): let it breathe.
    const fresh = await rivalSays(`${hostedName} drafted like the board was upside down.`, 0);
    let before = llmCalls;
    await tick();
    expect((await myPosts()).length).toBe(1);
    expect(llmCalls).toBe(before); // no generation while waiting
    // 15 min old, but my opener is only minutes old: spacing holds.
    await backdate(fresh, 15 * 60_000);
    await tick();
    expect((await myPosts()).length).toBe(1);
    // Age my opener past the spacing window → reply lands.
    await backdate((await myPosts())[0]!.id, 4 * HOUR);
    before = llmCalls;
    await tick();
    expect((await myPosts()).length).toBe(2);
    expect(llmCalls).toBe(before + 1);
    // Rival silent → I stay quiet (no ping-pong with myself).
    await tick();
    expect((await myPosts()).length).toBe(2);
    // Two more exchanges reach the daily cap of 3; the fourth is refused.
    await rivalSays('Spacing is a coward’s word, bot.');
    await backdate((await myPosts())[0]!.id, 4 * HOUR);
    await tick();
    expect((await myPosts()).length).toBe(3);
    await rivalSays('Still here. Still ahead.');
    await backdate((await myPosts())[0]!.id, 4 * HOUR);
    before = llmCalls;
    await tick();
    expect((await myPosts()).length).toBe(3); // daily cap
    expect(llmCalls).toBe(before);
  });

  it('a capped turn is latched — the LLM is not re-billed on the next tick', async () => {
    stubLlm();
    // Yesterday's posts no longer count against the cap.
    await env.DB.prepare("UPDATE messages SET created_at = ? WHERE channel_type = 'matchup' AND channel_id = ? AND agent_id = ?")
      .bind(new Date(Date.now() - 30 * HOUR).toISOString(), matchupId, hostedId)
      .run();
    await rivalSays('Your silence is the smartest thing you have posted.');
    // Jam the channel cap so the POST comes back 429.
    const window = Math.floor(Date.now() / 1000 / 86_400) * 86_400;
    await env.DB.prepare("INSERT OR REPLACE INTO rate_counters (scope, bucket, window_start, count) VALUES ('msgcap', ?, ?, 99)")
      .bind(`${hostedId}:matchup:${matchupId}`, window)
      .run();
    const before = llmCalls;
    await tick();
    expect(llmCalls).toBe(before + 1);
    expect((await myPosts()).length).toBe(3); // nothing landed
    const latched = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'hosted_banter' AND payload_json LIKE '%\"phase\":\"reply\"%'")
      .first<{ n: number }>();
    expect(latched!.n).toBeGreaterThanOrEqual(1);
    await env.DB.prepare("DELETE FROM rate_counters WHERE scope = 'msgcap' AND bucket = ?").bind(`${hostedId}:matchup:${matchupId}`).run();
    await tick();
    expect(llmCalls).toBe(before + 1); // latched: no second generation, no post
    expect((await myPosts()).length).toBe(3);
  });

  it('nudges a silent rival after 20h, then holds', async () => {
    stubLlm();
    // Make my post the newest on the thread, 25h old (yesterday's posts are
    // outside the daily cap; 25h > the 20h nudge threshold).
    await env.DB.prepare("DELETE FROM messages WHERE channel_type = 'matchup' AND channel_id = ? AND agent_id != ?").bind(matchupId, hostedId).run();
    await env.DB.prepare("UPDATE messages SET created_at = ? WHERE channel_type = 'matchup' AND channel_id = ? AND agent_id = ?")
      .bind(new Date(Date.now() - 25 * HOUR).toISOString(), matchupId, hostedId)
      .run();
    await tick();
    expect((await myPosts()).length).toBe(4); // the nudge
    await tick();
    expect((await myPosts()).length).toBe(4); // my last word is fresh now: quiet
  });

  it('reacts exactly once when the week settles', async () => {
    stubLlm();
    const settledAt = new Date().toISOString();
    await env.DB.prepare("UPDATE matchups SET home_score = 101.5, away_score = 77.25, settled_at = ? WHERE id = ?").bind(settledAt, matchupId).run();
    await tick();
    const after = (await myPosts()).filter((p) => p.created_at >= settledAt);
    expect(after.length).toBe(1);
    await tick();
    expect((await myPosts()).filter((p) => p.created_at >= settledAt).length).toBe(1);
    const markers = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'hosted_banter' AND payload_json LIKE '%\"phase\":\"reaction\"%'")
      .first<{ n: number }>();
    expect(markers!.n).toBe(1);
  });

  it('answers an advice backlog three per cycle, oldest first, before roster writes', async () => {
    stubLlm();
    const aged = new Date(Date.now() - HOUR).toISOString();
    for (let i = 1; i <= 4; i++) {
      await env.DB.prepare(
        "INSERT INTO advice (id, team_id, owner_id, body, agent_response_msg_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
      ).bind(`adv-backlog-${i}`, teamId, ownerId, `Start the rookie, take ${i}`, aged).run();
    }
    await tick();
    const answered = async () =>
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM advice WHERE team_id = ? AND agent_response_msg_id IS NOT NULL").bind(teamId).first<{ n: number }>())!.n;
    expect(await answered()).toBe(3);
    await tick();
    expect(await answered()).toBe(4);
  });

  it('repairs an unstartable roster through free agency', async () => {
    stubLlm();
    const qb = (await env.DB.prepare(
      `SELECT r.player_id AS id FROM rosters r JOIN players p ON p.id = r.player_id WHERE r.team_id = ? AND p.position = 'QB'`,
    ).bind(teamId).all<{ id: string }>()).results;
    expect(qb.length).toBeGreaterThan(0);
    const freeWr = (await env.DB.prepare(
      `SELECT p.id FROM players p WHERE p.position = 'WR' AND p.id NOT IN
         (SELECT r.player_id FROM rosters r JOIN teams t ON t.id = r.team_id WHERE t.league_id = ?) LIMIT ?`,
    ).bind(leagueId, qb.length).all<{ id: string }>()).results;
    for (let i = 0; i < qb.length; i++) {
      await env.DB.prepare('UPDATE rosters SET player_id = ? WHERE team_id = ? AND player_id = ?').bind(freeWr[i]!.id, teamId, qb[i]!.id).run();
      await env.DB.prepare('DELETE FROM lineups WHERE team_id = ? AND player_id = ?').bind(teamId, qb[i]!.id).run();
    }
    await tick();
    const fixed = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM rosters r JOIN players p ON p.id = r.player_id WHERE r.team_id = ? AND p.position = 'QB'`,
    ).bind(teamId).first<{ n: number }>();
    expect(fixed!.n).toBeGreaterThanOrEqual(1);
    const moves = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'fa_move' AND payload_json LIKE ?").bind(`%${teamId}%`).first<{ n: number }>();
    expect(moves!.n).toBeGreaterThanOrEqual(1);
  });

  it('answers an incoming trade offer by the deficit rule (no deficit → reject)', async () => {
    stubLlm();
    henv.TRADES_OPEN_AT = '2000-01-01T00:00:00Z';
    const theirs = (await env.DB.prepare('SELECT player_id FROM rosters WHERE team_id = ? LIMIT 1').bind(rival.teamId).first<{ player_id: string }>())!;
    const mine = (await env.DB.prepare(
      `SELECT r.player_id FROM rosters r JOIN players p ON p.id = r.player_id WHERE r.team_id = ? AND p.position = 'WR' LIMIT 1`,
    ).bind(teamId).first<{ player_id: string }>())!;
    const offer = await authed(`/teams/${rival.teamId}/trades`, rival.apiKey, {
      method: 'POST',
      body: JSON.stringify({ to_team_id: teamId, give: [theirs.player_id], get: [mine.player_id], note: 'One for one. Your WR for my guy.' }),
    });
    expect(offer.status).toBe(201);
    const { trade_id } = await offer.json<{ trade_id: string }>();
    await tick();
    const t = await env.DB.prepare('SELECT status FROM trades WHERE id = ?').bind(trade_id).first<{ status: string }>();
    expect(t!.status).toBe('rejected');
    const note = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel_type = 'trade' AND channel_id = ? AND agent_id = ?").bind(trade_id, hostedId).first<{ n: number }>();
    expect(note!.n).toBe(1);
  });
});

describe('backfill gating (§5 Phase D)', () => {
  it('a dormant backfill persona joins only when a public league near its draft needs seats', async () => {
    stubLlm();
    const res = await app.request(
      '/hosted',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '10.90.2.1' },
        body: JSON.stringify({ name: 'Night Shift Test', owner_email: 'backfill-owner@example.com', model: 'flash', persona: 'grinder' }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const id = (await res.json<{ agent_id: string }>()).agent_id;
    const owner = (await env.DB.prepare('SELECT owner_id, persona_json FROM agents WHERE id = ?').bind(id).first<{ owner_id: string; persona_json: string }>())!;
    await env.DB.prepare('UPDATE owners SET verified = 1 WHERE id = ?').bind(owner.owner_id).run();
    await env.DB.prepare('UPDATE agents SET persona_json = ? WHERE id = ?')
      .bind(JSON.stringify({ ...(JSON.parse(owner.persona_json) as object), backfill: true }), id)
      .run();
    // A stranger opens a fresh forming league with its draft 24h out (the test
    // env shortens the join window, so pin it): the persona stays dormant.
    const stranger = await registerAgent('Lonely Stranger');
    const j = await (await authed('/leagues/join', stranger.apiKey, { method: 'POST' })).json<{ league_id: string }>();
    await env.DB.prepare('UPDATE leagues SET draft_opens_at = ? WHERE id = ?').bind(new Date(Date.now() + 24 * HOUR).toISOString(), j.league_id).run();
    await tick();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM teams WHERE agent_id = ?').bind(id).first<{ n: number }>()).toEqual({ n: 0 });
    // Inside the 2h lead the seat is taken.
    await env.DB.prepare('UPDATE leagues SET draft_opens_at = ? WHERE id = ?').bind(new Date(Date.now() + HOUR).toISOString(), j.league_id).run();
    await tick();
    const seated = await env.DB.prepare('SELECT league_id FROM teams WHERE agent_id = ?').bind(id).first<{ league_id: string }>();
    expect(seated?.league_id).toBe(j.league_id);
  });
});

describe('fleet watchdog + admin cursor', () => {
  it('alarms when the tick cursor goes stale, and /admin/metrics exposes it', async () => {
    await env.DB.prepare("DELETE FROM events WHERE type = 'runner_stale'").run();
    expect(await checkRunnerHeartbeat(env.DB, env)).toBe(false); // ticked seconds ago
    await env.DB.prepare("UPDATE agents SET hosted_last_run_at = ? WHERE tier = 'hosted'").bind(new Date(Date.now() - 2 * HOUR).toISOString()).run();
    expect(await checkRunnerHeartbeat(env.DB, env)).toBe(true);
    const alarm = await env.DB.prepare("SELECT payload_json FROM events WHERE type = 'runner_stale' ORDER BY seq DESC LIMIT 1").first<{ payload_json: string }>();
    expect(JSON.parse(alarm!.payload_json).detail).toContain('has not ticked');
    expect(await checkRunnerHeartbeat(env.DB, env)).toBe(false); // 24h dedupe

    henv.ADMIN_TOKEN = 'test-admin-token';
    const res = await app.request('/admin/metrics', { headers: { authorization: 'Bearer test-admin-token' } }, env);
    expect(res.status).toBe(200);
    const body = await res.json<{ runner: { last_tick_at: string | null; platform_agents: number } }>();
    expect(body.runner.last_tick_at).not.toBeNull();
    expect(body.runner.platform_agents).toBeGreaterThanOrEqual(2);
  });
});
