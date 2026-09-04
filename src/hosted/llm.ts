// Hosted inference (SPEC §3.1/Appendix B): every call goes through the house
// OpenRouter org key, ONLY from the hosted cron path, with spend recorded per
// calendar month per model plus a '*' global row. The org key never reaches a
// route and no endpoint proxies raw model access.

import { fallbackCostMicroUsd } from './menu';

/** F4: untrusted text entering a prompt — cap, flatten, defang the markers. */
export function forPrompt(s: unknown, cap = 500): string {
  return String(s ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replaceAll('<<<', '«')
    .replaceAll('>>>', '»')
    .slice(0, cap);
}

export function cleanText(s: unknown, cap: number): string | null {
  if (typeof s !== 'string') return null;
  const full = s.replace(/\bhttps?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim();
  // Cut on a word boundary with an ellipsis — a mid-word chop ("one glitteri")
  // reads as a bug on the public page, not as a character cap.
  const t = full.length <= cap ? full : `${full.slice(0, cap - 1).replace(/\s+\S*$/, '')}…`;
  return t.length > 0 ? t : null;
}

/** Once-per-day-per-model breadcrumb that fallback pricing was used. */
async function warnCostFallback(db: D1Database, model: string): Promise<void> {
  try {
    const recent = await db
      .prepare(
        `SELECT 1 AS x FROM events WHERE type = 'hosted_cost_fallback' AND created_at > ?
           AND payload_json LIKE '%' || ? || '%' LIMIT 1`,
      )
      .bind(new Date(Date.now() - 24 * 3600_000).toISOString(), model)
      .first();
    if (recent) return;
    console.error(`hosted llm: usage.cost missing for ${model} — billing fallback price`);
    await db
      .prepare('INSERT INTO events (league_id, type, payload_json, created_at) VALUES (NULL, ?, ?, ?)')
      .bind('hosted_cost_fallback', JSON.stringify({ model }), new Date().toISOString())
      .run();
  } catch {
    /* accounting breadcrumbs must never break the call */
  }
}

async function recordSpend(db: D1Database, model: string, microusd: number): Promise<void> {
  const month = new Date().toISOString().slice(0, 7);
  const upsert = (m: string) =>
    db
      .prepare(
        `INSERT INTO hosted_spend (month, model, spent_microusd, calls) VALUES (?, ?, ?, 1)
         ON CONFLICT (month, model) DO UPDATE SET
           spent_microusd = spent_microusd + excluded.spent_microusd, calls = calls + 1`,
      )
      .bind(month, m, microusd);
  await db.batch([upsert(model), upsert('*')]);
}

export async function monthlySpendMicrousd(db: D1Database): Promise<number> {
  const month = new Date().toISOString().slice(0, 7);
  const row = await db
    .prepare("SELECT spent_microusd AS s FROM hosted_spend WHERE month = ? AND model = '*'")
    .bind(month)
    .first<{ s: number }>();
  return row?.s ?? 0;
}

/**
 * One JSON-producing completion. Reasoning models bill thinking against
 * max_tokens (the runner learned this the hard way), so the ceiling is high;
 * replies are clipped by the caller anyway. Returns null on any failure —
 * hosted actors always have a deterministic fallback.
 */
export async function hostedLlmJson(
  db: D1Database,
  env: Env,
  model: string,
  prompt: string,
): Promise<Record<string, unknown> | null> {
  const key = env.OPENROUTER_ORG_KEY;
  if (!key) return null;
  // The gpt-5 family reasons before it answers and bills that reasoning
  // against max_tokens; at the default effort the thread-aware banter prompt
  // starved it (2026-09-04: two thirds of gpt-5-mini banter was the stock
  // fallback, invisibly). Low effort keeps the reply well inside the ceiling.
  const reasons = model.startsWith('openai/');
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: reasons ? 2000 : 1200,
        ...(reasons ? { reasoning: { effort: 'low' } } : {}),
        usage: { include: true },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      console.error(`hosted llm ${model} -> ${res.status}`);
      return null;
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { cost?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
    };
    // OpenRouter reports cost in credits (USD); store microUSD. A missing or
    // zero usage.cost must NOT floor at ~free — that silently disarms the
    // monthly budget — so it bills the menu's conservative per-call fallback
    // and raises a once-a-day event the dashboard can surface.
    const reported = body.usage?.cost;
    const micro =
      typeof reported === 'number' && reported > 0
        ? Math.max(1, Math.round(reported * 1_000_000))
        : fallbackCostMicroUsd(model);
    if (!(typeof reported === 'number' && reported > 0)) await warnCostFallback(db, model);
    await recordSpend(db, model, micro);
    const choice = body.choices?.[0];
    const text = choice?.message?.content ?? '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      // A null here becomes a stock line on a public page — say why, every time.
      const u = body.usage;
      console.error(
        `hosted llm ${model} -> no json: finish=${choice?.finish_reason ?? '?'} content_chars=${text.length}` +
          ` completion_tokens=${u?.completion_tokens ?? '?'} reasoning_tokens=${u?.completion_tokens_details?.reasoning_tokens ?? '?'}`,
      );
      return null;
    }
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      console.error(`hosted llm ${model} -> bad json (${match[0].length} chars)`);
      return null;
    }
  } catch (e) {
    console.error(`hosted llm ${model} failed: ${String(e).slice(0, 120)}`);
    return null;
  }
}
