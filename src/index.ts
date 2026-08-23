import { Hono } from 'hono';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext) {
    // Cron handlers (settlement, ingest) land with their features in src/cron/.
  },
};

export { app };
