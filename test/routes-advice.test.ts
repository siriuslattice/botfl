import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { resetPlayerNameCache } from '../src/moderation/moderate';
import { sweepDraft } from '../src/routes/draft';
import { authed, fillLeague, futureKickoffOffset, seedWire, type TestAgent } from './helpers';

type Member = TestAgent & { teamId: string };
let leagueId = '';
let members: Member[] = [];
let ownerCookie = ''; // session for members[0]'s owner
let m0: Member;

async function leaveAdvice(teamId: string, cookie: string, body: string) {
  return app.request(
    `/teams/${teamId}/advice`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `dl_owner=${cookie}` },
      body: JSON.stringify({ body }),
    },
    env,
  );
}

async function validLineup(teamId: string): Promise<Record<string, string | null>> {
  const rows = await env.DB.prepare(
    'SELECT r.player_id AS id, p.position AS pos FROM rosters r JOIN players p ON p.id = r.player_id WHERE r.team_id = ?',
  ).bind(teamId).all<{ id: string; pos: string }>();
  const by = (p: string) => rows.results.filter((r) => r.pos === p).map((r) => r.id);
  const [rb, wr] = [by('RB'), by('WR')];
  return {
    QB: by('QB')[0] ?? null, RB1: rb[0] ?? null, RB2: rb[1] ?? null,
    WR1: wr[0] ?? null, WR2: wr[1] ?? null, TE: by('TE')[0] ?? null,
    FLEX: [...rb.slice(2), ...wr.slice(2), ...by('TE').slice(1)][0] ?? null,
  };
}

beforeAll(async () => {
  await seedWire({ games: true, season: 2026, kickoffOffsetMs: futureKickoffOffset() });
  resetPlayerNameCache();
  const league = await fillLeague('Advised');
  leagueId = league.leagueId;
  members = league.members;
  m0 = members[0]!;
  while ((await sweepDraft(env.DB, leagueId, Date.now() + 1000 * 3600_000)) > 0) { /* draft */ }
  // ownerCookie is established by the claim test below (tests in this file run in order).
});

describe('owner claim', () => {
  it('claim is enumeration-safe and dev-exposes the link', async () => {
    const res = await app.request(
      '/claim',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '10.78.1.1' },
        body: JSON.stringify({ email: 'nobody@example.com' }),
      },
      env,
    );
    const body = await res.json<{ ok: boolean; dev_magic_link?: string }>();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.dev_magic_link).toBeUndefined(); // unknown email → no link even in dev
  });

  it('claim link works once, sets a session, marks the owner verified', async () => {
    const email = await env.DB.prepare(
      'SELECT o.email FROM owners o JOIN agents a ON a.owner_id = o.id WHERE a.id = ?',
    ).bind(m0.agentId).first<{ email: string }>();
    const res = await app.request(
      '/claim',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '10.78.2.1' },
        body: JSON.stringify({ email: email!.email }),
      },
      env,
    );
    const { dev_magic_link } = await res.json<{ dev_magic_link?: string }>();
    expect(dev_magic_link).toBeTruthy();

    const path = new URL(dev_magic_link!).pathname;
    const page = await app.request(path, {}, env);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(m0.name);
    const cookie = page.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    ownerCookie = cookie.match(/dl_owner=([^;]+)/)![1]!;

    // second use → gone
    expect((await app.request(path, {}, env)).status).toBe(410);

    const verified = await env.DB.prepare('SELECT verified FROM owners WHERE email = ?')
      .bind(email!.email).first<{ verified: number }>();
    expect(verified?.verified).toBe(1);

    const claimedEvents = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE type = 'owner_claimed'",
    ).first<{ n: number }>();
    expect(claimedEvents!.n).toBeGreaterThanOrEqual(1);
  });
});

