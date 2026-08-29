import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { sweepDraft } from '../src/routes/draft';
import { executeSwap } from '../src/routes/roster';
import { authed, fillLeague, futureKickoffOffset, registerAgent, seedWire, type TestAgent } from './helpers';

type Member = TestAgent & { teamId: string };
let leagueId = '';
let members: Member[] = [];

async function rosterIds(teamId: string): Promise<string[]> {
  const rows = await env.DB.prepare('SELECT player_id FROM rosters WHERE team_id = ?')
    .bind(teamId)
    .all<{ player_id: string }>();
  return rows.results.map((r) => r.player_id);
}

async function available(position?: string): Promise<{ player_id: string; position: string }[]> {
  const q = position ? `?position=${position}` : '';
  const res = await app.request(`/leagues/${leagueId}/available${q}`, {}, env);
  const body = await res.json<{ players: { player_id: string; position: string }[] }>();
  return body.players;
}

async function move(teamId: string, key: string, add: string, drop: string, idem?: string) {
  return authed(`/teams/${teamId}/moves`, key, {
    method: 'POST',
    headers: idem ? { 'idempotency-key': idem } : {},
    body: JSON.stringify({ add, drop }),
  });
}

beforeAll(async () => {
  await seedWire({ games: true, season: 2026, kickoffOffsetMs: futureKickoffOffset() });
  const league = await fillLeague('FreeAgent');
  leagueId = league.leagueId;
  members = league.members;
  while ((await sweepDraft(env.DB, leagueId, Date.now() + 1000 * 3600_000)) > 0) { /* draft */ }
});

describe('availability', () => {
  it('lists only unrostered board players, position-filterable', async () => {
    const all = await available();
    expect(all.length).toBeGreaterThan(0);
    const rostered = new Set(await rosterIds(members[0]!.teamId));
    expect(all.some((p) => rostered.has(p.player_id))).toBe(false);
    const rbs = await available('RB');
    expect(rbs.length).toBeGreaterThan(0);
    expect(rbs.every((p) => p.position === 'RB')).toBe(true);
  });

  it('rejects junk positions and unknown leagues', async () => {
    const bad = await app.request(`/leagues/${leagueId}/available?position=KICKER`, {}, env);
    expect(bad.status).toBe(422);
    const ghost = await app.request('/leagues/ghost/available', {}, env);
    expect(ghost.status).toBe(404);
  });
});

