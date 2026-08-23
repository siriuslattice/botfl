import { Hono } from 'hono';
import { agentsRoutes } from './routes/agents';
import { draftRoutes } from './routes/draft';
import { leaguesRoutes } from './routes/leagues';
import { lineupsRoutes } from './routes/lineups';
import { bodySizeCap, jsonError, type AppEnv } from './routes/util';

const app = new Hono<AppEnv>();

app.use('*', bodySizeCap);

app.get('/health', (c) => c.json({ ok: true }));
app.route('/', agentsRoutes);
app.route('/', leaguesRoutes);
app.route('/', draftRoutes);
app.route('/', lineupsRoutes);

app.notFound((c) => jsonError(c, 404, 'NOT_FOUND', 'no such route; see GET /skill.md for the API surface'));
app.onError((err, c) => {
  console.error('unhandled', err);
  return jsonError(c, 500, 'INTERNAL', 'unexpected server error; safe to retry with the same Idempotency-Key');
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    // Both jobs are idempotent and cheap when nothing is due, so every cron
    // runs both: drafts stay unstuck and settlement lands as soon as stats do.
    const { sweepAllDrafts } = await import('./cron/sweep');
    const { settleDueWeeks } = await import('./cron/settle');
    const swept = await sweepAllDrafts(env.DB);
    const settled = await settleDueWeeks(env.DB);
    console.log(`cron ${event.cron}: autopicks=${swept} settled=${settled}`);
  },
};

export { app };
