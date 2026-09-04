// Wire ingest cron (SPEC §3.6): pull community sources → upsert Wire tables.
// Baseline cadence via Cron Triggers; every run is idempotent upserts. Stats
// are attempted for every distinct unsettled week (bounded) so settlement can
// follow in the same tick the data lands — and one wedged league can't starve
// the others' stats.

import { getWireIngest } from '../sport';
import type { IngestResult } from '../sport/adapter';

/**
 * One source, isolated. A throw here used to abort the whole run before the
 * `wire_synced` event or any alarm was written — nflverse dropped the `week`
 * column from rosters/ on 2026-09-03 and the wire went dark for a day with
 * nothing on the site or in the events table saying so. Now the failure is a
 * result row (`error`), it alarms like any other wire fault, and the sources
 * behind it still sync.
 */
async function guarded(source: string, run: () => Promise<IngestResult>): Promise<IngestResult> {
  try {
    return await run();
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`ingest ${source} failed: ${error}`);
    return { source, rows: 0, error };
  }
}

export async function runIngest(db: D1Database, season: number, env?: Env): Promise<IngestResult[]> {
  const ingest = getWireIngest('nfl');
  const results: IngestResult[] = [];
  results.push(await guarded('players', () => ingest.syncPlayers(db, season)));
  results.push(await guarded('schedule', () => ingest.syncSchedule(db, season)));
  results.push(await guarded('injuries', () => ingest.syncInjuries(db, season)));
  results.push(await guarded('transactions', () => ingest.syncTrades(db, season)));

  const due = await unsettledWeeks(db, season);
  if (due.length > 0) {
    results.push(await guarded('stats', () => ingest.syncWeekStats(db, season, due)));
  }

  await sweepReplayCache(db);

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
  results.push(await guarded('injuries', () => ingest.syncInjuries(db, season)));
  if (inWindow) {
    const due = await unsettledWeeks(db, season);
    if (due.length > 0) results.push(await guarded('stats', () => ingest.syncWeekStats(db, season, due)));
  }
  await raiseWireAlarms(db, season, results);
  return results;
}

/**
 * Replay-cache hygiene, riding the 6h sync: idempotency rows only matter over
 * a cron's retry horizon, and /register's stored body carries a one-time
 * api_key — 48h is the bounded at-rest exposure recorded in DRIFT 2026-08-30.
 * Stale rate windows (metric day-buckets included) go with them.
 */
export async function sweepReplayCache(db: D1Database): Promise<void> {
  await db
    .prepare('DELETE FROM idempotency_keys WHERE created_at < ?')
    .bind(new Date(Date.now() - 48 * 3600_000).toISOString())
    .run();
  await db
    .prepare('DELETE FROM rate_counters WHERE window_start < ?')
    .bind(Math.floor(Date.now() / 1000) - 8 * 86400)
    .run();
}

/**
 * The distinct unsettled weeks across active leagues (ascending, bounded) —
 * the stats the wire still owes someone. A MIN-only query let one wedged
 * league pin the sync to its week forever and starve every other league.
 */
export async function unsettledWeeks(db: D1Database, season: number, limit = 3): Promise<number[]> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT m.week AS week FROM matchups m JOIN leagues l ON l.id = m.league_id
       WHERE l.status = 'active' AND l.season = ? AND m.settled_at IS NULL
       ORDER BY m.week ASC LIMIT ?`,
    )
    .bind(season, limit)
    .all<{ week: number }>();
  return rows.results.map((r) => r.week);
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

  // A source that threw is never "not yet" — it is a fault, alarmed on sight.
  for (const r of results) if (r.error) alarms.push({ source: r.source, detail: r.error });

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

/**
 * Fleet watchdog. The house fleet and hosted agents run inside this Worker on
 * the `4-54/10` trigger; if that path stops (a bad deploy, a missing secret,
 * HOSTED_RUNNER=0 left behind) the site decays QUIETLY — lineups stop, banter
 * goes stale, advice goes unanswered — and nothing on the site says so. Two
 * signals: the tick cursor (max hosted_last_run_at) older than `staleMinutes`,
 * or no agent activity events for `quietHours` while leagues are live (a tick
 * that runs but fails every cycle). Alarms at most once a day; emails the
 * operator when OPERATOR_EMAIL is set. Rides the 10-min fast lane.
 */
export async function checkRunnerHeartbeat(db: D1Database, env: Env, quietHours = 6, staleMinutes = 60): Promise<boolean> {
  const now = Date.now();
  const fleet = await db
    .prepare("SELECT COUNT(*) AS n, MAX(hosted_last_run_at) AS at FROM agents WHERE tier = 'hosted'")
    .first<{ n: number; at: string | null }>();
  const tickMs = fleet?.at ? Date.parse(fleet.at) : 0;
  const tickStale = (fleet?.n ?? 0) > 0 && tickMs < now - staleMinutes * 60_000;

  const active = await db
    .prepare("SELECT 1 AS x FROM leagues WHERE status IN ('drafting', 'active') LIMIT 1")
    .first();
  const last = active
    ? await db
        .prepare(
          `SELECT MAX(e.created_at) AS at FROM events e
           WHERE e.type IN ('lineup_submitted', 'banter', 'draft_pick', 'fa_move', 'advice_answered')`,
        )
        .first<{ at: string | null }>()
    : null;
  const lastMs = last?.at ? Date.parse(last.at) : 0;
  const activityStale = !!active && lastMs < now - quietHours * 3600_000;
  if (!tickStale && !activityStale) return false;

  const recent = await db
    .prepare("SELECT 1 AS x FROM events WHERE type = 'runner_stale' AND created_at > ? LIMIT 1")
    .bind(new Date(now - 24 * 3600_000).toISOString())
    .first();
  if (recent) return false;

  const ago = (ms: number) => (ms === 0 ? 'ever' : `${Math.floor((now - ms) / 60_000)}m`);
  const detail = tickStale
    ? `the in-Worker agent runner has not ticked in ${ago(tickMs)} (trigger 4-54/10 * * * *)`
    : `no agent activity in ${ago(lastMs)} while leagues are live (ticks run, cycles fail?)`;
  console.error(`RUNNER ALARM: ${detail}`);
  await db
    .prepare('INSERT INTO events (league_id, type, payload_json, created_at) VALUES (NULL, ?, ?, ?)')
    .bind('runner_stale', JSON.stringify({ last_tick: fleet?.at ?? null, last_activity: last?.at ?? null, detail }), new Date(now).toISOString())
    .run();
  if (env.OPERATOR_EMAIL) {
    const { sendEmail } = await import('../email');
    await sendEmail(env, {
      to: env.OPERATOR_EMAIL,
      subject: 'Deep League: the agent fleet has gone quiet',
      text:
        `${detail}.\n\n` +
        'Check Workers Logs for the botfl Worker (observability is on), confirm HOSTED_RUNNER is not "0" ' +
        'and HOSTED_AGENT_KEY_SECRET / OPENROUTER_ORG_KEY are set (npx wrangler secret list), then watch ' +
        'the next tick with `npx wrangler tail`. Runbook: docs/RUNBOOK-hosted.md.',
    });
  }
  return true;
}
