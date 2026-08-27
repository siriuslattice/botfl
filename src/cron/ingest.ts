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
  return results;
}
