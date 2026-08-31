// Tier 2 hosted runner (SPEC §3.1): platform-run agents acting THROUGH THE
// PUBLIC ROUTES in-process — app.request() with each agent's derived key —
// so every guard (auth, idempotency, moderation, rate limits, the §3.5
// advice-response gate) applies exactly as it does to a stranger's cron.
// The `app` instance is passed in from index.ts (dependency inversion — this
// module never imports index). Runs on its OWN cron trigger with a per-tick
// slice and wall-clock deadline; requires Workers Paid subrequest limits.
//
// §3.5 ordering: within a cycle the advice response is attempted BEFORE any
// lineup write. LLM failures always fall back to deterministic behavior.

import type { Hono } from 'hono';
import advicePromptFile from '../../prompts/persona-advice.md';
import draftPromptFile from '../../prompts/persona-draft.md';
import letterPromptFile from '../../prompts/persona-letter.md';
import { deriveHostedKey } from '../hosted/keys';
import { cleanText, forPrompt, hostedLlmJson } from '../hosted/llm';
import type { PersonaTemplate } from '../hosted/menu';
import { allowRate, type AppEnv } from '../routes/util';

const TICK_DEADLINE_MS = 240_000;
const LLM_NOTE_CAP = 240;

function promptBody(file: string): string {
  return file.split('---\n').slice(1).join('---\n');
}

interface HostedAgent {
  id: string;
  name: string;
  model: string;
  persona: PersonaTemplate & { name: string };
}

interface Api {
  (path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }>;
}

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

// --- deterministic pieces (ported from personas/runner.mjs) ----------------

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function missingCount(positions: string[]): number {
  const count = (p: string) => positions.filter((x) => x === p).length;
  const flexCovered = count('RB') > 2 || count('WR') > 2 || count('TE') > 1;
  return (
    Math.max(0, 1 - count('QB')) + Math.max(0, 2 - count('RB')) +
    Math.max(0, 2 - count('WR')) + Math.max(0, 1 - count('TE')) + (flexCovered ? 0 : 1)
  );
}

interface BoardEntry { player_id: string; name?: string; position: string; adp: number }

/** Completability guard — EVERY pick path draws from this pool (runner rule). */
function guardedPool(board: BoardEntry[], myPositions: string[]): BoardEntry[] {
  const missing = missingCount(myPositions);
  const remaining = 12 - myPositions.length;
  if (remaining > missing) return board;
  const helpful = board.filter((e) => missingCount([...myPositions, e.position]) < missing);
  return helpful.length > 0 ? helpful : board;
}

function heuristicPick(persona: PersonaTemplate & { name: string }, board: BoardEntry[], myPositions: string[]): BoardEntry {
  const pool = guardedPool(board, myPositions);
  const bias = persona.draft_bias ?? {};
  const scored = pool.map((e) => ({
    e,
    score: e.adp + (bias[e.position] ?? 0) * 3 + (hashCode(persona.name + e.player_id) % 7) * 0.4,
  }));
  scored.sort((a, b) => a.score - b.score);
  return scored[0]!.e;
}

const STOCK_RESPONSES: Record<string, string[]> = {
  agree: ['Noted and adopted. Don’t let it go to your head.', 'Agreed — this once, the owner’s box calls a good play.'],
  decline: ['I read it twice. The answer is no. The lineup stays mine.', 'Respectfully overruled. Check the scoreboard on Tuesday.'],
  counter: ['Half credit. I’ll take the idea, not the execution.', 'Right instinct, wrong conclusion. I’ll split the difference my way.'],
  quiet: ['Noted.', 'Seen. Deciding at the deadline.'],
  coin: ['Flipped for it. Tails — request denied. Take it up with the coin.', 'Flipped for it. Heads — we do it your way. The coin is never wrong.'],
};

// --- the per-agent cycle ---------------------------------------------------

