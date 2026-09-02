// §3.5 extended (owner ruling 2026-09-01): unanswered owner advice past the
// 30-minute grace window blocks roster-changing writes — free-agent moves and
// trade accept/counter — not only lineup changes. Proposals, rejections, and
// banter stay open; /pulse advertises the blast radius.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { sweepDraft } from '../src/routes/draft';
import { authed, fillLeague, futureKickoffOffset, seedWire, type TestAgent } from './helpers';

type Member = TestAgent & { teamId: string };
let leagueId = '';
let members: Member[] = [];
let adviceSeq = 0;

async function leaveAgedAdvice(m: Member): Promise<string> {
  const owner = (await env.DB.prepare('SELECT owner_id FROM agents WHERE id = ?').bind(m.agentId).first<{ owner_id: string }>())!;
  const id = `gate-adv-${++adviceSeq}`;
  await env.DB.prepare(
    "INSERT INTO advice (id, team_id, owner_id, body, agent_response_msg_id, created_at) VALUES (?, ?, ?, 'bench the veteran', NULL, ?)",
  )
    .bind(id, m.teamId, owner.owner_id, new Date(Date.now() - 31 * 60_000).toISOString())
    .run();
  return id;
}
async function respond(m: Member, adviceId: string) {
  const res = await authed(`/advice/${adviceId}/respond`, m.apiKey, { method: 'POST', body: JSON.stringify({ body: 'No. The lineup stays mine.', stance: 'decline' }) });
  expect(res.status).toBe(201);
}

beforeAll(async () => {
  await seedWire({ games: true, season: 2026, kickoffOffsetMs: futureKickoffOffset() });
  const league = await fillLeague('Gate');
  leagueId = league.leagueId;
  members = league.members;
  while ((await sweepDraft(env.DB, leagueId, Date.now() + 1000 * 3600_000)) > 0) { /* draft */ }
  (env as { TRADES_OPEN_AT?: string }).TRADES_OPEN_AT = '2020-01-01T00:00:00Z';
});

describe('advice gate on roster-changing writes', () => {
  it('a free-agent move is refused until the advice is answered in public', async () => {
    const me = members[0]!;
    const adviceId = await leaveAgedAdvice(me);
    const drop = (await env.DB.prepare('SELECT player_id FROM rosters WHERE team_id = ? LIMIT 1').bind(me.teamId).first<{ player_id: string }>())!;
    const add = (await (await app.request(`/leagues/${leagueId}/available?limit=1`, {}, env)).json<{ players: { player_id: string }[] }>()).players[0]!;
    const blocked = await authed(`/teams/${me.teamId}/moves`, me.apiKey, { method: 'POST', body: JSON.stringify({ add: add.player_id, drop: drop.player_id }) });
    expect(blocked.status).toBe(409);
    const body = await blocked.json<{ code: string; pending_advice_ids: string[] }>();
    expect(body.code).toBe('ADVICE_PENDING');
    expect(body.pending_advice_ids).toContain(adviceId);
    // /pulse names the blast radius.
    const pulse = await (await authed('/pulse', me.apiKey)).json<{ actions: { type: string; blocks?: string[] }[] }>();
    expect(pulse.actions[0]!.type).toBe('advice_pending');
    expect(pulse.actions[0]!.blocks).toEqual(expect.arrayContaining(['lineup', 'moves', 'trade_accept']));
    await respond(me, adviceId);
    const ok = await authed(`/teams/${me.teamId}/moves`, me.apiKey, { method: 'POST', body: JSON.stringify({ add: add.player_id, drop: drop.player_id }) });
    expect(ok.status).toBe(201);
  });

  it('trade accept and counter are gated for the receiving team; proposing and rejecting are not', async () => {
    const A = members[1]!;
    const B = members[2]!;
    const pair = (await env.DB.prepare(
      `SELECT ra.player_id AS give, rb.player_id AS get FROM rosters ra JOIN players pa ON pa.id = ra.player_id
       JOIN rosters rb JOIN players pb ON pb.id = rb.player_id
       WHERE ra.team_id = ? AND rb.team_id = ? AND pa.position = pb.position LIMIT 1`,
    ).bind(A.teamId, B.teamId).first<{ give: string; get: string }>())!;
    // A has pending advice but may still PROPOSE (no roster changes yet).
    const adviceA = await leaveAgedAdvice(A);
    const offer = await authed(`/teams/${A.teamId}/trades`, A.apiKey, {
      method: 'POST',
      body: JSON.stringify({ to_team_id: B.teamId, give: [pair.give], get: [pair.get], note: 'Same position, straight swap.' }),
    });
    expect(offer.status).toBe(201);
    const { trade_id } = await offer.json<{ trade_id: string }>();
    // B has pending advice: accept and counter are refused, reject is allowed.
    const adviceB = await leaveAgedAdvice(B);
    const accept = await authed(`/trades/${trade_id}/accept`, B.apiKey, { method: 'POST', body: JSON.stringify({ note: 'Deal.' }) });
    expect(accept.status).toBe(409);
    expect((await accept.json<{ code: string }>()).code).toBe('ADVICE_PENDING');
    const counter = await authed(`/trades/${trade_id}/counter`, B.apiKey, {
      method: 'POST',
      body: JSON.stringify({ give: [pair.get], get: [pair.give], note: 'Flip it.' }),
    });
    expect(counter.status).toBe(409);
    await respond(B, adviceB);
    const accepted = await authed(`/trades/${trade_id}/accept`, B.apiKey, { method: 'POST', body: JSON.stringify({ note: 'Deal.' }) });
    expect(accepted.status).toBe(200);
    await respond(A, adviceA);
  });
});
