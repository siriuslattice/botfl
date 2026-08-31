// §7 metrics & instrumentation: one row per (UTC day, metric), snapshotted by
// the cron for the PREVIOUS day so every value is final when written. No
// third-party analytics (spec) — everything derives from our own tables plus
// two cheap counters bumped at the card routes. The Oct 6 kill-criteria
// evaluation (K1 registrations, K2 lineup rate, K3 share proxy) reads this.

export interface DayMetrics {
  day: string;
  metrics: Record<string, number>;
}

function utcDay(offsetDays: number, now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays));
  return d.toISOString().slice(0, 10);
}

/** Increment a daily counter (cards generated/fetched); no limit semantics. */
export async function bumpDailyCounter(db: D1Database, scope: string): Promise<void> {
  const windowStart = Math.floor(Date.now() / 1000 / 86_400) * 86_400;
  await db
    .prepare(
      `INSERT INTO rate_counters (scope, bucket, window_start, count) VALUES (?, 'day', ?, 1)
       ON CONFLICT (scope, bucket, window_start) DO UPDATE SET count = count + 1`,
    )
    .bind(scope, windowStart)
    .run();
}

async function counterFor(db: D1Database, scope: string, day: string): Promise<number> {
  const windowStart = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
  const row = await db
    .prepare("SELECT count FROM rate_counters WHERE scope = ? AND bucket = 'day' AND window_start = ?")
    .bind(scope, windowStart)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * Compute one day's metrics from source tables. Pure read; exported for the
 * admin page's "today so far" row and for tests.
 */
export async function computeDayMetrics(db: D1Database, day: string): Promise<DayMetrics> {
  const from = `${day}T00:00:00`;
  const to = `${day}T23:59:59.999`;
  const one = async (sql: string, ...binds: unknown[]): Promise<number> => {
    const row = await db.prepare(sql).bind(...binds).first<{ n: number }>();
    return row?.n ?? 0;
  };
  const metrics: Record<string, number> = {
    registrations_byo: await one(
      "SELECT COUNT(*) n FROM agents WHERE tier = 'byo' AND badge != 'commissioner' AND created_at BETWEEN ? AND ?", from, to),
    // K1 counts EXTERNALLY-owned agents only — house personas register through
    // the same public route, so without the is_house split the kill-criteria
    // evaluation would count our own fleet as traction.
    registrations_external: await one(
      `SELECT COUNT(*) n FROM agents WHERE is_house = 0 AND badge != 'commissioner'
       AND created_at BETWEEN ? AND ?`, from, to),
    external_agents_total: await one(
      "SELECT COUNT(*) n FROM agents WHERE is_house = 0 AND badge != 'commissioner'"),
    registrations_hosted: await one(
      "SELECT COUNT(*) n FROM agents WHERE tier = 'hosted' AND created_at BETWEEN ? AND ?", from, to),
    agents_active: await one(
      `SELECT COUNT(DISTINCT t.agent_id) n FROM events e JOIN teams t ON t.id = json_extract(e.payload_json, '$.team_id')
       WHERE e.created_at BETWEEN ? AND ?`, from, to),
    lineups_submitted: await one(
      "SELECT COUNT(*) n FROM events WHERE type = 'lineup_submitted' AND created_at BETWEEN ? AND ?", from, to),
    advice_left: await one("SELECT COUNT(*) n FROM advice WHERE created_at BETWEEN ? AND ?", from, to),
    advice_answered: await one(
      `SELECT COUNT(*) n FROM advice a JOIN messages m ON m.id = a.agent_response_msg_id
       WHERE m.created_at BETWEEN ? AND ?`, from, to),
    messages_posted: await one("SELECT COUNT(*) n FROM messages WHERE created_at BETWEEN ? AND ?", from, to),
    banter_posted: await one(
      "SELECT COUNT(*) n FROM messages WHERE channel_type = 'matchup' AND created_at BETWEEN ? AND ?", from, to),
    fa_moves: await one(
      "SELECT COUNT(*) n FROM events WHERE type = 'fa_move' AND created_at BETWEEN ? AND ?", from, to),
    owners_claimed: await one(
      "SELECT COUNT(*) n FROM events WHERE type = 'owner_claimed' AND created_at BETWEEN ? AND ?", from, to),
    cards_generated: await counterFor(db, 'metric:cards_generated', day),
    cards_fetched: await counterFor(db, 'metric:cards_fetched', day),
  };
  // K2 (≥50% of external agents submit a Week-3 lineup) is a RATE over a
  // league-week, not a daily count — daily event tallies can't answer it after
  // the fact. Snapshot it each day against every active league's current
  // unsettled week; the Oct 6 read is then a lookup, not an archaeology dig.
  const k2 = await externalLineupRate(db);
  metrics.external_with_lineup = k2.withLineup;
  metrics.external_in_active_leagues = k2.eligible;
  metrics.external_lineup_rate = k2.rate;
  return { day, metrics };
}

/**
 * Share of externally-owned agents in active leagues that have a lineup for
 * their league's current (earliest unsettled) week. Kill criterion K2.
 */
export async function externalLineupRate(
  db: D1Database,
): Promise<{ eligible: number; withLineup: number; rate: number }> {
  const row = await db
    .prepare(
      `WITH current_week AS (
         SELECT league_id, MIN(week) AS week FROM matchups WHERE settled_at IS NULL GROUP BY league_id
       ),
       eligible AS (
         SELECT t.id AS team_id, cw.week
         FROM teams t
         JOIN leagues l ON l.id = t.league_id AND l.status = 'active'
         JOIN agents a ON a.id = t.agent_id AND a.is_house = 0 AND a.badge != 'commissioner'
         JOIN current_week cw ON cw.league_id = t.league_id
       )
       SELECT COUNT(*) AS eligible,
              SUM(CASE WHEN EXISTS (
                SELECT 1 FROM lineups ln
                WHERE ln.team_id = e.team_id AND ln.week = e.week AND ln.player_id IS NOT NULL
              ) THEN 1 ELSE 0 END) AS with_lineup
       FROM eligible e`,
    )
    .first<{ eligible: number; with_lineup: number | null }>();
  const eligible = row?.eligible ?? 0;
  const withLineup = row?.with_lineup ?? 0;
  return {
    eligible,
    withLineup,
    rate: eligible === 0 ? 0 : Math.round((withLineup / eligible) * 1000) / 1000,
  };
}

/**
 * Snapshot YESTERDAY (UTC) into metrics_daily once. Idempotent: skips when the
 * day already has rows; INSERT OR IGNORE guards races between cron ticks.
 */
export async function snapshotDaily(db: D1Database, now = new Date()): Promise<string | null> {
  const day = utcDay(-1, now);
  const existing = await db
    .prepare('SELECT 1 AS x FROM metrics_daily WHERE day = ? LIMIT 1')
    .bind(day)
    .first();
  if (existing) return null;
  const { metrics } = await computeDayMetrics(db, day);
  const stmts = Object.entries(metrics).map(([metric, value]) =>
    db
      .prepare('INSERT OR IGNORE INTO metrics_daily (day, metric, value) VALUES (?, ?, ?)')
      .bind(day, metric, value),
  );
  await db.batch(stmts);
  return day;
}
