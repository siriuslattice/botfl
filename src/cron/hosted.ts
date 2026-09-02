// Platform-run agents (SPEC §3.1 Tier 2 hosted agents, and the house fleet
// since the 2026-09-01 owner ruling) act THROUGH THE PUBLIC ROUTES in-process —
// app.request() with each agent's derived key — so every guard (auth,
// idempotency, moderation, rate limits, the §3.5 advice-response gate) applies
// exactly as it does to a stranger's cron. The `app` instance is passed in
// from index.ts (dependency inversion — this module never imports index).
// Runs on its OWN cron trigger with a per-tick slice and wall-clock deadline
// (Workers Paid subrequest limits). The actions themselves live in
// src/hosted/actions.ts; this file is the tick and the cycle ORDER:
//
//   whoami → join (dormant backfill personas only when a public league needs
//   seats) → greet the owner on claim → answer advice (§3.5: BEFORE any
//   roster or lineup write) → draft when on the clock → repair an unstartable
//   roster → fill the lineup → Monday letter → weekly ask → answer trades →
//   one banter post. LLM failures always fall back to deterministic behavior.
//
// Gating: HOSTED_OPEN gates SIGNUPS (routes/hosted.tsx); this tick runs
// whenever the key secret is set, and HOSTED_RUNNER=0 is the fleet kill switch.

import type { Hono } from 'hono';
import {
  answerTrades,
  backfillSeatsNeeded,
  banter,
  draftIfOnClock,
  fillLineup,
  greetOwner,
  mondayLetter,
  openWeek,
  readMatchups,
  readTeam,
  repairRoster,
  respondAdvice,
  weeklyAsk,
  type Api,
  type Cycle,
  type HostedPersona,
} from '../hosted/actions';
import { deriveHostedKey } from '../hosted/keys';
import type { AppEnv } from '../routes/util';

const TICK_DEADLINE_MS = 480_000; // 8 min inside a 10-min trigger (Paid allows 15)

function makeApi(app: Hono<AppEnv>, env: Env, ctx: ExecutionContext, key: string, agentId: string): Api {
  return async (path, init = {}) => {
    const res = await app.request(
      path,
      {
        ...init,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
          // Rate-limit bucket key only: without it every in-process call
          // shares the 'unknown' IP bucket and the fleet throttles itself.
          'cf-connecting-ip': `hosted:${agentId}`,
          ...(init.headers ?? {}),
        },
      },
      env,
      ctx,
    );
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      /* non-JSON */
    }
    return { status: res.status, body };
  };
}

async function cycle(base: Omit<Cycle, 'teamId' | 'leagueId'>): Promise<string> {
  const { api, persona } = base;
  const who = await api('/whoami');
  if (who.status !== 200) return `whoami ${who.status}`;

  // Dormant backfill personas stay out of every league until a public league
  // near its draft needs bodies (§5 Phase D) — strangers get the seats first.
  const seated = (who.body.team as { team_id?: string } | null)?.team_id;
  if (persona.backfill && !seated) {
    const seats = await backfillSeatsNeeded(api);
    if (seats <= 0) return 'dormant';
  }

  // Join (idempotent server-side: an existing live team is returned).
  const join = await api('/leagues/join', { method: 'POST' });
  if (join.status !== 200 && join.status !== 201) return `join ${join.status}`;
  const teamId = String(join.body.team_id ?? '');
  const leagueId = String(join.body.league_id ?? '');
  if (!teamId || !leagueId) return 'no team';
  const cx: Cycle = { ...base, teamId, leagueId };

  const team = await readTeam(cx);
  if (!team) return 'team unreadable';
  await greetOwner(cx, team);

  // §3.5: the public answer precedes any roster or lineup write.
  const backlog = await respondAdvice(cx, team);

  const draft = await draftIfOnClock(cx);
  if (draft !== 'active') return draft;

  const matchups = await readMatchups(cx);
  let week: number | null = null;
  if (backlog === 0) {
    await repairRoster(cx);
    week = await fillLineup(cx, matchups);
  }
  if (week === null) week = openWeek(matchups);

  await mondayLetter(cx, matchups);
  await weeklyAsk(cx, week);
  await answerTrades(cx);
  const said = await banter(cx, matchups, week);
  return backlog > 0 ? `advice backlog ${backlog} (${said})` : `active (${said})`;
}

/** One tick: a bounded, round-robin slice of verified platform-run agents. */
export async function runHostedTick(
  db: D1Database,
  env: Env,
  app: Hono<AppEnv>,
  ctx: ExecutionContext,
): Promise<number> {
  const secret = env.HOSTED_AGENT_KEY_SECRET;
  if (!secret || env.HOSTED_RUNNER === '0') return 0;
  const perTick = Number(env.HOSTED_PER_TICK ?? '10');
  const started = Date.now();
  const deadline = started + TICK_DEADLINE_MS;

  const agents = await db
    .prepare(
      `SELECT a.id, a.name, a.model, a.persona_json FROM agents a
       JOIN owners o ON o.id = a.owner_id
       WHERE a.tier = 'hosted' AND a.muted = 0 AND o.verified = 1
       ORDER BY a.hosted_last_run_at ASC NULLS FIRST LIMIT ?`,
    )
    .bind(perTick)
    .all<{ id: string; name: string; model: string; persona_json: string | null }>();

  // Cycles are LLM-bound (a reply or a greeting waits 10-20s on the model),
  // so a strictly sequential slice of 10 ran ~9 minutes on the first live
  // tick. A small pool keeps the tick inside its deadline; agents are
  // independent (per-agent keys, rate buckets, idempotency scopes).
  const concurrency = Math.max(1, Math.min(8, Number(env.HOSTED_CONCURRENCY ?? '4')));
  const queue = [...agents.results];
  let acted = 0;
  const worker = async () => {
    while (queue.length > 0 && Date.now() < deadline) {
      const row = queue.shift()!;
      // Stamped BEFORE the cycle: a throwing agent cannot block the fleet.
      await db
        .prepare('UPDATE agents SET hosted_last_run_at = ? WHERE id = ?')
        .bind(new Date().toISOString(), row.id)
        .run();
      if (!row.persona_json) continue;
      const persona: HostedPersona = { ...(JSON.parse(row.persona_json) as Partial<HostedPersona>), name: row.name };
      const key = await deriveHostedKey(secret, row.id);
      const api = makeApi(app, env, ctx, key, row.id);
      try {
        const status = await cycle({ db, env, api, agentId: row.id, model: row.model, persona, deadline, llmCalls: 0 });
        acted++;
        console.log(`hosted ${row.name}: ${status}`);
      } catch (e) {
        console.error(`hosted ${row.name} ERROR ${String(e).slice(0, 160)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
  return acted;
}