describe('free agency moves', () => {
  it('swaps one-for-one, clears unsettled lineups, logs the event', async () => {
    const m0 = members[0]!;
    const before = await rosterIds(m0.teamId);
    expect(before.length).toBe(12);
    // Park the future drop in the week-1 lineup so the clearing path is real.
    const rows = await env.DB.prepare(
      'SELECT r.player_id AS id, p.position FROM rosters r JOIN players p ON p.id = r.player_id WHERE r.team_id = ?',
    ).bind(m0.teamId).all<{ id: string; position: string }>();
    const dropRb = rows.results.filter((r) => r.position === 'RB')[0]!.id;
    const put = await authed(`/teams/${m0.teamId}/lineup`, m0.apiKey, {
      method: 'PUT',
      body: JSON.stringify({ week: 1, slots: { RB1: dropRb } }),
    });
    expect(put.status).toBe(200);

    const add = (await available('RB'))[0]!;
    const res = await move(m0.teamId, m0.apiKey, add.player_id, dropRb);
    expect(res.status).toBe(201);
    const body = await res.json<{ added: { player_id: string }; dropped: { player_id: string } }>();
    expect(body.added.player_id).toBe(add.player_id);

    const after = await rosterIds(m0.teamId);
    expect(after.length).toBe(12);
    expect(after).toContain(add.player_id);
    expect(after).not.toContain(dropRb);

    const slot = await env.DB.prepare(
      "SELECT player_id FROM lineups WHERE team_id = ? AND week = 1 AND slot = 'RB1'",
    ).bind(m0.teamId).first<{ player_id: string | null }>();
    expect(slot?.player_id).toBeNull();

    const ev = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE type = 'fa_move' AND league_id = ?",
    ).bind(leagueId).first<{ n: number }>();
    expect(ev!.n).toBeGreaterThanOrEqual(1);
  });

  it('validates: self-swap, unknown player, not-on-roster, taken player', async () => {
    const m1 = members[1]!;
    const mine = (await rosterIds(m1.teamId))[0]!;
    const rival = (await rosterIds(members[2]!.teamId))[0]!;
    const free = (await available())[0]!.player_id;

    expect((await move(m1.teamId, m1.apiKey, mine, mine)).status).toBe(422);
    expect((await move(m1.teamId, m1.apiKey, 'nfl:ghost', mine)).status).toBe(422);
    expect((await move(m1.teamId, m1.apiKey, free, 'nfl:ghost')).status).toBe(422);
    const taken = await move(m1.teamId, m1.apiKey, rival, mine);
    expect(taken.status).toBe(409);
    expect((await taken.json<{ code: string }>()).code).toBe('PLAYER_TAKEN');
    // Validation failures consumed no budget: a legal move still passes.
    const ok = await move(m1.teamId, m1.apiKey, free, mine);
    expect(ok.status).toBe(201);
  });

  it('refuses dropping a kicked-off lineup player; bench drops stay legal', async () => {
    const m3 = members[3]!;
    const rows = await env.DB.prepare(
      'SELECT r.player_id AS id, p.position, p.team AS club FROM rosters r JOIN players p ON p.id = r.player_id WHERE r.team_id = ?',
    ).bind(m3.teamId).all<{ id: string; position: string; club: string }>();
    const rbs = rows.results.filter((r) => r.position === 'RB');
    const locked = rbs[0]!;
    const put = await authed(`/teams/${m3.teamId}/lineup`, m3.apiKey, {
      method: 'PUT',
      body: JSON.stringify({ week: 1, slots: { RB1: locked.id } }),
    });
    expect(put.status).toBe(200);
    // Rewind that club's week-1 game so the slot is kicked off.
    await env.DB.prepare(
      "UPDATE games SET kickoff_at = ? WHERE season = 2026 AND week = 1 AND (home = ? OR away = ?)",
    ).bind(new Date(Date.now() - 3600_000).toISOString(), locked.club, locked.club).run();

    const free = (await available('RB'))[0]!.player_id;
    const refused = await move(m3.teamId, m3.apiKey, free, locked.id);
    expect(refused.status).toBe(409);
    expect((await refused.json<{ code: string }>()).code).toBe('PLAYER_LOCKED');

    const benched = rows.results.find((r) => r.position === 'WR')!;
    const freeWr = (await available('WR'))[0]!.player_id;
    expect((await move(m3.teamId, m3.apiKey, freeWr, benched.id)).status).toBe(201);
  });

  it('caps at 2 moves/day and replays idempotently', async () => {
    const m4 = members[4]!;
    const mine = await rosterIds(m4.teamId);
    const free = await available();
    const first = await move(m4.teamId, m4.apiKey, free[0]!.player_id, mine[0]!, 'fa-idem-1');
    expect(first.status).toBe(201);
    const replay = await move(m4.teamId, m4.apiKey, free[0]!.player_id, mine[0]!, 'fa-idem-1');
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
    expect((await rosterIds(m4.teamId)).length).toBe(12); // replay executed nothing

    expect((await move(m4.teamId, m4.apiKey, free[1]!.player_id, mine[1]!)).status).toBe(201);
    const third = await move(m4.teamId, m4.apiKey, free[2]!.player_id, mine[2]!);
    expect(third.status).toBe(429);
    expect((await third.json<{ code: string }>()).code).toBe('FA_CAP');
  });

  it('race interleavings never change roster size (executeSwap compensations)', async () => {
    const m6 = members[6]!;
    const mine = await rosterIds(m6.teamId);
    const dropRow = { player_id: mine[0]!, acquired_via: 'draft', acquired_at: new Date().toISOString() };
    const size = async () => (await rosterIds(m6.teamId)).length;

    // Interleave A: the add got rostered elsewhere between validation and batch.
    // Our own delete DID run — the compensation must restore exactly our drop.
    const rivalPlayer = (await rosterIds(members[7]!.teamId))[0]!;
    const taken = await executeSwap(env.DB, {
      teamId: m6.teamId, leagueId, addId: rivalPlayer, dropRow, clearFromWeek: 1,
    });
    expect(taken).toBe('add_taken');
    expect(await size()).toBe(12);
    expect(await rosterIds(m6.teamId)).toContain(dropRow.player_id);

    // Interleave B: a concurrent duplicate already executed the same swap —
    // our delete hits nothing, and the compensation must undo our add
    // (restoring the other request's legitimate drop created a 13-man roster
    // in prod on 2026-08-28).
    const free = (await available())[0]!.player_id;
    const ghostDrop = { player_id: 'nfl:already-gone', acquired_via: 'draft', acquired_at: dropRow.acquired_at };
    const conflict = await executeSwap(env.DB, {
      teamId: m6.teamId, leagueId, addId: free, dropRow: ghostDrop, clearFromWeek: 1,
    });
    expect(conflict).toBe('drop_gone');
    expect(await size()).toBe(12);
    expect(await rosterIds(m6.teamId)).not.toContain(free);
  });

  it('guards auth, ownership, and league status', async () => {
    const m5 = members[5]!;
    const free = (await available())[0]!.player_id;
    const mine = (await rosterIds(m5.teamId))[0]!;
    const noAuth = await app.request(`/teams/${m5.teamId}/moves`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ add: free, drop: mine }),
    }, env);
    expect(noAuth.status).toBe(401);
    expect((await move(m5.teamId, members[6]!.apiKey, free, mine)).status).toBe(403);

    const stranger = await registerAgent('Forming');
    const join = await authed('/leagues/join', stranger.apiKey, { method: 'POST' });
    const { team_id } = await join.json<{ team_id: string }>();
    const forming = await move(team_id, stranger.apiKey, free, mine);
    expect(forming.status).toBe(409);
    expect((await forming.json<{ code: string }>()).code).toBe('LEAGUE_NOT_ACTIVE');
  });
});
