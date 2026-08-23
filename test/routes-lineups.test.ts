import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { sweepDraft } from '../src/routes/draft';
import { authed, fillLeague, futureKickoffOffset, registerAgent, seedWire, type TestAgent } from './helpers';

type Member = TestAgent & { teamId: string };
let leagueId = '';
let members: Member[] = [];
let season = 0;

async function rosterIdsByPos(teamId: string): Promise<Map<string, string[]>> {
  const rows = await env.DB.prepare(
    'SELECT r.player_id AS id, p.position AS pos FROM rosters r JOIN players p ON p.id = r.player_id WHERE r.team_id = ?',
  )
    .bind(teamId)
    .all<{ id: string; pos: string }>();
  const map = new Map<string, string[]>();
  for (const r of rows.results) {
    if (!map.has(r.pos)) map.set(r.pos, []);
    map.get(r.pos)!.push(r.id);
  }
  return map;
}

async function validLineupFor(teamId: string) {
  const byPos = await rosterIdsByPos(teamId);
  const rb = byPos.get('RB') ?? [];
  const wr = byPos.get('WR') ?? [];
  const flexPool = [...rb.slice(2), ...wr.slice(2), ...(byPos.get('TE') ?? []).slice(1)];
  return {
    QB: byPos.get('QB')?.[0] ?? null,
    RB1: rb[0] ?? null,
    RB2: rb[1] ?? null,
    WR1: wr[0] ?? null,
    WR2: wr[1] ?? null,
    TE: byPos.get('TE')?.[0] ?? null,
    FLEX: flexPool[0] ?? null,
  };
}

async function putLineup(member: Member, week: number, slots: Record<string, string | null>) {
  return authed(`/teams/${member.teamId}/lineup`, member.apiKey, {
    method: 'PUT',
    body: JSON.stringify({ week, slots }),
  });
}

beforeAll(async () => {
  await seedWire({ games: true, season: 2026, kickoffOffsetMs: futureKickoffOffset() });
  const league = await fillLeague('Lineup');
  leagueId = league.leagueId;
  members = league.members;
  const far = Date.now() + 1000 * 3600_000;
  while ((await sweepDraft(env.DB, leagueId, far)) > 0) { /* autocomplete draft */ }
  const row = await env.DB.prepare('SELECT season FROM leagues WHERE id = ?')
    .bind(leagueId)
    .first<{ season: number }>();
  season = row!.season;
});

