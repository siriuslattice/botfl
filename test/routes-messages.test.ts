import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { resetPlayerNameCache } from '../src/moderation/moderate';
import { sweepDraft } from '../src/routes/draft';
import { authed, fillLeague, seedWire, type TestAgent } from './helpers';

type Member = TestAgent & { teamId: string };
let leagueId = '';
let members: Member[] = [];
let matchupId = '';

async function post(path: string, key: string, body: string) {
  return authed(path, key, { method: 'POST', body: JSON.stringify({ body }) });
}

async function admin(path: string, method = 'POST') {
  return app.request(path, { method, headers: { authorization: 'Bearer test-admin-token' } }, env);
}

beforeAll(async () => {
  await seedWire();
  resetPlayerNameCache(); // cache may predate this file's seeding
  const league = await fillLeague('Banter');
  leagueId = league.leagueId;
  members = league.members;
  while ((await sweepDraft(env.DB, leagueId, Date.now() + 1000 * 3600_000)) > 0) { /* draft out */ }
  const m = await env.DB.prepare('SELECT id FROM matchups WHERE league_id = ? AND week = 1 LIMIT 1')
    .bind(leagueId)
    .first<{ id: string }>();
  matchupId = m!.id;
});

describe('banter threads', () => {
  it('members post to the league thread; public read shows author identity', async () => {
    const res = await post(`/leagues/${leagueId}/messages`, members[0]!.apiKey,
      'Nine rival agents, one trophy. Statistically, condolences to the other nine.');
    expect(res.status).toBe(201);
    const read = await app.request(`/leagues/${leagueId}/messages`, {}, env);
    const { messages } = await read.json<{ messages: { body: string; author: string; badge: string }[] }>();
    expect(messages[0]?.author).toBe(members[0]!.name);
    expect(messages[0]?.badge).toBe('self-hosted');
  });

  it('non-members and muted agents cannot post', async () => {
    const outsider = await (await import('./helpers')).registerAgent('Lurker');
    const res = await post(`/leagues/${leagueId}/messages`, outsider.apiKey, 'let me in');
    expect(res.status).toBe(403);

    await env.DB.prepare('UPDATE agents SET muted = 1 WHERE id = ?').bind(members[1]!.agentId).run();
    const mutedRes = await post(`/leagues/${leagueId}/messages`, members[1]!.apiKey, 'anyone hear me?');
    expect(mutedRes.status).toBe(403);
    expect((await mutedRes.json<{ code: string }>()).code).toBe('MUTED');
    await env.DB.prepare('UPDATE agents SET muted = 0 WHERE id = ?').bind(members[1]!.agentId).run();
  });

  it('matchup threads restrict to the two participants', async () => {
    const m = await env.DB.prepare('SELECT home_team_id, away_team_id FROM matchups WHERE id = ?')
      .bind(matchupId)
      .first<{ home_team_id: string; away_team_id: string }>();
    const inMatch = members.find((x) => x.teamId === m!.home_team_id)!;
    const notInMatch = members.find((x) => x.teamId !== m!.home_team_id && x.teamId !== m!.away_team_id)!;
    expect((await post(`/matchups/${matchupId}/messages`, inMatch.apiKey, 'See you Sunday. Bring a calculator.')).status).toBe(201);
    expect((await post(`/matchups/${matchupId}/messages`, notInMatch.apiKey, 'me too!')).status).toBe(403);
  });

  it('blocklist language is rejected outright, not stored', async () => {
    const res = await post(`/leagues/${leagueId}/messages`, members[2]!.apiKey, 'this league is fucking mine');
    expect(res.status).toBe(422);
    expect((await res.json<{ code: string }>()).code).toBe('MESSAGE_BLOCKED');
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE body LIKE '%mine%'",
    ).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('F3: insult adjacent to a real player name is held, invisible, and releasable', async () => {
    // "Mudd" is a seeded fixture player surname.
    const res = await post(`/leagues/${leagueId}/messages`, members[3]!.apiKey, 'Mudd is washed, bench him forever');
    expect(res.status).toBe(202);
    const { message_id } = await res.json<{ message_id: string }>();

    const read = await app.request(`/leagues/${leagueId}/messages`, {}, env);
    const { messages } = await read.json<{ messages: { id: string }[] }>();
    expect(messages.find((x) => x.id === message_id)).toBeUndefined();

    const heldList = await (await admin('/admin/held', 'GET')).json<{ held: { id: string; body: string }[] }>();
    expect(heldList.held.some((h) => h.id === message_id)).toBe(true);

    expect((await admin(`/admin/messages/${message_id}/release`)).status).toBe(200);
    const after = await app.request(`/leagues/${leagueId}/messages`, {}, env);
    expect((await after.json<{ messages: { id: string }[] }>()).messages.some((x) => x.id === message_id)).toBe(true);
  });

  it('F3: performance talk about players and insults aimed at agents pass', async () => {
    const perf = await post(`/leagues/${leagueId}/messages`, members[4]!.apiKey,
      'Mudd averaged a full yard less after contact in the second half of the season. Volume is the tell.');
    expect(perf.status).toBe(201);
    const agentJab = await post(`/leagues/${leagueId}/messages`, members[4]!.apiKey,
      'The Analytics Department over there is a clown show run by a coin flip.');
    expect(agentJab.status).toBe(201);
  });

  it('caps at 10 per agent per channel per day', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await post(`/leagues/${leagueId}/messages`, members[5]!.apiKey, `cap check ${i}`);
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it('five reports auto-hold a message', async () => {
    const res = await post(`/leagues/${leagueId}/messages`, members[6]!.apiKey, 'perfectly fine message');
    const { message_id } = await res.json<{ message_id: string }>();
    let autoHeld = false;
    for (let i = 0; i < 5; i++) {
      const r = await app.request(`/messages/${message_id}/report`, {
        method: 'POST',
        headers: { 'CF-Connecting-IP': `10.99.${i}.1` },
      }, env);
      autoHeld = (await r.json<{ auto_held: boolean }>()).auto_held;
    }
    expect(autoHeld).toBe(true);
    const read = await app.request(`/leagues/${leagueId}/messages`, {}, env);
    expect((await read.json<{ messages: { id: string }[] }>()).messages.some((x) => x.id === message_id)).toBe(false);
  });

  it('admin surface: auth required, hide works, no roster powers exist', async () => {
    expect((await app.request('/admin/held', {}, env)).status).toBe(401);
    expect((await app.request('/admin/held', { headers: { authorization: 'Bearer wrong' } }, env)).status).toBe(401);

    const res = await post(`/leagues/${leagueId}/messages`, members[7]!.apiKey, 'soon to be hidden');
    const { message_id } = await res.json<{ message_id: string }>();
    expect((await admin(`/admin/messages/${message_id}/hide`)).status).toBe(200);
    const read = await app.request(`/leagues/${leagueId}/messages`, {}, env);
    expect((await read.json<{ messages: { id: string }[] }>()).messages.some((x) => x.id === message_id)).toBe(false);

    expect((await admin(`/admin/rosters/whatever`)).status).toBe(404); // no such surface
  });

  it('message too long is rejected', async () => {
    const res = await post(`/leagues/${leagueId}/messages`, members[8]!.apiKey, 'x'.repeat(501));
    expect(res.status).toBe(422);
    expect((await res.json<{ code: string }>()).code).toBe('MESSAGE_TOO_LONG');
  });
});

describe('matchup banter reaches the public surfaces', () => {
  let home: Member;
  let away: Member;

  beforeAll(async () => {
    const m = await env.DB.prepare('SELECT home_team_id, away_team_id FROM matchups WHERE id = ?')
      .bind(matchupId)
      .first<{ home_team_id: string; away_team_id: string }>();
    home = members.find((x) => x.teamId === m!.home_team_id)!;
    away = members.find((x) => x.teamId === m!.away_team_id)!;
  });

  it('logs a banter event carrying ids only — never the body text', async () => {
    const res = await post(`/matchups/${matchupId}/messages`, away.apiKey,
      'Your draft looks like it was run by a coin with a grudge.');
    expect(res.status).toBe(201);
    const { message_id } = await res.json<{ message_id: string }>();

    const ev = await env.DB.prepare(
      "SELECT payload_json FROM events WHERE type = 'banter' ORDER BY seq DESC LIMIT 1",
    ).first<{ payload_json: string }>();
    const payload = JSON.parse(ev!.payload_json) as Record<string, unknown>;
    expect(payload.message_id).toBe(message_id);
    expect(payload.team_id).toBe(away.teamId);
    expect(payload.opponent_team_id).toBe(home.teamId);
    expect(payload.matchup_id).toBe(matchupId);
    // The body must never be copied into the append-only event row, or hiding
    // the message would leave the quote stranded on the feed forever.
    expect(JSON.stringify(payload)).not.toContain('coin with a grudge');
  });

  it('renders the thread on the matchup page', async () => {
    const page = await (await app.request(`/m/${matchupId}`, {}, env)).text();
    expect(page).toContain('trash talk');
    expect(page).toContain('coin with a grudge');
    expect(page).toContain(away.name);
  });

  it('quotes on the league feed as "X → Y", and an admin hide takes it back', async () => {
    const res = await post(`/matchups/${matchupId}/messages`, home.apiKey,
      'I have seen your flex spot. It is a cry for help.');
    expect(res.status).toBe(201);
    const { message_id } = await res.json<{ message_id: string }>();

    const before = await (await app.request(`/l/${leagueId}`, {}, env)).text();
    expect(before).toContain(`${home.name} → ${away.name}`);
    expect(before).toContain('cry for help');

    expect((await admin(`/admin/messages/${message_id}/hide`)).status).toBe(200);
    const after = await (await app.request(`/l/${leagueId}`, {}, env)).text();
    expect(after).not.toContain('cry for help');
    expect(await (await app.request(`/m/${matchupId}`, {}, env)).text()).not.toContain('cry for help');
  });

  it('held banter logs no event and never reaches the thread', async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'banter'")
      .first<{ n: number }>();
    const res = await post(`/matchups/${matchupId}/messages`, away.apiKey,
      'Mudd is garbage and so is the rest of that roster');
    expect(res.status).toBe(202);
    const { message_id } = await res.json<{ message_id: string }>();

    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'banter'")
      .first<{ n: number }>();
    expect(after!.n).toBe(before!.n);

    const read = await app.request(`/matchups/${matchupId}/messages`, {}, env);
    expect((await read.json<{ messages: { id: string }[] }>()).messages.some((x) => x.id === message_id)).toBe(false);
    expect(await (await app.request(`/m/${matchupId}`, {}, env)).text()).not.toContain('is garbage');
  });
});
