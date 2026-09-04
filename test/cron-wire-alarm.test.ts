import { env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runFastIngest, runIngest } from '../src/cron/ingest';
import { seedWire } from './helpers';

// Kickoffs ~24h out: inside the 72h injuries-alarm horizon, outside the 2h
// pre-lock window.
beforeAll(async () => {
  await seedWire({ games: true, season: 2026, kickoffOffsetMs: Date.now() + 86400_000 - Date.UTC(2025, 8, 4) });
});

function stub404() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
}
afterEach(() => vi.unstubAllGlobals());

async function alarms(): Promise<{ payload_json: string }[]> {
  const rows = await env.DB.prepare("SELECT payload_json FROM events WHERE type = 'wire_alarm'").all<{ payload_json: string }>();
  return rows.results;
}

describe('wire alarms', () => {
  it('injuries absent inside 72h of kickoff raises one alarm, deduped for a day', async () => {
    stub404();
    await runIngest(env.DB, 2026);
    const first = await alarms();
    expect(first).toHaveLength(1);
    expect(first[0]!.payload_json).toContain('"source":"injuries"');

    await runIngest(env.DB, 2026); // same condition minutes later → no second row
    expect(await alarms()).toHaveLength(1);
  });

  it('a source whose file changed shape is reported, alarmed, and does not stop the run', async () => {
    // rosters/ with a renamed key column (the 2026-09-03 failure shape); everything else 404.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/rosters/')
          ? new Response('season,team,position,status,full_name,player_key\n2026,PIT,QB,ACT,A,1', { status: 200 })
          : new Response('nope', { status: 404 }),
      ),
    );
    const results = await runIngest(env.DB, 2026);
    const players = results.find((r) => r.source === 'players');
    expect(players).toMatchObject({ rows: 0 });
    expect(players?.error).toMatch(/column missing: gsis_id/);
    // the sources behind it still ran, and the run recorded itself
    expect(results.map((r) => r.source)).toEqual(['players', 'schedule', 'injuries', 'transactions']);
    const synced = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'wire_synced'").first<{ n: number }>();
    expect(synced!.n).toBeGreaterThan(0);
    const alarm = (await alarms()).filter((a) => a.payload_json.includes('"source":"players"'));
    expect(alarm).toHaveLength(1);
    expect(alarm[0]!.payload_json).toContain('column missing');
    // once a day, like every other wire alarm
    await runIngest(env.DB, 2026);
    expect((await alarms()).filter((a) => a.payload_json.includes('"source":"players"'))).toHaveLength(1);
  });

  it('fast lane: off-hour tick outside a window does nothing; top of hour syncs injuries', async () => {
    stub404();
    const offHour = Date.parse('2026-09-01T12:20:00Z'); // minute 20, no games near
    expect(await runFastIngest(env.DB, 2026, offHour)).toBeNull();
    const topOfHour = Date.parse('2026-09-01T12:00:00Z');
    const results = await runFastIngest(env.DB, 2026, topOfHour);
    expect(results?.map((r) => r.source)).toEqual(['injuries']);
  });

  it('fast lane: inside the 2h pre-kickoff window every tick syncs', async () => {
    stub404();
    const kickoff = await env.DB.prepare(
      "SELECT kickoff_at FROM games WHERE season = 2026 ORDER BY kickoff_at ASC LIMIT 1",
    ).first<{ kickoff_at: string }>();
    const inWindow = Date.parse(kickoff!.kickoff_at) - 30 * 60_000; // 30 min before, any minute value
    const results = await runFastIngest(env.DB, 2026, inWindow);
    expect(results).not.toBeNull();
    expect(results!.some((r) => r.source === 'injuries')).toBe(true);
  });
});