describe('PUT /teams/:id/lineup', () => {
  it('accepts a valid full lineup, persists week-versioned, reads back publicly', async () => {
    const m = members[0]!;
    const slots = await validLineupFor(m.teamId);
    const res = await putLineup(m, 1, slots);
    expect(res.status).toBe(200);
    const body = await res.json<{ lineup: Record<string, string | null>; changed: string[] }>();
    expect(body.lineup).toEqual(slots);
    expect(body.changed.length).toBeGreaterThan(0);

    const read = await app.request(`/teams/${m.teamId}/lineup?week=1`, {}, env);
    expect((await read.json<{ lineup: Record<string, string | null> }>()).lineup).toEqual(slots);

    // Resubmitting identical payload: no changes, same state (naturally idempotent).
    const again = await putLineup(m, 1, slots);
    const againBody = await again.json<{ changed: string[]; hint: string }>();
    expect(againBody.changed).toEqual([]);
  });

  it('merges partial updates over the stored lineup', async () => {
    const m = members[1]!;
    const slots = await validLineupFor(m.teamId);
    await putLineup(m, 1, slots);
    const byPos = await rosterIdsByPos(m.teamId);
    const altFlex = [...(byPos.get('RB') ?? []).slice(2), ...(byPos.get('WR') ?? []).slice(2)]
      .find((id) => id !== slots.FLEX);
    if (!altFlex) throw new Error('no alternative flex on roster');
    const res = await putLineup(m, 1, { FLEX: altFlex });
    const body = await res.json<{ lineup: Record<string, string | null>; changed: string[] }>();
    expect(body.changed).toEqual(['FLEX']);
    expect(body.lineup).toEqual({ ...slots, FLEX: altFlex });
  });

  it('rejects invalid lineups atomically with per-slot errors', async () => {
    const m = members[2]!;
    const slots = await validLineupFor(m.teamId);
    const res = await putLineup(m, 1, { ...slots, FLEX: slots.QB }); // QB in FLEX + duplicate
    expect(res.status).toBe(422);
    const body = await res.json<{ code: string; errors: { code: string; slot: string }[] }>();
    expect(body.code).toBe('LINEUP_INVALID');
    const codes = body.errors.map((e) => e.code);
    expect(codes).toContain('INELIGIBLE_POSITION');
    expect(codes).toContain('DUPLICATE_PLAYER');
    // nothing persisted for this week
    const read = await app.request(`/teams/${m.teamId}/lineup?week=1`, {}, env);
    expect((await read.json<{ lineup: object }>()).lineup).toEqual({});
  });

  it('enforces per-player kickoff locks from the games table', async () => {
    const m = members[3]!;
    const slots = await validLineupFor(m.teamId);
    await putLineup(m, 2, slots);

    // Force the RB1 club's week-2 game into the past.
    const club = await env.DB.prepare('SELECT team FROM players WHERE id = ?')
      .bind(slots.RB1)
      .first<{ team: string }>();
    await env.DB.prepare(
      'UPDATE games SET kickoff_at = ? WHERE sport = ? AND season = ? AND week = 2 AND (home = ? OR away = ?)',
    )
      .bind(new Date(Date.now() - 3600_000).toISOString(), 'nfl', season, club!.team, club!.team)
      .run();

    const byPos = await rosterIdsByPos(m.teamId);
    const benchRb = (byPos.get('RB') ?? []).find((id) => id !== slots.RB1 && id !== slots.RB2 && id !== slots.FLEX);
    if (benchRb) {
      const res = await putLineup(m, 2, { RB1: benchRb });
      expect(res.status).toBe(422);
      const body = await res.json<{ errors: { code: string; slot: string }[] }>();
      expect(body.errors.some((e) => e.slot === 'RB1' && e.code === 'SLOT_LOCKED')).toBe(true);
    }

    // Unchanged resubmission of the same full lineup still passes.
    const same = await putLineup(m, 2, slots);
    expect(same.status).toBe(200);
  });

  it('guards auth, ownership, week range, and league status', async () => {
    const m = members[4]!;
    const other = members[5]!;
    const slots = await validLineupFor(m.teamId);

    expect((await app.request(`/teams/${m.teamId}/lineup`, { method: 'PUT' }, env)).status).toBe(401);
    const wrong = await putLineup({ ...m, apiKey: other.apiKey }, 1, slots);
    expect(wrong.status).toBe(403);
    expect((await putLineup(m, 99, slots)).status).toBe(422);
    expect((await app.request(`/teams/${m.teamId}/lineup?week=99`, {}, env)).status).toBe(422);

    const outsider = await registerAgent('Forming');
    const join = await authed('/leagues/join', outsider.apiKey, { method: 'POST' });
    const { team_id } = await join.json<{ team_id: string }>();
    const forming = await authed(`/teams/${team_id}/lineup`, outsider.apiKey, {
      method: 'PUT',
      body: JSON.stringify({ week: 1, slots: {} }),
    });
    expect(forming.status).toBe(409);
    expect((await forming.json<{ code: string }>()).code).toBe('LEAGUE_NOT_ACTIVE');
  });

  it('GET /teams/:id exposes the public team card', async () => {
    const m = members[6]!;
    const res = await app.request(`/teams/${m.teamId}`, {}, env);
    const body = await res.json<{ agent: { badge: string }; roster: { position: string }[] }>();
    expect(body.agent.badge).toBe('self-hosted');
    expect(body.roster).toHaveLength(12);
    expect((await app.request('/teams/ghost', {}, env)).status).toBe(404);
  });
});
