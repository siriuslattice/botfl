// Trades (SPEC §3.4.4): state machine, atomic accept with reversal, kickoff
// locks, the Sep 22 gate, and the mandatory moderated negotiation thread.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { sweepDraft } from '../src/routes/draft';
import { authed, fillLeague, futureKickoffOffset, seedWire, type TestAgent } from './helpers';

type Member = TestAgent & { teamId: string };
let leagueId = '';
let members: Member[] = [];
let A: Member; // proposer
let B: Member; // counterparty
let C: Member; // outsider (same league)

// vitest env: TRADES_OPEN_AT is set in the past via test env vars? Not set →
// code default 2026-09-22. Tests must control it — env bindings come from
// cloudflare:test env, so mutate env directly (it's a plain object binding).
function openTrades(): void {
  (env as { TRADES_OPEN_AT?: string }).TRADES_OPEN_AT = '2020-01-01T00:00:00Z';
}
function closeTrades(): void {
  (env as { TRADES_OPEN_AT?: string }).TRADES_OPEN_AT = '2099-01-01T00:00:00Z';
}

async function rosterOf(teamId: string): Promise<string[]> {
  const rows = await env.DB.prepare('SELECT player_id FROM rosters WHERE team_id = ? ORDER BY player_id')
    .bind(teamId)
    .all<{ player_id: string }>();
  return rows.results.map((r) => r.player_id);
}

/** A same-position player pair so the swap never bends roster shape. */
async function tradablePair(): Promise<{ give: string; get: string; position: string }> {
  const row = await env.DB.prepare(
    `SELECT ra.player_id AS give, rb.player_id AS get, pa.position AS position
     FROM rosters ra JOIN players pa ON pa.id = ra.player_id
     JOIN rosters rb JOIN players pb ON pb.id = rb.player_id
     WHERE ra.team_id = ? AND rb.team_id = ? AND pa.position = pb.position
     LIMIT 1`,
  )
    .bind(A.teamId, B.teamId)
    .first<{ give: string; get: string; position: string }>();
  return row!;
}

beforeAll(async () => {
  await seedWire({ games: true, season: 2026, kickoffOffsetMs: futureKickoffOffset() });
  const league = await fillLeague('Trader');
  leagueId = league.leagueId;
  members = league.members;
  [A, B, C] = [members[0]!, members[1]!, members[2]!];
  while ((await sweepDraft(env.DB, leagueId, Date.now() + 1000 * 3600_000)) > 0) { /* draft */ }
  openTrades();
});

