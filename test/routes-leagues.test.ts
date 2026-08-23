import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { resolveLeagueStatus } from '../src/routes/leagues';

let ipCounter = 0;

async function makeAgent(name: string): Promise<string> {
  const res = await app.request(
    '/register',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': `10.10.${++ipCounter}.1` },
      body: JSON.stringify({ name, model: 'test-model', owner_email: `${ipCounter}@example.com` }),
    },
    env,
  );
  const body = await res.json<{ api_key: string }>();
  return body.api_key;
}

async function join(key: string) {
  return app.request(
    '/leagues/join',
    { method: 'POST', headers: { authorization: `Bearer ${key}` } },
    env,
  );
}

describe('matchmaking join', () => {
  it('creates a forming league, fills it with 10, opens the draft, and spills to a new league', async () => {
    const keys: string[] = [];
    for (let i = 1; i <= 11; i++) keys.push(await makeAgent(`Join Agent ${i}`));

    const first = await join(keys[0]!);
    expect(first.status).toBe(201);
    const firstBody = await first.json<Record<string, unknown>>();
    expect(firstBody.teams_count).toBe(1);
    const leagueId = String(firstBody.league_id);

    for (let i = 1; i < 9; i++) {
      const res = await join(keys[i]!);
      expect((await res.json<Record<string, unknown>>()).league_id).toBe(leagueId);
    }

    const tenth = await join(keys[9]!);
    const tenthBody = await tenth.json<Record<string, unknown>>();
    expect(tenthBody.league_id).toBe(leagueId);
    expect(tenthBody.teams_count).toBe(10);
    expect(String(tenthBody.hint)).toContain('full');

    // DRAFT_OPEN_DELAY_SEC=0 in tests → league is drafting once observed.
    const read = await app.request(`/leagues/${leagueId}`, {}, env);
    const league = await read.json<{ status: string; teams: { slot: number; badge: string }[] }>();
    expect(league.status).toBe('drafting');
    expect(league.teams).toHaveLength(10);
    expect(league.teams.map((t) => t.slot).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(league.teams.every((t) => t.badge === 'self-hosted')).toBe(true);

    // 11th agent lands in a fresh league.
    const eleventh = await join(keys[10]!);
    expect((await eleventh.json<Record<string, unknown>>()).league_id).not.toBe(leagueId);
  });

  it('rejoin is naturally idempotent', async () => {
    const key = await makeAgent('Rejoin Agent');
    const first = await join(key);
    const firstBody = await first.json<Record<string, unknown>>();
    const second = await join(key);
    expect(second.status).toBe(200);
    const secondBody = await second.json<Record<string, unknown>>();
    expect(secondBody.already_member).toBe(true);
    expect(secondBody.team_id).toBe(firstBody.team_id);
  });

  it('requires auth', async () => {
    const res = await app.request('/leagues/join', { method: 'POST' }, env);
    expect(res.status).toBe(401);
  });

  it('unknown league reads 404 as JSON', async () => {
    const res = await app.request('/leagues/nope', {}, env);
    expect(res.status).toBe(404);
    expect((await res.json<Record<string, string>>()).code).toBe('LEAGUE_NOT_FOUND');
  });

  it('matchups endpoint is empty pre-draft', async () => {
    const key = await makeAgent('Matchup Reader');
    const body = await (await join(key)).json<{ league_id: string }>();
    const res = await app.request(`/leagues/${body.league_id}/matchups`, {}, env);
    expect(await res.json()).toEqual({ matchups: [] });
  });
});

describe('resolveLeagueStatus (delayed-open path)', () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  const past = new Date(Date.now() - 1000).toISOString();

  it('full league before draft_opens_at stays forming', () => {
    expect(resolveLeagueStatus('forming', 10, future, Date.now())).toBe('forming');
  });
  it('full league past draft_opens_at is drafting', () => {
    expect(resolveLeagueStatus('forming', 10, past, Date.now())).toBe('drafting');
  });
  it('short league never drafts; later states pass through', () => {
    expect(resolveLeagueStatus('forming', 9, past, Date.now())).toBe('forming');
    expect(resolveLeagueStatus('active', 10, past, Date.now())).toBe('active');
  });
});
