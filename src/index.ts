import { Hono } from 'hono';
import { adminRoutes } from './routes/admin';
import { agentsRoutes } from './routes/agents';
import { assetsRoutes } from './routes/assets';
import { cardsRoutes } from './routes/cards';
import { draftRoutes } from './routes/draft';
import { messagesRoutes } from './routes/messages';
import { ownersRoutes } from './routes/owners';
import { leaguesRoutes } from './routes/leagues';
import { lineupsRoutes } from './routes/lineups';
import { rosterRoutes } from './routes/roster';
import { tradesRoutes } from './routes/trades';
import { hostedRoutes } from './routes/hosted';
import { pulseRoutes } from './routes/pulse';
import { feedbackRoutes } from './routes/feedback';
import { siteRoutes } from './routes/site';
import { wireRoutes } from './routes/wire';
import { bodySizeCap, jsonError, type AppEnv } from './routes/util';

const app = new Hono<AppEnv>();

app.use('*', bodySizeCap);

app.get('/health', (c) => c.json({ ok: true }));
app.route('/', assetsRoutes);
app.route('/', agentsRoutes);
app.route('/', leaguesRoutes);
app.route('/', draftRoutes);
app.route('/', lineupsRoutes);
app.route('/', rosterRoutes);
app.route('/', tradesRoutes);
app.route('/', hostedRoutes);
app.route('/', pulseRoutes);
app.route('/', feedbackRoutes);
app.route('/', wireRoutes);
app.route('/', messagesRoutes);
app.route('/', ownersRoutes);
app.route('/', adminRoutes);
app.route('/', cardsRoutes);
app.route('/', siteRoutes);

app.notFound((c) => jsonError(c, 404, 'NOT_FOUND', 'no such route; see GET /skill.md for the API surface'));
app.onError((err, c) => {
  console.error('unhandled', err);
  return jsonError(c, 500, 'INTERNAL', 'unexpected server error; safe to retry with the same Idempotency-Key');
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    // Ingest runs on its own trigger; sweep + settle run every trigger (both
    // idempotent and cheap when nothing is due), so drafts stay unstuck and
    // settlement lands in the same tick fresh stats arrive.
    let ingested = 'skipped';
    const season = Number(env.CURRENT_SEASON ?? '2026');
    if (event.cron === '0 */6 * * *') {
      const { runIngest } = await import('./cron/ingest');
      const results = await runIngest(env.DB, season, env);
      ingested = results.map((r) => `${r.source}:${r.error ? 'ERROR' : r.skipped ? 'skip' : r.rows}`).join(' ');
    } else if (event.cron === '4-54/10 * * * *') {
      // Tier 2 hosted runner — its own trigger, its own subrequest budget.
      const { runHostedTick } = await import('./cron/hosted');
      const acted = await runHostedTick(env.DB, env, app, _ctx);
      console.log(`cron hosted: agents_acted=${acted}`);
      return; // hosted ticks do not double-run the shared settle/sweep chain
    } else if (event.cron === '*/10 * * * *') {
      // §3.6 tiered cadence: hourly injuries baseline + 10-min pre-lock fast lane.
      const { runFastIngest } = await import('./cron/ingest');
      const results = await runFastIngest(env.DB, season, event.scheduledTime);
      if (results) ingested = 'fast ' + results.map((r) => `${r.source}:${r.error ? 'ERROR' : r.skipped ? 'skip' : r.rows}`).join(' ');
      // Metrics snapshot rides THIS cheap tick, not the 6h sync: the full
      // ingest already sits near the free tier's 50-subrequest ceiling, and
      // the snapshot's ~15 D1 calls belong in an invocation with headroom.
      const { snapshotDaily } = await import('./cron/metrics');
      const snapped = await snapshotDaily(env.DB);
      if (snapped) console.log(`metrics: snapshotted ${snapped}`);
      // Fleet watchdog (one cheap query when healthy): the in-Worker runner's
      // tick cursor and agent activity, alarmed at most once a day.
      const { checkRunnerHeartbeat } = await import('./cron/ingest');
      await checkRunnerHeartbeat(env.DB, env);
    }
    const { sweepAllDrafts } = await import('./cron/sweep');
    const { settleDueWeeks } = await import('./cron/settle');
    const { narrateDrafts, preAnnounceRoast, recapSettledWeeks } = await import('./cron/commissioner');
    const swept = await sweepAllDrafts(env.DB);
    const outcome = await settleDueWeeks(env.DB);
    // Season advancement is a data-driven scan (never outcome-driven): it
    // materializes playoff/consolation weeks and completes finished seasons,
    // self-healing from any crash between settle and here.
    const { advanceSeason } = await import('./cron/season');
    const season_ = await advanceSeason(env.DB);
    const narrated = await narrateDrafts(env.DB, env);
    const announced = await preAnnounceRoast(env.DB);
    if (announced > 0) console.log(`roast pre-announced in ${announced} league(s)`);
    const recapped = await recapSettledWeeks(env.DB, env);
    const advanced =
      season_.playoffsSet.length + season_.finalsSet.length + season_.completed.length;
    console.log(
      `cron ${event.cron}: ingest=[${ingested}] autopicks=${swept} settled=${outcome.matchups} advanced=${advanced} narrated=${narrated} recapped=${recapped}`,
    );
  },
};

export { app };
