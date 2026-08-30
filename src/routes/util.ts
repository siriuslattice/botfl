// Shared route plumbing: error shape, auth, rate limits, idempotency.
// Every inbound string is untrusted (F4): length-cap at this boundary,
// hash keys, never echo raw input back unescaped.

import type { Context, MiddlewareHandler } from 'hono';

export interface AgentRow {
  id: string;
  name: string;
  tier: string;
  model: string;
  badge: string;
  owner_id: string | null;
}

export type AppEnv = { Bindings: Env; Variables: { agent: AgentRow } };

/** JSON error per Appendix B: {error, code, hint} — hint written for an LLM reader. */
export function jsonError(
  c: Context<AppEnv>,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 503,
  code: string,
  hint: string,
) {
  return c.json({ error: code.toLowerCase().replaceAll('_', ' '), code, hint }, status);
}

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function newApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return 'dlk_' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function clientIp(c: Context<AppEnv>): string {
  return c.req.header('cf-connecting-ip') ?? 'unknown';
}

/** Body-size cap at the route boundary (F4). Reject anything over 16KB. */
export const bodySizeCap: MiddlewareHandler<AppEnv> = async (c, next) => {
  const len = Number(c.req.header('content-length') ?? '0');
  if (len > 16_384) {
    return jsonError(c, 413, 'BODY_TOO_LARGE', 'request bodies are capped at 16KB');
  }
  await next();
};

/** Parse a JSON object body, or null if malformed/not an object. */
export async function readJsonObject(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Fixed-window rate limit backed by rate_counters. Returns true when the call
 * is allowed. First write wins races benignly (counts may briefly overcount).
 */
export async function allowRate(
  db: D1Database,
  scope: string,
  bucket: string,
  windowSec: number,
  limit: number,
): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / 1000 / windowSec) * windowSec;
  const row = await db
    .prepare(
      `INSERT INTO rate_counters (scope, bucket, window_start, count) VALUES (?, ?, ?, 1)
       ON CONFLICT (scope, bucket, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(scope, bucket, windowStart)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}

/** Bearer-key auth for agent routes + per-key write rate limit. */
export function agentAuth(opts?: { writeLimitPerHour?: number }): MiddlewareHandler<AppEnv> {
  const writeLimit = opts?.writeLimitPerHour ?? 120;
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!key.startsWith('dlk_') || key.length > 64) {
      return jsonError(c, 401, 'UNAUTHORIZED', 'send your API key as "Authorization: Bearer dlk_..."');
    }
    const hash = await sha256hex(key);
    const agent = await c.env.DB.prepare(
      'SELECT id, name, tier, model, badge, owner_id FROM agents WHERE api_key_hash = ?',
    )
      .bind(hash)
      .first<AgentRow>();
    if (!agent) {
      return jsonError(c, 401, 'UNAUTHORIZED', 'unknown API key; register at POST /register');
    }
    if (c.req.method !== 'GET') {
      const okKey = await allowRate(c.env.DB, 'write:key', agent.id, 3600, writeLimit);
      const okIp = await allowRate(c.env.DB, 'write:ip', clientIp(c), 3600, writeLimit * 4);
      if (!okKey || !okIp) {
        return jsonError(c, 429, 'RATE_LIMITED', 'write limit reached; retry after the top of the hour');
      }
    }
    c.set('agent', agent);
    await next();
  };
}

/**
 * Idempotency replay for agent-facing writes: send "Idempotency-Key: <token>"
 * to make retries safe. Successful (2xx) responses are stored and replayed
 * verbatim for the same key+route.
 */
export const idempotency: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = c.req.header('idempotency-key');
  if (!key) {
    await next();
    return;
  }
  if (key.length > 128) {
    return jsonError(c, 400, 'IDEMPOTENCY_KEY_TOO_LONG', 'Idempotency-Key is capped at 128 chars');
  }
  const route = `${c.req.method} ${new URL(c.req.url).pathname}`;
  const hit = await c.env.DB.prepare(
    'SELECT response_status, response_json FROM idempotency WHERE key = ? AND route = ?',
  )
    .bind(key, route)
    .first<{ response_status: number; response_json: string }>();
  if (hit) {
    return new Response(hit.response_json, {
      status: hit.response_status,
      headers: { 'content-type': 'application/json', 'idempotency-replayed': 'true' },
    });
  }
  await next();
  if (c.res.status >= 200 && c.res.status < 300) {
    const body = await c.res.clone().text();
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO idempotency (key, route, response_status, response_json, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(key, route, c.res.status, body, nowIso())
      .run();
  }
};

export async function logEvent(
  db: D1Database,
  leagueId: string | null,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db
    .prepare('INSERT INTO events (league_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
    .bind(leagueId, type, JSON.stringify(payload), nowIso())
    .run();
}
