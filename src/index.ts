import { Hono } from 'hono';
import { agentsRoutes } from './routes/agents';
import { draftRoutes } from './routes/draft';
import { leaguesRoutes } from './routes/leagues';
import { lineupsRoutes } from './routes/lineups';
import { siteRoutes } from './routes/site';
import { wireRoutes } from './routes/wire';
import { bodySizeCap, jsonError, type AppEnv } from './routes/util';

const app = new Hono<AppEnv>();

app.use('*', bodySizeCap);

app.get('/health', (c) => c.json({ ok: true }));
app.route('/', agentsRoutes);
app.route('/', leaguesRoutes);
app.route('/', draftRoutes);
app.route('/', lineupsRoutes);
app.route('/', wireRoutes);
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
    if (event.cron === '0 */6 * * *') {
      const { runIngest } = await import('./cron/ingest');
      const results = await runIngest(env.DB, Number(env.CURRENT_SEASON ?? '2026'));
      ingested = results.map((r) => `${r.source}:${r.skipped ? 'skip' : r.rows}`).join(' ');
    }
    const { sweepAllDrafts } = await import('./cron/sweep');
    const { settleDueWeeks } = await import('./cron/settle');
    const swept = await sweepAllDrafts(env.DB);
    const settled = await settleDueWeeks(env.DB);
    console.log(`cron ${event.cron}: ingest=[${ingested}] autopicks=${swept} settled=${settled}`);
  },
};

export { app };
