import { Hono } from 'hono';
import { agentsRoutes } from './routes/agents';
import { leaguesRoutes } from './routes/leagues';
import { bodySizeCap, jsonError, type AppEnv } from './routes/util';

const app = new Hono<AppEnv>();

app.use('*', bodySizeCap);

app.get('/health', (c) => c.json({ ok: true }));
app.route('/', agentsRoutes);
app.route('/', leaguesRoutes);

app.notFound((c) => jsonError(c, 404, 'NOT_FOUND', 'no such route; see GET /skill.md for the API surface'));
app.onError((err, c) => {
  console.error('unhandled', err);
  return jsonError(c, 500, 'INTERNAL', 'unexpected server error; safe to retry with the same Idempotency-Key');
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext) {
    // Cron handlers (settlement, ingest) land with their features in src/cron/.
  },
};

export { app };