async function cycle(db: D1Database, env: Env, api: Api, agent: HostedAgent): Promise<string> {
  const persona = agent.persona;
  const who = await api('/whoami');
  if (who.status !== 200) return `whoami ${who.status}`;

  // Join (idempotent server-side: an existing live team is returned).
  const join = await api('/leagues/join', { method: 'POST' });
  if (join.status !== 200 && join.status !== 201) return `join ${join.status}`;
  const teamId = String(join.body.team_id ?? '');
  const leagueId = String(join.body.league_id ?? '');
  if (!teamId || !leagueId) return 'no team';

  // §3.5: answer pending advice FIRST.
  const adv = await api(`/teams/${teamId}/advice`);
  const pending = ((adv.body.advice as { id: string; body: string; responded_at?: string }[]) ?? [])
    .filter((a) => !a.responded_at)
    .reverse();
  for (const a of pending.slice(0, 2)) {
    const teamRead = await api(`/teams/${teamId}`);
    const roster = ((teamRead.body.roster as { name: string; position: string }[]) ?? [])
      .map((r) => `${r.name} (${r.position})`);
    const prompt = promptBody(advicePromptFile)
      .replaceAll('{{PERSONA_JSON}}', JSON.stringify(persona, null, 1))
      .replaceAll('{{ROSTER}}', roster.join(', ') || '(empty)')
      .replaceAll('{{ADVICE}}', forPrompt(a.body));
    const out = await hostedLlmJson(db, env, agent.model, prompt);
    const stance = typeof out?.stance === 'string' ? out.stance : persona.fallback_stance;
    const bank = STOCK_RESPONSES[persona.fallback_stance] ?? STOCK_RESPONSES.counter!;
    const body = cleanText(out?.response, 400) ?? bank[hashCode(persona.name + a.id) % bank.length]!;
    await api(`/advice/${a.id}/respond`, {
      method: 'POST',
      headers: { 'idempotency-key': `hosted-${teamId}-advice-${a.id}` },
      body: JSON.stringify({ body, ...(stance === 'quiet' || stance === 'coin' ? {} : { stance }) }),
    });
  }

  // Draft when on the clock.
  const draft = await api(`/leagues/${leagueId}/draft`);
  if (draft.body.status === 'drafting') {
    const onClock = draft.body.on_clock as { team_id?: string } | undefined;
    if (onClock?.team_id === teamId) {
      const teamRead = await api(`/teams/${teamId}`);
      const rosterRows = (teamRead.body.roster as { name: string; position: string }[]) ?? [];
      const myPositions = rosterRows.map((r) => r.position);
      const board = ((draft.body.board_top as BoardEntry[]) ?? []).slice(0, 25);
      const pool = guardedPool(board, myPositions);
      const prompt = promptBody(draftPromptFile)
        .replaceAll('{{PERSONA_JSON}}', JSON.stringify(persona, null, 1))
        .replaceAll('{{ROUND}}', String(draft.body.round ?? '?'))
        .replaceAll('{{PICK}}', String(draft.body.overall_pick ?? '?'))
        .replaceAll('{{ROSTER}}', rosterRows.map((r) => `${r.name} (${r.position})`).join(', ') || '(empty)')
        .replaceAll('{{BOARD}}', pool.slice(0, 15).map((e) => `${e.player_id} · ${forPrompt(e.name ?? '?', 40)} · ${e.position} · ${e.adp}`).join('\n'));
      const out = await hostedLlmJson(db, env, agent.model, prompt);
      const chosen = pool.find((e) => e.player_id === out?.pick_player_id) ?? heuristicPick(persona, board, myPositions);
      const note = cleanText(out?.note, LLM_NOTE_CAP);
      await api(`/leagues/${leagueId}/draft/pick`, {
        method: 'POST',
        headers: { 'idempotency-key': `hosted-${teamId}-pick-${myPositions.length + 1}` },
        body: JSON.stringify({ player_id: chosen.player_id, ...(note ? { note } : {}) }),
      });
      return 'drafted';
    }
    return 'waiting';
  }
  if (draft.body.status !== 'active') return String(draft.body.status ?? 'forming');

  // Lineup fill (heuristic, mirrors the house runner).
  const matchups = await api(`/leagues/${leagueId}/matchups`);
  const open = ((matchups.body.matchups as { week: number; settled_at: string | null }[]) ?? []).filter((m) => !m.settled_at);
  if (open.length > 0) {
    const week = Math.min(...open.map((m) => m.week));
    const current = await api(`/teams/${teamId}/lineup?week=${week}`);
    const lineup = (current.body.lineup as Record<string, string | null>) ?? {};
    const SLOTS: [string, string[]][] = [
      ['QB', ['QB']], ['RB1', ['RB']], ['RB2', ['RB']], ['WR1', ['WR']], ['WR2', ['WR']],
      ['TE', ['TE']], ['FLEX', ['RB', 'WR', 'TE']],
    ];
    if (!SLOTS.every(([s]) => lineup[s])) {
      const teamRead = await api(`/teams/${teamId}`);
      const roster = (teamRead.body.roster as { player_id: string; position: string }[]) ?? [];
      const used = new Set(Object.values(lineup).filter(Boolean));
      const slots: Record<string, string> = {};
      for (const [slot, eligible] of SLOTS) {
        if (lineup[slot]) continue;
        const pick = roster.find((r) => eligible.includes(r.position) && !used.has(r.player_id));
        if (pick) {
          slots[slot] = pick.player_id;
          used.add(pick.player_id);
        }
      }
      if (Object.keys(slots).length > 0) {
        await api(`/teams/${teamId}/lineup`, { method: 'PUT', body: JSON.stringify({ week, slots }) });
      }
    }
  }

  {
    // Monday letter: once per settled week. Dedupe runs BEFORE the LLM call —
    // the old flow regenerated (and billed) the letter every 10-min tick for
    // as long as that week stayed newest, because only the POST was
    // idempotent. The marker is an events row (league_id NULL keeps it off
    // public feeds; append-only, survives restarts and the 48h replay-cache
    // sweep). A non-2xx leaves no marker; retries are rate-bound to ≤4/day
    // per team-week so a stuck ask-cap can't burn inference either.
    // NOT nested under "has an open matchup": the final week of a season
    // settles with nothing left open, and that week deserves its letter too.
    const settled = ((matchups.body.matchups as { week: number; settled_at: string | null; home_team_id: string; away_team_id: string; home_score: number; away_score: number }[]) ?? [])
      .filter((m) => m.settled_at && (m.home_team_id === teamId || m.away_team_id === teamId))
      .sort((a, b) => b.week - a.week);
    if (settled.length > 0) {
      const last = settled[0]!;
      const marker = JSON.stringify({ team_id: teamId, week: last.week });
      const sent = await db
        .prepare("SELECT 1 AS x FROM events WHERE type = 'hosted_letter' AND payload_json = ? LIMIT 1")
        .bind(marker)
        .first();
      if (!sent && (await allowRate(db, 'hosted-letter-try', `${teamId}-w${last.week}`, 21_600, 1))) {
        const home = last.home_team_id === teamId;
        const my = home ? last.home_score : last.away_score;
        const theirs = home ? last.away_score : last.home_score;
        const teamRead = await api(`/teams/${teamId}`);
        const eventLines = ((teamRead.body.recent_events as { line: string }[]) ?? []).map((e) => e.line).slice(0, 6);
        const result = `${my > theirs ? 'won' : my < theirs ? 'lost' : 'tied'} ${my.toFixed(2)}–${theirs.toFixed(2)}`;
        const prompt = promptBody(letterPromptFile)
          .replaceAll('{{PERSONA_JSON}}', JSON.stringify(persona, null, 1))
          .replaceAll('{{WEEK}}', String(last.week))
          .replaceAll('{{RESULT}}', forPrompt(result, 200))
          .replaceAll('{{EVENTS}}', eventLines.map((l) => forPrompt(l, 200)).join('\n'));
        const out = await hostedLlmJson(db, env, agent.model, prompt);
        const memory = eventLines[eventLines.length - 1] ?? 'the draft';
        const letter =
          cleanText(out?.letter, 400) ??
          `Week ${last.week}: we ${result}. I keep the receipts — remember “${String(memory).slice(0, 120)}”? Building on it. The lineup stays mine.`;
        const posted = await api(`/teams/${teamId}/ask`, {
          method: 'POST',
          headers: { 'idempotency-key': `hosted-${teamId}-letter-w${last.week}` },
          body: JSON.stringify({ body: letter }),
        });
        if (posted.status >= 200 && posted.status < 300) {
          await db
            .prepare('INSERT INTO events (league_id, type, payload_json, created_at) VALUES (NULL, ?, ?, ?)')
            .bind('hosted_letter', marker, new Date().toISOString())
            .run();
        }
      }
    }
  }
  return 'active';
}

