import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { csvHeader, csvLines, parseCsvLine } from '../src/sport/nfl/csv';
import { inPreLockWindow, syncInjuries, syncPlayers, syncSchedule, syncTrades, syncWeekStats, mapStatRow } from '../src/sport/nfl/ingest';
import { easternOffsetHours, easternToUtcIso } from '../src/sport/nfl/time';

describe('csv parser', () => {
  it('handles quoted commas, escaped quotes, CRLF', () => {
    expect(parseCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
    expect(parseCsvLine('a,"say ""hi""",c')).toEqual(['a', 'say "hi"', 'c']);
    expect(parseCsvLine('a,,c')).toEqual(['a', '', 'c']);
    expect(csvLines('h1,h2\r\nv1,v2\r\n')).toEqual(['h1,h2', 'v1,v2']);
    const t = csvHeader('x,y,z');
    expect(t.col('y')).toBe(1);
    expect(() => t.col('nope')).toThrow(/column missing/);
  });
});

describe('eastern time conversion', () => {
  it('converts EDT and EST correctly', () => {
    // September: EDT (-4). 20:20 ET on Sep 10 = 00:20 UTC Sep 11.
    expect(easternToUtcIso('2026-09-10', '20:20')).toBe('2026-09-11T00:20:00.000Z');
    // December: EST (-5).
    expect(easternToUtcIso('2026-12-13', '13:00')).toBe('2026-12-13T18:00:00.000Z');
  });

  it('handles the DST end boundary (first Sunday of November 2026 = Nov 1)', () => {
    expect(easternOffsetHours(2026, 10, 1, 1)).toBe(-4); // 01:00 still EDT
    expect(easternOffsetHours(2026, 10, 1, 13)).toBe(-5); // afternoon EST
    expect(easternOffsetHours(2026, 2, 8, 1)).toBe(-5); // before 2nd Sunday March 02:00
    expect(easternOffsetHours(2026, 2, 8, 3)).toBe(-4); // after spring-forward
  });
});

const ROSTER_CSV = [
  'season,team,position,status,full_name,gsis_id,week,game_type',
  '2026,PIT,QB,ACT,Aaron Testman,00-0000001,1,REG',
  '2026,PIT,QB,ACT,Aaron Testman,00-0000001,2,REG', // later snapshot wins
  '2026,DAL,RB,RES,Runner Reserve,00-0000002,1,REG',
  '2026,SF,K,ACT,Kicker Kutman,00-0000003,1,REG', // non-fantasy position filtered
  '2026,GB,WR,ACT,"Wide, Receiver",00-0000004,1,REG', // quoted comma in name
].join('\n');

const GAMES_CSV = [
  'game_id,season,game_type,week,gameday,weekday,gametime,away_team,away_score,home_team,home_score,away_coach,home_coach,referee',
  '2026_01_NE_SEA,2026,REG,1,2026-09-09,Wednesday,20:20,NE,,SEA,,Hank Grumble,Sal Whistler,Ref Flagsworth',
  '2026_20_XX_YY,2026,POST,20,2027-01-20,Saturday,13:00,XX,,YY,,Post Coach,Other Coach,Playoff Ref', // playoffs excluded
  '2025_01_AA_BB,2025,REG,1,2025-09-04,Thursday,20:20,AA,,BB,,Old Coach,Older Coach,Past Ref', // other season excluded
].join('\n');

const INJURIES_CSV = [
  'season,season_type,game_type,team,week,gsis_id,position,full_name,first_name,last_name,report_primary_injury,report_secondary_injury,report_status,practice_primary_injury,practice_secondary_injury,practice_status',
  '2026,REG,REG,PIT,1,00-0000001,QB,Aaron Testman,Aaron,Testman,Knee,,Questionable,Knee,,Limited',
  '2026,REG,REG,PIT,2,00-0000001,QB,Aaron Testman,Aaron,Testman,Knee,,Out,Knee,,Did Not Participate', // later week wins
  '2026,REG,REG,GB,1,00-0000004,WR,Wide Receiver,Wide,Receiver,,,,Rest,,Did Not Participate', // practice-only
].join('\n');

const STATS_HEADER =
  'player_id,player_name,player_display_name,position,position_group,headshot_url,season,week,season_type,game_id,team,opponent_team,passing_yards,passing_tds,passing_interceptions,sack_fumbles_lost,rushing_yards,rushing_tds,rushing_fumbles_lost,rushing_2pt_conversions,receptions,receiving_yards,receiving_tds,receiving_fumbles_lost,receiving_2pt_conversions,passing_2pt_conversions';
const STATS_CSV = [
  STATS_HEADER,
  '00-0000001,A.Testman,Aaron Testman,QB,QB,url,2026,1,REG,g1,PIT,BAL,312,2,1,1,12,0,0,0,0,0,0,0,0,1',
  '00-0000004,W.Receiver,Wide Receiver,WR,WR,url,2026,1,REG,g2,GB,CHI,0,0,0,0,0,0,0,0,7,101,1,0,0,0',
  '00-0000001,A.Testman,Aaron Testman,QB,QB,url,2026,2,REG,g3,PIT,CLE,250,1,0,0,5,0,0,0,0,0,0,0,0,0', // other week
  '00-0000003,K.Kutman,Kicker Kutman,K,K,url,2026,1,REG,g2,SF,LA,0,0,0,0,0,0,0,0,0,0,0,0,0,0', // non-fantasy
].join('\n');

function stubFetch(body: string | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      body === null ? new Response('not found', { status: 404 }) : new Response(body, { status: 200 }),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('nflverse ingest', () => {
  it('syncPlayers keeps latest snapshot, filters positions, handles quoted names', async () => {
    stubFetch(ROSTER_CSV);
    const res = await syncPlayers(env.DB, 2026);
    expect(res).toMatchObject({ source: 'players', rows: 3 });
    const rows = await env.DB.prepare("SELECT id, name, position, team, status FROM players WHERE id LIKE 'nfl:00-%' ORDER BY id").all();
    expect(rows.results).toEqual([
      { id: 'nfl:00-0000001', name: 'Aaron Testman', position: 'QB', team: 'PIT', status: 'active' },
      { id: 'nfl:00-0000002', name: 'Runner Reserve', position: 'RB', team: 'DAL', status: 'res' },
      { id: 'nfl:00-0000004', name: 'Wide, Receiver', position: 'WR', team: 'GB', status: 'active' },
    ]);
  });

  it('syncPlayers accepts the season roster file without a week column (nflverse format since 2026-09-03)', async () => {
    // One row per player, no snapshots: the first (only) row wins, statuses map as before.
    // Distinct ids AND names: the transactions test diffs the shared roster, and syncTrades links by unique name.
    const SEASON_ROSTER_CSV = [
      'season,team,position,depth_chart_position,jersey_number,status,full_name,first_name,last_name,gsis_id',
      '2026,PIT,QB,QB,8,ACT,Season Snapshot,Season,Snapshot,00-0000101',
      '2026,DAL,RB,RB,21,CUT,Cut Candidate,Cut,Candidate,00-0000102',
      '2026,GB,WR,WR,17,ACT,"Comma, Name",Comma,Name,00-0000104',
      '2026,SF,OL,OL,70,ACT,Big Blocker,Big,Blocker,00-0000109', // non-fantasy position filtered
    ].join('\n');
    stubFetch(SEASON_ROSTER_CSV);
    const res = await syncPlayers(env.DB, 2026);
    expect(res).toMatchObject({ source: 'players', rows: 3 });
    expect(res.error).toBeUndefined();
    const rows = await env.DB.prepare("SELECT id, team, status FROM players WHERE id LIKE 'nfl:00-00001%' ORDER BY id").all();
    expect(rows.results).toEqual([
      { id: 'nfl:00-0000101', team: 'PIT', status: 'active' },
      { id: 'nfl:00-0000102', team: 'DAL', status: 'cut' },
      { id: 'nfl:00-0000104', team: 'GB', status: 'active' },
    ]);
  });

  it('syncSchedule takes only the season REG games with UTC kickoffs', async () => {
    stubFetch(GAMES_CSV);
    const res = await syncSchedule(env.DB, 2026);
    expect(res.rows).toBe(1); // rows counts games; protected names ride along separately
    const row = await env.DB.prepare("SELECT week, kickoff_at, home, away FROM games WHERE id = 'nfl:2026_01_NE_SEA'").first();
    expect(row).toEqual({ week: 1, kickoff_at: '2026-09-10T00:20:00.000Z', home: 'SEA', away: 'NE' });
  });

  it('syncSchedule records coaches and officials as protected names (F3), season rows only', async () => {
    stubFetch(GAMES_CSV);
    await syncSchedule(env.DB, 2026);
    const names = await env.DB.prepare('SELECT name, role FROM protected_names ORDER BY name').all();
    expect(names.results).toEqual([
      { name: 'Hank Grumble', role: 'coach' },
      { name: 'Ref Flagsworth', role: 'referee' },
      { name: 'Sal Whistler', role: 'coach' },
    ]);
    // A header without the columns degrades to games-only, never throws.
    stubFetch(GAMES_CSV.split('\n').map((l) => l.split(',').slice(0, 11).join(',')).join('\n'));
    const res = await syncSchedule(env.DB, 2026);
    expect(res.rows).toBe(1);
  });

  it('inPreLockWindow: 2h pre-kickoff window is data-driven; Sunday 07:00-10:00 PT block holds', async () => {
    stubFetch(GAMES_CSV);
    await syncSchedule(env.DB, 2026); // kickoff 2026-09-10T00:20Z
    const at = (iso: string) => inPreLockWindow(env.DB, 2026, Date.parse(iso));
    expect(await at('2026-09-09T23:00:00Z')).toBe(true); // 80 min before kickoff
    expect(await at('2026-09-09T20:00:00Z')).toBe(false); // 4h20 before — baseline only
    expect(await at('2026-09-10T00:30:00Z')).toBe(false); // already kicked off
    // Sunday 2026-09-13 (PDT, UTC-7): 07:00-10:00 PT = 14:00-17:00 UTC.
    expect(await at('2026-09-13T14:30:00Z')).toBe(true);
    expect(await at('2026-09-13T13:30:00Z')).toBe(false); // 06:30 PT
    expect(await at('2026-09-13T17:30:00Z')).toBe(false); // 10:30 PT, no game near
  });

  it('syncInjuries keeps each latest week and falls back to practice status', async () => {
    stubFetch(INJURIES_CSV);
    const res = await syncInjuries(env.DB, 2026);
    expect(res.rows).toBe(2);
    const qb = await env.DB.prepare("SELECT status, note FROM injuries WHERE player_id = 'nfl:00-0000001'").first();
    expect(qb).toEqual({ status: 'Out', note: 'Knee' });
    const wr = await env.DB.prepare("SELECT status FROM injuries WHERE player_id = 'nfl:00-0000004'").first();
    expect(wr).toEqual({ status: 'Did Not Participate' });
  });

  it('syncWeekStats maps + filters requested weeks; 404 season reports skipped', async () => {
    stubFetch(STATS_CSV);
    const res = await syncWeekStats(env.DB, 2026, [1]);
    expect(res.rows).toBe(2);
    const qb = await env.DB.prepare(
      "SELECT stat_json FROM stats_weekly WHERE player_id = 'nfl:00-0000001' AND season = 2026 AND week = 1",
    ).first<{ stat_json: string }>();
    expect(JSON.parse(qb!.stat_json)).toEqual({
      passing_yards: 312, passing_tds: 2, interceptions: 1, rushing_yards: 12,
      fumbles_lost: 1, two_point_conversions: 1,
    });

    stubFetch(null);
    const skipped = await syncWeekStats(env.DB, 2026, [1]);
    expect(skipped.skipped).toContain('not published');

    // An empty week set never fetches at all.
    expect((await syncWeekStats(env.DB, 2026, [])).rows).toBe(0);
  });

  it('roster diffs between syncs land as transactions (team + status changes)', async () => {
    stubFetch(ROSTER_CSV);
    await syncPlayers(env.DB, 2026); // baseline
    const moved = ROSTER_CSV
      .replace('2026,PIT,QB,ACT,Aaron Testman,00-0000001,2,REG', '2026,BAL,QB,ACT,Aaron Testman,00-0000001,2,REG')
      .replace('2026,DAL,RB,RES,Runner Reserve,00-0000002,1,REG', '2026,DAL,RB,ACT,Runner Reserve,00-0000002,1,REG');
    stubFetch(moved);
    await syncPlayers(env.DB, 2026);
    const rows = await env.DB.prepare(
      "SELECT type, player_id, detail FROM transactions WHERE type IN ('team_change','status_change') ORDER BY type",
    ).all<{ type: string; player_id: string; detail: string }>();
    expect(rows.results).toEqual([
      { type: 'status_change', player_id: 'nfl:00-0000002', detail: 'Runner Reserve: res → active' },
      { type: 'team_change', player_id: 'nfl:00-0000001', detail: 'Aaron Testman: PIT → BAL' },
    ]);
    // Same day, same diff → deterministic id makes the re-sync a no-op.
    await syncPlayers(env.DB, 2026);
    const again = await env.DB.prepare(
      "SELECT COUNT(*) n FROM transactions WHERE type IN ('team_change','status_change')",
    ).first<{ n: number }>();
    expect(again!.n).toBe(2);
  });

  it('syncTrades ingests player legs, links by unique name, skips pick legs', async () => {
    const TRADES_CSV = [
      'trade_id,season,trade_date,gave,received,pick_season,pick_round,pick_number,conditional,pfr_id,pfr_name',
      '900,2026,2026-03-01,PIT,BAL,,,,,TestAa01,Aaron Testman',
      '900,2026,2026-03-01,BAL,PIT,2026,3,,0,"",""', // pick leg — skipped
      '901,2026,2026-04-01,SF,SEA,,,,,NobodX01,Total Stranger', // no roster match → player_id null
      '800,2025,2025-06-01,AA,BB,,,,,OldGuy01,Old Guy', // other season — skipped
    ].join('\n');
    stubFetch(TRADES_CSV);
    const res = await syncTrades(env.DB, 2026);
    expect(res.rows).toBe(2);
    const rows = await env.DB.prepare(
      "SELECT player_id, detail FROM transactions WHERE type = 'trade' ORDER BY occurred_at",
    ).all<{ player_id: string | null; detail: string }>();
    expect(rows.results).toEqual([
      { player_id: 'nfl:00-0000001', detail: 'Aaron Testman: traded PIT → BAL' },
      { player_id: null, detail: 'Total Stranger: traded SF → SEA' },
    ]);
    stubFetch(null);
    expect((await syncTrades(env.DB, 2026)).skipped).toContain('missing');
  });

  it('mapStatRow sums fumble/2pt variants and renames interceptions', () => {
    const t = csvHeader(STATS_HEADER);
    const row = parseCsvLine(STATS_CSV.split('\n')[2]!);
    expect(mapStatRow(t, row)).toEqual({ receptions: 7, receiving_yards: 101, receiving_tds: 1 });
  });
});
