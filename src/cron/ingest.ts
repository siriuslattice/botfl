// Wire ingest cron (SPEC §3.6): pull community sources → upsert Wire tables.
// Baseline cadence via Cron Triggers; every run is idempotent upserts. Stats
// are attempted for the earliest unsettled week so settlement can follow in
// the same tick the data lands.

import { getWireIngest } from '../sport';
import type { IngestResult } from '../sport/adapter';

export async function runIngest(db: D1Database, season: number): Promise<IngestResult[]> {
  const ingest = getWireIngest('nfl');
  const results: IngestResult[] = [];
  results.push(await ingest.syncPlayers(db, season));
  results.push(await ingest.syncSchedule(db, season));
  results.push(await ingest.syncInjuries(db, season));

  const due = await db
    .prepare(
      `SELECT MIN(m.week) AS week FROM matchups m
       JOIN leagues l ON l.id = m.league_id
       WHERE l.status = 'active' AND l.season = ? AND m.settled_at IS NULL`,
    )
    .bind(season)
    .first<{ week: number | null }>();
  if (due?.week) {
    results.push(await ingest.syncWeekStats(db, season, due.week));
  }

  await db
    .prepare('INSERT INTO events (league_id, type, payload_json, created_at) VALUES (NULL, ?, ?, ?)')
    .bind('wire_synced', JSON.stringify({ season, results }), new Date().toISOString())
    .run();
  await raiseWireAlarms(db, season, results);
  return results;
}

/**
 * Fast lane (SPEC §3.6 tiered cadence), riding the 10-min trigger:
 *  - top of every hour: injuries baseline (the fast-moving source);
 *  - inside a pre-lock window: injuries + due-week stats every tick, so late
 *    inactives land inside every agent's 15-min cycle before kickoff locks.
 * Players/schedule stay on the 6h full sync — they change slowly and their
 * CSVs are the heavy ones.
 */
export async function runFastIngest(
  db: D1Database,
  season: number,
  scheduledTimeMs: number,
): Promise<IngestResult[] | null> {
  const ingest = getWireIngest('nfl');
  const inWindow = await ingest.inPreLockWindow(db, season, scheduledTimeMs);
  const hourly = new Date(scheduledTimeMs).getUTCMinutes() === 0;
  if (!inWindow && !hourly) return null;

  const results: IngestResult[] = [];
  results.push(await ingest.syncInjuries(db, season));
  if (inWindow) {
    const due = await db
      .prepare(
        `SELECT MIN(m.week) AS week FROM matchups m JOIN leagues l ON l.id = m.league_id
         WHERE l.status = 'active' AND l.season = ? AND m.settled_at IS NULL`,
      )
      .bind(season)
      .first<{ week: number | null }>();
    if (due?.week) results.push(await ingest.syncWeekStats(db, season, due.week));
  }
  await raiseWireAlarms(db, season, results);
  return results;
}

/**
 * The Wire fails SILENTLY by design (an unpublished source is "not yet", not
 * an error) — which also hides a renamed source file forever. Alarm when
 * "not yet" stops being plausible; at most one alarm per source per day.
 *  - injuries absent while a kickoff is inside 72h;
 *  - stats absent while some week's games all ended >24h ago (settlement is
 *    data-driven, so absent stats = no Tuesday settlement and no recap).
 */
async function raiseWireAlarms(db: D1Database, season: number, results: IngestResult[]): Promise<void> {
  const now = Date.now();
  const alarms: { source: string; detail: string }[] = [];

  const injuries = results.find((r) => r.source === 'injuries');
  if (injuries?.skipped) {
    const soon = await db
      .prepare('SELECT 1 AS x FROM games WHERE season = ? AND kickoff_at > ? AND kickoff_at <= ? LIMIT 1')
      .bind(season, new Date(now).toISOString(), new Date(now + 72 * 3600_000).toISOString())
      .first();
    if (soon) alarms.push({ source: 'injuries', detail: injuries.skipped });
  }

  const stats = results.find((r) => r.source === 'stats');
  if (stats?.skipped || stats?.rows === 0) {
    const overdue = await db
      .prepare(
        `SELECT m.week FROM matchups m JOIN leagues l ON l.id = m.league_id
         WHERE l.status = 'active' AND l.season = ? AND m.settled_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM games g WHERE g.season = l.season AND g.week = m.week AND g.kickoff_at > ?)
         LIMIT 1`,
      )
      .bind(season, new Date(now - 24 * 3600_000).toISOString())
      .first<{ week: number }>();
    if (overdue) alarms.push({ source: 'stats', detail: `week ${overdue.week} unsettled, stats still absent` });
  }

  for (const alarm of alarms) {
    const recent = await db
      .prepare(
        `SELECT 1 AS x FROM events WHERE type = 'wire_alarm' AND created_at > ?
           AND payload_json LIKE '%"source":"' || ? || '"%' LIMIT 1`,
      )
      .bind(new Date(now - 24 * 3600_000).toISOString(), alarm.source)
      .first();
    if (recent) continue;
    console.error(`WIRE ALARM: ${alarm.source} — ${alarm.detail}`);
    await db
      .prepare('INSERT INTO events (league_id, type, payload_json, created_at) VALUES (NULL, ?, ?, ?)')
      .bind('wire_alarm', JSON.stringify({ season, ...alarm }), new Date(now).toISOString())
      .run();
  }
}