describe('advice channel', () => {
  it('owner leaves advice; agent lineup is gated until a public response', async () => {
    const post = await leaveAdvice(m0.teamId, ownerCookie, 'Bench the FLEX. Trust me, I watch film.');
    expect(post.status).toBe(201);
    const { advice_id } = await post.json<{ advice_id: string }>();

    // Backdate past the grace window so the gate engages.
    await env.DB.prepare('UPDATE advice SET created_at = ? WHERE id = ?')
      .bind(new Date(Date.now() - 31 * 60_000).toISOString(), advice_id).run();

    const gated = await authed(`/teams/${m0.teamId}/lineup`, m0.apiKey, {
      method: 'PUT',
      body: JSON.stringify({ week: 1, slots: await validLineup(m0.teamId) }),
    });
    expect(gated.status).toBe(409);
    const gatedBody = await gated.json<{ code: string; pending_advice_ids: string[] }>();
    expect(gatedBody.code).toBe('ADVICE_PENDING');
    expect(gatedBody.pending_advice_ids).toContain(advice_id);

    // Respond (a refusal, naturally) → gate lifts.
    const respond = await authed(`/advice/${advice_id}/respond`, m0.apiKey, {
      method: 'POST',
      body: JSON.stringify({ body: 'Respectfully: no. The film says otherwise and so do the numbers.', stance: 'decline' }),
    });
    expect(respond.status).toBe(201);
    expect((await respond.json<{ stance: string }>()).stance).toBe('decline');

    const after = await authed(`/teams/${m0.teamId}/lineup`, m0.apiKey, {
      method: 'PUT',
      body: JSON.stringify({ week: 1, slots: await validLineup(m0.teamId) }),
    });
    expect(after.status).toBe(200);

    // Thread is public with the response attached.
    const thread = await app.request(`/teams/${m0.teamId}/advice`, {}, env);
    const { advice } = await thread.json<{ advice: { id: string; response: string | null }[] }>();
    expect(advice.find((a) => a.id === advice_id)?.response).toContain('Respectfully');

    // Double-respond replays idempotently.
    const again = await authed(`/advice/${advice_id}/respond`, m0.apiKey, {
      method: 'POST', body: JSON.stringify({ body: 'again?' }),
    });
    expect((await again.json<{ already_responded: boolean }>()).already_responded).toBe(true);
  });

  it('fresh advice within the grace window does not block lineups', async () => {
    const post = await leaveAdvice(m0.teamId, ownerCookie, 'One more thought: start everyone good.');
    expect(post.status).toBe(201);
    const res = await authed(`/teams/${m0.teamId}/lineup`, m0.apiKey, {
      method: 'PUT',
      body: JSON.stringify({ week: 1, slots: await validLineup(m0.teamId) }),
    });
    expect(res.status).toBe(200);
  });

  it('advice caps at 3/day and requires the right owner', async () => {
    let last = 0;
    for (let i = 0; i < 3; i++) {
      last = (await leaveAdvice(m0.teamId, ownerCookie, `extra advice ${i}`)).status;
    }
    expect(last).toBe(429); // 2 earlier + these → cap

    const otherTeam = members[1]!.teamId;
    const wrongOwner = await leaveAdvice(otherTeam, ownerCookie, 'not my team');
    expect(wrongOwner.status).toBe(403);

    const noSession = await app.request(`/teams/${m0.teamId}/advice`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'hi' }),
    }, env);
    expect(noSession.status).toBe(401);
  });

  it('player-insult advice is refused delivery; agent asks reach the thread', async () => {
    const owner2cookie = await (async () => {
      const email = await env.DB.prepare(
        'SELECT o.email FROM owners o JOIN agents a ON a.owner_id = o.id WHERE a.id = ?',
      ).bind(members[2]!.agentId).first<{ email: string }>();
      const res = await app.request('/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '10.78.3.1' },
        body: JSON.stringify({ email: email!.email }),
      }, env);
      const { dev_magic_link } = await res.json<{ dev_magic_link?: string }>();
      const page = await app.request(new URL(dev_magic_link!).pathname, {}, env);
      return (page.headers.get('set-cookie') ?? '').match(/dl_owner=([^;]+)/)![1]!;
    })();

    const insult = await leaveAdvice(members[2]!.teamId, owner2cookie, 'Mudd is trash, drop him');
    expect(insult.status).toBe(422);
    expect((await insult.json<{ code: string }>()).code).toBe('ADVICE_HELD');

    const ask = await authed(`/teams/${members[2]!.teamId}/ask`, members[2]!.apiKey, {
      method: 'POST',
      body: JSON.stringify({ body: 'Owner: Pickens or the rookie at FLEX this week? Deciding at the deadline either way.' }),
    });
    expect(ask.status).toBe(201);
    const thread = await app.request(`/teams/${members[2]!.teamId}/advice`, {}, env);
    const { agent_notes } = await thread.json<{ agent_notes: { body: string }[] }>();
    expect(agent_notes.some((n) => n.body.includes('Pickens or the rookie'))).toBe(true);

    const wrongAgent = await authed(`/teams/${members[2]!.teamId}/ask`, members[3]!.apiKey, {
      method: 'POST', body: JSON.stringify({ body: 'hello from a stranger' }),
    });
    expect(wrongAgent.status).toBe(403);
  });
});
