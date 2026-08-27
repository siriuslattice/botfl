import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { seedWire } from './helpers';

async function get(path: string, headers: Record<string, string> = {}) {
  return app.request(path, { headers }, env);
}

beforeAll(async () => {
  await seedWire({ games: true });
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT OR IGNORE INTO stats_weekly (player_id, season, week, stat_json, updated_at) VALUES (?, 2025, 1, ?, ?)',
  )
    .bind('nfl:p001', JSON.stringify({ passing_yards: 300, passing_tds: 2, interceptions: 1 }), now)
    .run();
  await env.DB.prepare(
    'INSERT OR IGNORE INTO injuries (player_id, status, note, updated_at) VALUES (?, ?, ?, ?)',
  )
    .bind('nfl:p002', 'Questionable', 'Hamstring', now)
    .run();
});

describe('/wire endpoints', () => {
  it('players: filters, caps, and search', async () => {
    const all = await get('/wire/players');
    const body = await all.json<{ data: { position: string }[]; meta: { count: number; attribution: string } }>();
    expect(body.meta.count).toBe(100); // default limit
    expect(body.meta.attribution).toContain('nflverse');

    const qbs = await get('/wire/players?position=QB&limit=200');
    const qbBody = await qbs.json<{ data: { position: string }[] }>();
    expect(qbBody.data.length).toBe(26);
    expect(qbBody.data.every((p) => p.position === 'QB')).toBe(true);

    expect((await get('/wire/players?position=K')).status).toBe(422);
    const search = await get('/wire/players?q=Mudd');
    expect((await search.json<{ data: unknown[] }>()).data.length).toBeGreaterThanOrEqual(1);
  });

  it('players: since filter and ETag 304 round-trip', async () => {
    const first = await get('/wire/players');
    const tag = first.headers.get('etag')!;
    expect(tag).toMatch(/^W\//);
    expect((await get('/wire/players', { 'if-none-match': tag })).status).toBe(304);

    const future = new Date(Date.now() + 3600_000).toISOString();
    const since = await get(`/wire/players?since=${encodeURIComponent(future)}`);
    expect((await since.json<{ data: unknown[] }>()).data).toEqual([]);
    expect((await get('/wire/players?since=notadate')).status).toBe(422);
  });

  it('schedule: season weeks with kickoffs', async () => {
    const res = await get('/wire/schedule?season=2025&week=1');
    const body = await res.json<{ data: { week: number; kickoff_at: string }[]; meta: { season: number } }>();
    expect(body.meta.season).toBe(2025);
    expect(body.data.length).toBe(16);
    expect(body.data.every((g) => g.week === 1)).toBe(true);
  });

  it('stats: joined names and computed half-ppr points', async () => {
    const res = await get('/wire/stats/1?season=2025');
    const body = await res.json<{ data: { player_id: string; points: number; name: string }[]; meta: { scoring: string } }>();
    expect(body.meta.scoring).toBe('half-ppr');
    const row = body.data.find((d) => d.player_id === 'nfl:p001')!;
    expect(row.points).toBe(18);
    expect(row.name).toBeTruthy();
    expect((await get('/wire/stats/99')).status).toBe(422);
  });

  it('injuries carry player context; transactions and news are empty-but-shaped', async () => {
    const inj = await get('/wire/injuries');
    const injBody = await inj.json<{ data: { player_id: string; status: string; name: string }[] }>();
    expect(injBody.data.find((i) => i.player_id === 'nfl:p002')?.status).toBe('Questionable');

    expect((await (await get('/wire/transactions')).json<{ data: unknown[] }>()).data).toEqual([]);
    expect((await (await get('/wire/news')).json<{ data: unknown[] }>()).data).toEqual([]);
  });
});