describe('trades', () => {
  it('gate: before TRADES_OPEN_AT every write 403s with the date', async () => {
    closeTrades();
    const res = await authed(`/teams/${A.teamId}/trades`, A.apiKey, {
      method: 'POST',
      body: JSON.stringify({ to_team_id: B.teamId, give: ['x'], get: ['y'], note: 'hi' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json<{ code: string; hint: string }>();
    expect(body.code).toBe('TRADES_NOT_OPEN');
    expect(body.hint).toContain('2099');
    openTrades();
  });

  it('full loop: propose → thread message → counter → accept executes both rosters', async () => {
    const pair = await tradablePair();
    const res = await authed(`/teams/${A.teamId}/trades`, A.apiKey, {
      method: 'POST',
      body: JSON.stringify({
        to_team_id: B.teamId,
        give: [pair.give],
        get: [pair.get],
        note: 'One for one, same position. Your depth chart thanks me.',
      }),
    });
    expect(res.status).toBe(201);
    const { trade_id } = await res.json<{ trade_id: string }>();

    // The pitch is on the public thread.
    const thread = await app.request(`/trades/${trade_id}/messages`, {}, env);
    const msgs = await thread.json<{ messages: { body: string; author: string }[] }>();
    expect(msgs.messages).toHaveLength(1);
    expect(msgs.messages[0]!.body).toContain('depth chart');
    expect(msgs.messages[0]!.author).toBe(A.name);

    // Outsider cannot answer.
    const nope = await authed(`/trades/${trade_id}/accept`, C.apiKey, { method: 'POST', body: '{}' });
    expect(nope.status).toBe(403);

    // B counters: flip the same players.
    const counter = await authed(`/trades/${trade_id}/counter`, B.apiKey, {
      method: 'POST',
      body: JSON.stringify({ give: [pair.get], get: [pair.give], note: 'Counter: same trade, my terms.' }),
    });
    expect(counter.status).toBe(201);
    const counterBody = await counter.json<{ trade_id: string; counter_of: string }>();
    expect(counterBody.counter_of).toBe(trade_id);
    const original = await env.DB.prepare('SELECT status FROM trades WHERE id = ?').bind(trade_id).first<{ status: string }>();
    expect(original!.status).toBe('countered');

    // A accepts the counter → players swap; acquired_via = 'trade'.
    const beforeA = await rosterOf(A.teamId);
    const accept = await authed(`/trades/${counterBody.trade_id}/accept`, A.apiKey, {
      method: 'POST',
      body: JSON.stringify({ note: 'Done. History will judge you for this.' }),
    });
    expect(accept.status).toBe(200);
    const afterA = await rosterOf(A.teamId);
    expect(afterA).toHaveLength(12);
    expect(await rosterOf(B.teamId)).toHaveLength(12);
    expect(afterA).toContain(pair.get);
    expect(afterA).not.toContain(pair.give);
    expect(beforeA).toContain(pair.give);
    const via = await env.DB.prepare('SELECT acquired_via FROM rosters WHERE team_id = ? AND player_id = ?')
      .bind(A.teamId, pair.get)
      .first<{ acquired_via: string }>();
    expect(via!.acquired_via).toBe('trade');

    // Feed narrates with names; event carries ids only.
    const html = await (await app.request(`/l/${leagueId}`, {}, env)).text();
    expect(html).toContain('TRADE:');

    // Accepting again → resolved.
    const again = await authed(`/trades/${counterBody.trade_id}/accept`, A.apiKey, { method: 'POST', body: '{}' });
    expect(again.status).toBe(409);
  });

  it('validation: junk shapes, self-trade, unequal counts, foreign players', async () => {
    const post = (body: unknown) =>
      authed(`/teams/${A.teamId}/trades`, A.apiKey, { method: 'POST', body: JSON.stringify(body) });
    expect((await post({})).status).toBe(422);
    expect((await post({ to_team_id: A.teamId, give: ['x'], get: ['y'], note: 'me' })).status).toBe(422);
    expect((await post({ to_team_id: B.teamId, give: ['x', 'y'], get: ['z'], note: 'n' })).status).toBe(422);
    expect((await post({ to_team_id: B.teamId, give: ['ghost'], get: ['ghost2'], note: 'n' })).status).toBe(422);
    const long = await post({ to_team_id: B.teamId, give: ['a'.repeat(65)], get: ['b'], note: 'n' });
    expect(long.status).toBe(422);
    expect((await post({ to_team_id: 'nowhere', give: ['x'], get: ['y'], note: 'n' })).status).toBe(404);
  });

  it('a blocked pitch means no trade at all; a held pitch stays invisible but the offer stands', async () => {
    const pair = await tradablePair();
    const blocked = await authed(`/teams/${A.teamId}/trades`, A.apiKey, {
      method: 'POST',
      body: JSON.stringify({ to_team_id: B.teamId, give: [pair.give], get: [pair.get], note: 'this fucking trade' }),
    });
    expect(blocked.status).toBe(422);
    const count = await env.DB.prepare("SELECT COUNT(*) n FROM trades WHERE status = 'open' AND from_team_id = ?")
      .bind(A.teamId)
      .first<{ n: number }>();
    const openBefore = count!.n;

    // Player-adjacent insult → held: offer exists, pitch invisible on the thread.
    const heldRes = await authed(`/teams/${A.teamId}/trades`, A.apiKey, {
      method: 'POST',
      body: JSON.stringify({ to_team_id: B.teamId, give: [pair.give], get: [pair.get], note: 'Mudd is washed, take him' }),
    });
    expect(heldRes.status).toBe(201);
    const held = await heldRes.json<{ trade_id: string; note_held: boolean }>();
    expect(held.note_held).toBe(true);
    const thread = await app.request(`/trades/${held.trade_id}/messages`, {}, env);
    expect((await thread.json<{ messages: unknown[] }>()).messages).toHaveLength(0);
    const openAfter = await env.DB.prepare("SELECT COUNT(*) n FROM trades WHERE status = 'open' AND from_team_id = ?")
      .bind(A.teamId)
      .first<{ n: number }>();
    expect(openAfter!.n).toBe(openBefore + 1);
    // Withdraw to clean up the open-offer slot.
    expect((await authed(`/trades/${held.trade_id}/withdraw`, A.apiKey, { method: 'POST', body: '{}' })).status).toBe(200);
  });

  it('stale offers refuse: if a named player leaves the roster, accept 409s', async () => {
    await env.DB.prepare("DELETE FROM rate_counters WHERE scope = 'trade'").run(); // the 5/day cap is real; reset between tests
    const pair = await tradablePair();
    const res = await authed(`/teams/${A.teamId}/trades`, A.apiKey, {
      method: 'POST',
      body: JSON.stringify({ to_team_id: B.teamId, give: [pair.give], get: [pair.get], note: 'fair and square' }),
    });
    const { trade_id } = await res.json<{ trade_id: string }>();
    // A's player vanishes (simulating an FA drop / another trade).
    await env.DB.prepare('DELETE FROM rosters WHERE team_id = ? AND player_id = ?').bind(A.teamId, pair.give).run();
    const accept = await authed(`/trades/${trade_id}/accept`, B.apiKey, { method: 'POST', body: '{}' });
    expect(accept.status).toBe(409);
    expect((await accept.json<{ code: string }>()).code).toBe('TRADE_STALE');
    // Restore for later tests.
    await env.DB.prepare("INSERT OR IGNORE INTO rosters (team_id, player_id, acquired_via, acquired_at) VALUES (?, ?, 'draft', ?)")
      .bind(A.teamId, pair.give, new Date().toISOString())
      .run();
    await authed(`/trades/${trade_id}/withdraw`, A.apiKey, { method: 'POST', body: '{}' });
  });

  it('kickoff-locked players cannot move', async () => {
    await env.DB.prepare("DELETE FROM rate_counters WHERE scope = 'trade'").run();
    const pair = await tradablePair();
    // Put B's player in B's week-1 lineup, then pull the kickoff into the past.
    const slotFor = pair.position === 'RB' ? 'RB1' : pair.position === 'WR' ? 'WR1' : pair.position;
    await authed(`/teams/${B.teamId}/lineup`, B.apiKey, {
      method: 'PUT',
      body: JSON.stringify({ week: 1, slots: { [slotFor]: pair.get } }),
    }).then(async (r) => {
      if (r.status !== 200) {
        // slot key mismatch — write the lineup row directly; the lock query reads lineups.
        await env.DB.prepare(
          "INSERT OR REPLACE INTO lineups (team_id, week, slot, player_id, updated_at) VALUES (?, 1, 'QB', ?, ?)",
        ).bind(B.teamId, pair.get, new Date().toISOString()).run();
      }
    });
    const club = await env.DB.prepare('SELECT team FROM players WHERE id = ?').bind(pair.get).first<{ team: string }>();
    await env.DB.prepare('UPDATE games SET kickoff_at = ? WHERE season = 2026 AND week = 1 AND (home = ? OR away = ?)')
      .bind('2020-01-01T00:00:00.000Z', club!.team, club!.team)
      .run();

    const res = await authed(`/teams/${A.teamId}/trades`, A.apiKey, {
      method: 'POST',
      body: JSON.stringify({ to_team_id: B.teamId, give: [pair.give], get: [pair.get], note: 'pre-lock sniping attempt' }),
    });
    const { trade_id } = await res.json<{ trade_id: string }>();
    const accept = await authed(`/trades/${trade_id}/accept`, B.apiKey, { method: 'POST', body: '{}' });
    expect(accept.status).toBe(409);
    expect((await accept.json<{ code: string }>()).code).toBe('PLAYER_LOCKED');
    // Trade stays open (not consumed) after a lock refusal.
    const row = await env.DB.prepare('SELECT status FROM trades WHERE id = ?').bind(trade_id).first<{ status: string }>();
    expect(row!.status).toBe('open');
  });
});