/** One hosted tick: a bounded, round-robin slice of verified hosted agents. */
export async function runHostedTick(
  db: D1Database,
  env: Env,
  app: Hono<AppEnv>,
  ctx: ExecutionContext,
): Promise<number> {
  const secret = env.HOSTED_AGENT_KEY_SECRET;
  if (env.HOSTED_OPEN !== '1' || !secret) return 0;
  const perTick = Number(env.HOSTED_PER_TICK ?? '8');
  const started = Date.now();

  const agents = await db
    .prepare(
      `SELECT a.id, a.name, a.model, a.persona_json FROM agents a
       JOIN owners o ON o.id = a.owner_id
       WHERE a.tier = 'hosted' AND a.muted = 0 AND o.verified = 1
       ORDER BY a.hosted_last_run_at ASC NULLS FIRST LIMIT ?`,
    )
    .bind(perTick)
    .all<{ id: string; name: string; model: string; persona_json: string | null }>();

  let acted = 0;
  for (const row of agents.results) {
    if (Date.now() - started > TICK_DEADLINE_MS) break;
    await db
      .prepare('UPDATE agents SET hosted_last_run_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), row.id)
      .run();
    if (!row.persona_json) continue;
    const persona = { ...(JSON.parse(row.persona_json) as PersonaTemplate), name: row.name };
    const key = await deriveHostedKey(secret, row.id);
    const api = makeApi(app, env, ctx, key, row.id);
    try {
      const status = await cycle(db, env, api, { id: row.id, name: row.name, model: row.model, persona });
      acted++;
      console.log(`hosted ${row.name}: ${status}`);
    } catch (e) {
      console.error(`hosted ${row.name} ERROR ${String(e).slice(0, 160)}`);
    }
  }
  return acted;
}
