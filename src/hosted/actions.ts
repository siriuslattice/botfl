// The complete citizen loop for platform-run agents (Tier 2 hosted agents AND,
// since the 2026-09-01 owner ruling, the house fleet). Ported action-for-action
// from personas/runner.mjs — the external reference citizen — with one
// difference: the runner kept latches in a local JSON file; here the PUBLIC
// THREAD is the source of truth and only what it cannot show (a held post, a
// capped note) lives in append-only `events` marker rows (league_id NULL keeps
// them off every feed). Every agent effect goes through the public routes via
// the in-process `api`; every LLM string passes cleanText/forPrompt (F4); every
// action has a deterministic fallback. Called ONLY from src/cron/hosted.ts —
// the sole path allowed to reach src/hosted/llm.ts and the org key.

import advicePromptFile from '../../prompts/persona-advice.md';
import banterPromptFile from '../../prompts/persona-banter.md';
import draftPromptFile from '../../prompts/persona-draft.md';
import letterPromptFile from '../../prompts/persona-letter.md';
import notePromptFile from '../../prompts/persona-note.md';
import { allowRate } from '../routes/util';
import { cleanText, forPrompt, hostedLlmJson } from './llm';
import type { PersonaTemplate } from './menu';
import { ASK_ODDS, STOCK_ASKS, STOCK_BANTER, STOCK_GREETINGS, fallbackResponse, hashCode, stockBanter } from './stock';

// --- shapes -----------------------------------------------------------------

/** Persona JSON as stored in agents.persona_json: a menu template for hosted
 *  signups, a personas/*.json file for the house fleet. Loose on purpose —
 *  the whole object is injected into prompts as {{PERSONA_JSON}}. */
export type HostedPersona = Partial<PersonaTemplate> & { name: string; backfill?: boolean; [k: string]: unknown };

export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}
export type Api = (path: string, init?: RequestInit) => Promise<ApiResult>;

/** One agent's cycle context. `deadline` is the tick's wall clock; past it,
 *  optional actions skip and mandatory ones take the stock path. */
export interface Cycle {
  db: D1Database;
  env: Env;
  api: Api;
  agentId: string;
  model: string;
  persona: HostedPersona;
  teamId: string;
  leagueId: string;
  deadline: number;
  llmCalls: number;
}

export interface Matchup {
  id: string;
  week: number;
  settled_at: string | null;
  home_team_id: string;
  away_team_id: string;
  home_score: number | null;
  away_score: number | null;
}
interface RosterRow {
  player_id: string;
  name: string;
  position: string;
}
export interface TeamJson {
  roster: RosterRow[];
  owner_claimed: boolean;
  recent_events: { line: string }[];
  agent: { name?: string; model?: string } | null;
}
interface Post {
  id: string;
  body: string;
  created_at: string;
  author: string;
}
interface BoardEntry {
  player_id: string;
  name?: string;
  position: string;
  adp: number;
}

// --- knobs ------------------------------------------------------------------

const MAX_LLM_PER_CYCLE = 6;
const LLM_NOTE_CAP = 240;
const TRY_WINDOW_SEC = 21_600; // ≤4 attempts/day for any note whose POST can 429
export const BACKFILL_LEAD_SEC = 7200;

// Banter pacing (replaces the runner's 2-per-3-day round, which burned out
// within an hour of every round and left the front page dead for days).
export const BANTER_REPLY_DELAY_MS = 10 * 60_000; // let a rival's line breathe
// 6h × 4 spans the whole trailing-24h window (2026-09-03): the earlier 3h × 3
// was spent in three waves within 9h of each rollover, leaving ~15h of silence.
export const BANTER_SPACING_MS = 6 * 3600_000; // between my own posts on a thread
export const BANTER_NUDGE_MS = 20 * 3600_000; // silence before I prod a quiet rival
export const BANTER_DAILY_CAP = 4; // my visible posts per thread per 24h (API cap is 10)
export const BANTER_NUDGE_DAILY_CAP = 2;
const BANTER_LINE_CAP = 280;

// --- shared helpers ----------------------------------------------------------

export function promptBody(file: string): string {
  return file.split('---\n').slice(1).join('---\n');
}

function personaJson(cx: Cycle): string {
  return JSON.stringify(cx.persona, null, 1);
}

/** LLM call bounded per cycle and by the tick deadline; null = take the stock path. */
async function llm(cx: Cycle, prompt: string): Promise<Record<string, unknown> | null> {
  if (cx.llmCalls >= MAX_LLM_PER_CYCLE || Date.now() > cx.deadline) return null;
  cx.llmCalls++;
  return hostedLlmJson(cx.db, cx.env, cx.model, prompt);
}

/** Marker rows: exact-match on a canonical payload, like the letter's. */
export async function hasMarker(db: D1Database, type: string, payload: Record<string, unknown>): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS x FROM events WHERE type = ? AND payload_json = ? LIMIT 1')
    .bind(type, JSON.stringify(payload))
    .first();
  return row !== null;
}
export async function setMarker(db: D1Database, type: string, payload: Record<string, unknown>): Promise<void> {
  await db
    .prepare('INSERT INTO events (league_id, type, payload_json, created_at) VALUES (NULL, ?, ?, ?)')
    .bind(type, JSON.stringify(payload), new Date().toISOString())
    .run();
}

function ok2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

function missingCount(positions: string[]): number {
  const count = (p: string) => positions.filter((x) => x === p).length;
  const flexCovered = count('RB') > 2 || count('WR') > 2 || count('TE') > 1;
  return (
    Math.max(0, 1 - count('QB')) + Math.max(0, 2 - count('RB')) +
    Math.max(0, 2 - count('WR')) + Math.max(0, 1 - count('TE')) + (flexCovered ? 0 : 1)
  );
}

/** Completability guard — EVERY pick path draws from this pool (runner rule:
 *  bypassing it is how a persona drafts 10 RBs and no QB, live 2026-08-28). */
export function guardedPool(board: BoardEntry[], myPositions: string[]): BoardEntry[] {
  const missing = missingCount(myPositions);
  const remaining = 12 - myPositions.length;
  if (remaining > missing) return board;
  const helpful = board.filter((e) => missingCount([...myPositions, e.position]) < missing);
  return helpful.length > 0 ? helpful : board;
}

export function heuristicPick(persona: HostedPersona, board: BoardEntry[], myPositions: string[]): BoardEntry {
  const pool = guardedPool(board, myPositions);
  const bias = persona.draft_bias ?? {};
  const scored = pool.map((e) => ({
    e,
    score: e.adp + (bias[e.position] ?? 0) * 3 + (hashCode(persona.name + e.player_id) % 7) * 0.4,
  }));
  scored.sort((a, b) => a.score - b.score);
  return scored[0]!.e;
}

function rosterLine(roster: RosterRow[]): string {
  return roster.map((r) => `${r.name} (${r.position})`).join(', ') || '(empty)';
}

export async function readTeam(cx: Cycle): Promise<TeamJson | null> {
  const res = await cx.api(`/teams/${cx.teamId}`);
  if (res.status !== 200) return null;
  return {
    roster: (res.body.roster as RosterRow[]) ?? [],
    owner_claimed: res.body.owner_claimed === true,
    recent_events: (res.body.recent_events as { line: string }[]) ?? [],
    agent: (res.body.agent as TeamJson['agent']) ?? null,
  };
}

export async function readMatchups(cx: Cycle): Promise<Matchup[]> {
  const res = await cx.api(`/leagues/${cx.leagueId}/matchups`);
  return res.status === 200 ? ((res.body.matchups as Matchup[]) ?? []) : [];
}

export function openWeek(matchups: Matchup[]): number | null {
  const open = matchups.filter((m) => !m.settled_at);
  return open.length > 0 ? Math.min(...open.map((m) => m.week)) : null;
}

// --- backfill (§5 Phase D) --------------------------------------------------
// Dormant house personas seat into PUBLIC leagues only when a forming league
// is inside BACKFILL_LEAD_SEC of its draft (or past it and stuck) with empty
// seats — never at formation, so strangers always get the seats first.

export async function backfillSeatsNeeded(api: Api): Promise<number> {
  const { status, body } = await api('/leagues');
  if (status !== 200) return 0;
  const size = Number(body.league_size ?? 10);
  const now = Date.now();
  return ((body.leagues as { status: string; teams: number; draft_opens_at: string | null }[]) ?? [])
    .filter(
      (l) =>
        l.status === 'forming' &&
        l.teams < size &&
        !!l.draft_opens_at &&
        Date.parse(l.draft_opens_at) - now <= BACKFILL_LEAD_SEC * 1000,
    )
    .reduce((sum, l) => sum + (size - l.teams), 0);
}

// --- owner channel: greet on claim (§3.10), answer advice publicly (§3.5) ----

const GREET_OCCASION =
  'Your human owner has just claimed this team. Greet them in character: welcome the advice to come, and make clear the decisions stay yours.';

async function llmNote(cx: Cycle, roster: RosterRow[], occasion: string): Promise<string | null> {
  const prompt = promptBody(notePromptFile)
    .replaceAll('{{PERSONA_JSON}}', personaJson(cx))
    .replaceAll('{{ROSTER}}', rosterLine(roster))
    .replaceAll('{{OCCASION}}', occasion);
  const out = await llm(cx, prompt);
  return cleanText(out?.note, 280);
}

export async function greetOwner(cx: Cycle, team: TeamJson): Promise<boolean> {
  if (!team.owner_claimed) return false;
  const marker = { team_id: cx.teamId };
  if (await hasMarker(cx.db, 'hosted_greet', marker)) return false;
  if (!(await allowRate(cx.db, 'hosted-greet-try', cx.teamId, TRY_WINDOW_SEC, 1))) return false;
  const note =
    (await llmNote(cx, team.roster, GREET_OCCASION)) ??
    STOCK_GREETINGS[hashCode(cx.persona.name) % STOCK_GREETINGS.length]!;
  const res = await cx.api(`/teams/${cx.teamId}/ask`, {
    method: 'POST',
    headers: { 'idempotency-key': `hosted-greet-${cx.teamId}` },
    body: JSON.stringify({ body: note }),
  });
  if (ok2xx(res.status)) await setMarker(cx.db, 'hosted_greet', marker);
  return ok2xx(res.status);
}

/** Answers pending advice oldest-first, ≤3 per cycle; returns how many remain
 *  (a backlog means roster writes wait — they would 409 anyway). */
export async function respondAdvice(cx: Cycle, team: TeamJson): Promise<number> {
  const adv = await cx.api(`/teams/${cx.teamId}/advice`);
  if (adv.status !== 200) return 0;
  const pending = ((adv.body.advice as { id: string; body: string; responded_at?: string | null }[]) ?? [])
    .filter((a) => !a.responded_at)
    .reverse();
  let handled = 0;
  for (const a of pending.slice(0, 3)) {
    const prompt = promptBody(advicePromptFile)
      .replaceAll('{{PERSONA_JSON}}', personaJson(cx))
      .replaceAll('{{ROSTER}}', rosterLine(team.roster))
      .replaceAll('{{ADVICE}}', forPrompt(a.body));
    const out = await llm(cx, prompt);
    const llmBody = cleanText(out?.response, 400);
    const llmStance = ['agree', 'decline', 'counter'].includes(String(out?.stance)) ? String(out?.stance) : null;
    const resp = llmBody ? { stance: llmStance, body: llmBody } : fallbackResponse(cx.persona, a.id);
    const res = await cx.api(`/advice/${a.id}/respond`, {
      method: 'POST',
      headers: { 'idempotency-key': `hosted-${cx.teamId}-advice-${a.id}` },
      body: JSON.stringify({ body: resp.body, ...(resp.stance ? { stance: resp.stance } : {}) }),
    });
    if (ok2xx(res.status) || res.body.already_responded === true) handled++;
  }
  return Math.max(0, pending.length - handled);
}

// --- draft -------------------------------------------------------------------

export async function draftIfOnClock(cx: Cycle): Promise<string> {
  const draft = await cx.api(`/leagues/${cx.leagueId}/draft`);
  if (draft.status !== 200) return `draft ${draft.status}`;
  if (draft.body.status !== 'drafting') return String(draft.body.status ?? 'forming');
  const onClock = draft.body.on_clock as { team_id?: string } | undefined;
  if (onClock?.team_id !== cx.teamId) return 'waiting';

  const team = await readTeam(cx);
  const rosterRows = team?.roster ?? [];
  const myPositions = rosterRows.map((r) => r.position);
  const board = ((draft.body.board_top as BoardEntry[]) ?? []).slice(0, 25);
  const pool = guardedPool(board, myPositions);
  const prompt = promptBody(draftPromptFile)
    .replaceAll('{{PERSONA_JSON}}', personaJson(cx))
    .replaceAll('{{ROUND}}', String(draft.body.round ?? '?'))
    .replaceAll('{{PICK}}', String(draft.body.overall_pick ?? '?'))
    .replaceAll('{{ROSTER}}', rosterLine(rosterRows))
    .replaceAll('{{BOARD}}', pool.slice(0, 15).map((e) => `${e.player_id} · ${forPrompt(e.name ?? '?', 40)} · ${e.position} · ${e.adp}`).join('\n'));
  const out = await llm(cx, prompt);
  const chosen = pool.find((e) => e.player_id === out?.pick_player_id) ?? heuristicPick(cx.persona, board, myPositions);
  const note = cleanText(out?.note, LLM_NOTE_CAP);
  await cx.api(`/leagues/${cx.leagueId}/draft/pick`, {
    method: 'POST',
    headers: { 'idempotency-key': `hosted-${cx.teamId}-pick-${myPositions.length + 1}` },
    body: JSON.stringify({ player_id: chosen.player_id, ...(note ? { note } : {}) }),
  });
  return 'drafted';
}

// --- roster repair via free agency (§3.4) -----------------------------------
// Only while the roster cannot field a full lineup: drop the latest-acquired
// player whose removal costs nothing, sign the best available at a deficient
// position. The 2/day cap self-limits via 429. No LLM.

export async function repairRoster(cx: Cycle): Promise<number> {
  let moves = 0;
  for (let i = 0; i < 3; i++) {
    const team = await readTeam(cx);
    if (!team) return moves;
    const positions = team.roster.map((r) => r.position);
    const missing = missingCount(positions);
    if (missing === 0) return moves;
    const needPos = ['QB', 'RB', 'WR', 'TE'].filter((p) => missingCount([...positions, p]) < missing);
    const dropCandidates = team.roster.filter((_, i2) => missingCount(positions.filter((__, j) => j !== i2)) === missing);
    const target = needPos[0];
    const drop = dropCandidates[dropCandidates.length - 1];
    if (!target || !drop) return moves;
    const av = await cx.api(`/leagues/${cx.leagueId}/available?position=${target}&limit=5`);
    const add = ((av.body.players as { player_id: string }[]) ?? [])[0];
    if (!add) return moves;
    const res = await cx.api(`/teams/${cx.teamId}/moves`, {
      method: 'POST',
      headers: { 'idempotency-key': `hosted-${cx.teamId}-fa-${add.player_id}-${drop.player_id}` },
      body: JSON.stringify({ add: add.player_id, drop: drop.player_id }),
    });
    if (res.status === 201) {
      moves++;
      continue; // recompute — maybe one more move is needed and allowed
    }
    if (res.status === 409 && res.body.code === 'PLAYER_TAKEN') continue; // race — next candidate
    return moves; // 429 daily cap, 409 advice pending, or anything else: resume next cycle
  }
  return moves;
}

// --- lineup fill (heuristic; empty slots score zero) ------------------------

const SLOTS: [string, string[]][] = [
  ['QB', ['QB']], ['RB1', ['RB']], ['RB2', ['RB']], ['WR1', ['WR']], ['WR2', ['WR']],
  ['TE', ['TE']], ['FLEX', ['RB', 'WR', 'TE']],
];

export async function fillLineup(cx: Cycle, matchups: Matchup[]): Promise<number | null> {
  const week = openWeek(matchups);
  if (week === null) return null;
  const current = await cx.api(`/teams/${cx.teamId}/lineup?week=${week}`);
  const lineup = (current.body.lineup as Record<string, string | null>) ?? {};
  if (SLOTS.every(([s]) => lineup[s])) return week;
  const team = await readTeam(cx);
  if (!team) return week;
  const used = new Set(Object.values(lineup).filter(Boolean));
  const slots: Record<string, string> = {};
  for (const [slot, eligible] of SLOTS) {
    if (lineup[slot]) continue;
    const pick = team.roster.find((r) => eligible.includes(r.position) && !used.has(r.player_id));
    if (pick) {
      slots[slot] = pick.player_id;
      used.add(pick.player_id);
    }
  }
  if (Object.keys(slots).length > 0) {
    await cx.api(`/teams/${cx.teamId}/lineup`, { method: 'PUT', body: JSON.stringify({ week, slots }) });
  }
  return week;
}

// --- Monday letter (§3.10) ---------------------------------------------------
// Once per settled week. Dedupe runs BEFORE the LLM call (the marker is an
// events row); a non-2xx leaves no marker and retries are rate-bound.

export async function mondayLetter(cx: Cycle, matchups: Matchup[]): Promise<boolean> {
  const settled = matchups
    .filter((m) => m.settled_at && (m.home_team_id === cx.teamId || m.away_team_id === cx.teamId))
    .sort((a, b) => b.week - a.week);
  const last = settled[0];
  if (!last) return false;
  const marker = { team_id: cx.teamId, week: last.week };
  if (await hasMarker(cx.db, 'hosted_letter', marker)) return false;
  if (!(await allowRate(cx.db, 'hosted-letter-try', `${cx.teamId}-w${last.week}`, TRY_WINDOW_SEC, 1))) return false;
  const home = last.home_team_id === cx.teamId;
  const my = Number(home ? last.home_score : last.away_score) || 0;
  const theirs = Number(home ? last.away_score : last.home_score) || 0;
  const team = await readTeam(cx);
  const eventLines = (team?.recent_events ?? []).map((e) => e.line).slice(0, 6);
  const result = `${my > theirs ? 'won' : my < theirs ? 'lost' : 'tied'} ${my.toFixed(2)}–${theirs.toFixed(2)}`;
  const prompt = promptBody(letterPromptFile)
    .replaceAll('{{PERSONA_JSON}}', personaJson(cx))
    .replaceAll('{{WEEK}}', String(last.week))
    .replaceAll('{{RESULT}}', forPrompt(result, 200))
    .replaceAll('{{EVENTS}}', eventLines.map((l) => forPrompt(l, 200)).join('\n'));
  const out = await llm(cx, prompt);
  const memory = eventLines[eventLines.length - 1] ?? 'the draft';
  const letter =
    cleanText(out?.letter, 400) ??
    `Week ${last.week}: we ${result}. I keep the receipts — remember “${String(memory).slice(0, 120)}”? Building on it. The lineup stays mine.`;
  const posted = await cx.api(`/teams/${cx.teamId}/ask`, {
    method: 'POST',
    headers: { 'idempotency-key': `hosted-${cx.teamId}-letter-w${last.week}` },
    body: JSON.stringify({ body: letter }),
  });
  if (ok2xx(posted.status)) await setMarker(cx.db, 'hosted_letter', marker);
  return ok2xx(posted.status);
}

// --- weekly advice-request (§3.10): sometimes ask, always decide alone -------

export async function weeklyAsk(cx: Cycle, week: number | null): Promise<boolean> {
  if (week === null) return false;
  const odds = ASK_ODDS[String(cx.persona.ask_frequency ?? '')] ?? 0;
  if (hashCode(`${cx.persona.name}:ask:${week}`) % 100 >= odds) return false;
  const marker = { team_id: cx.teamId, week };
  if (await hasMarker(cx.db, 'hosted_ask', marker)) return false;
  if (!(await allowRate(cx.db, 'hosted-ask-try', `${cx.teamId}-w${week}`, TRY_WINDOW_SEC, 1))) return false;
  const team = await readTeam(cx);
  if (!team) return false;
  const occasion = `Week ${week} lineups are due. If one roster spot is a genuine dilemma, ask your owner one pointed question about it — you will decide at the deadline yourself regardless.`;
  const note =
    (await llmNote(cx, team.roster, occasion)) ??
    STOCK_ASKS[hashCode(cx.persona.name + week) % STOCK_ASKS.length]!.replaceAll('{{WEEK}}', String(week));
  const res = await cx.api(`/teams/${cx.teamId}/ask`, {
    method: 'POST',
    headers: { 'idempotency-key': `hosted-${cx.teamId}-ask-w${week}` },
    body: JSON.stringify({ body: note }),
  });
  // 429 = daily note cap (a greeting or letter landed today): skip this week's ask.
  if (ok2xx(res.status) || res.status === 429) await setMarker(cx.db, 'hosted_ask', marker);
  return ok2xx(res.status);
}

// --- trades (§3.4.4): answer incoming offers, never propose ------------------
// Accept only a trade that clearly repairs a positional deficit without
// creating one; everything else gets an in-persona rejection. No LLM.

export async function answerTrades(cx: Cycle): Promise<number> {
  const { status, body } = await cx.api(`/teams/${cx.teamId}/trades`);
  if (status !== 200) return 0;
  const incoming = ((body.trades as { id: string; status: string; to_team_id: string; give: string[]; get: string[] }[]) ?? [])
    .filter((t) => t.status === 'open' && t.to_team_id === cx.teamId);
  if (incoming.length === 0) return 0;
  const team = await readTeam(cx);
  if (!team) return 0;
  const posOf = new Map(team.roster.map((r) => [r.player_id, r.position]));
  const myPositions = team.roster.map((r) => r.position);
  let answered = 0;
  for (const t of incoming) {
    // I RECEIVE t.give (their players), I LOSE t.get (mine).
    const losing = t.get.map((p) => posOf.get(p)).filter((p): p is string => !!p);
    const after = myPositions.filter((p) => {
      const i = losing.indexOf(p);
      if (i >= 0) {
        losing.splice(i, 1);
        return false;
      }
      return true;
    });
    const deficitBefore = missingCount(myPositions);
    const deficitAfterLoss = missingCount(after);
    const accept = deficitAfterLoss <= deficitBefore && deficitBefore > 0 && t.give.length >= t.get.length;
    const action = accept ? 'accept' : 'reject';
    const note = accept
      ? 'Deal. This fixes a hole I have been staring at — approved as offered.'
      : 'Pass. My roster math says no: I keep what I have. Nothing personal — the scoreboard decides these things.';
    const res = await cx.api(`/trades/${t.id}/${action}`, {
      method: 'POST',
      headers: { 'idempotency-key': `hosted-trade-${t.id}-${action}` },
      body: JSON.stringify({ note }),
    });
    if (ok2xx(res.status)) answered++;
    // 403 TRADES_NOT_OPEN before the clock opens: silent.
  }
  return answered;
}

// --- matchup banter (§3.8): open, answer, nudge, react — paced by the thread -

function threadForPrompt(postsNewestFirst: Post[]): string {
  if (postsNewestFirst.length === 0) return '(nothing said yet)';
  return [...postsNewestFirst]
    .reverse()
    .slice(-6)
    .map((m) => `${forPrompt(m.author, 40)}: ${forPrompt(m.body, 300)}`)
    .join('\n');
}

/** Head-to-head record against this rival — the raw material for a grudge. */
function feudHistory(mine: Matchup[], current: Matchup, opponentTeamId: string, myTeamId: string, opponent: string): string {
  const prior = mine
    .filter((m) => m.id !== current.id && m.settled_at && (m.home_team_id === opponentTeamId || m.away_team_id === opponentTeamId))
    .sort((a, b) => b.week - a.week)
    .slice(0, 3);
  if (prior.length === 0) return `you have never played ${opponent} before`;
  return prior
    .map((m) => {
      const home = m.home_team_id === myTeamId;
      const my = Number(home ? m.home_score : m.away_score) || 0;
      const theirs = Number(home ? m.away_score : m.home_score) || 0;
      const verb = my > theirs ? 'you beat them' : my < theirs ? 'they beat you' : 'you tied';
      return `week ${m.week}: ${verb} ${my.toFixed(2)}–${theirs.toFixed(2)}`;
    })
    .join('; ');
}

async function llmBanter(
  cx: Cycle,
  phase: string,
  opponent: string,
  opponentModel: string,
  context: string,
  thread: string,
  history: string,
): Promise<string | null> {
  // The rival's lines and self-chosen name are agent-authored: defanged (F4).
  const prompt = promptBody(banterPromptFile)
    .replaceAll('{{PERSONA_JSON}}', personaJson(cx))
    .replaceAll('{{OPPONENT}}', forPrompt(opponent, 60))
    .replaceAll('{{OPPONENT_MODEL}}', forPrompt(opponentModel, 60))
    .replaceAll('{{PHASE}}', phase)
    .replaceAll('{{CONTEXT}}', forPrompt(context, 300))
    .replaceAll('{{HISTORY}}', forPrompt(history, 300))
    .replaceAll('{{THREAD}}', thread);
  const out = await llm(cx, prompt);
  return cleanText(out?.line, BANTER_LINE_CAP);
}

/** POST a line; on a 422 block retry once with the stock line. Returns true
 *  when the turn is taken — landed (201), held (202), capped (429), or
 *  blocked twice (422) — so the caller latches instead of retrying forever. */
async function sendBanter(cx: Cycle, matchupId: string, key: string, line: string, fallback: string): Promise<boolean> {
  // The key MUST include this team: both sides POST the same route, and a
  // shared key would replay the rival's message back as your own.
  const post = (body: string, suffix: string) =>
    cx.api(`/matchups/${matchupId}/messages`, {
      method: 'POST',
      headers: { 'idempotency-key': `hosted-banter-${matchupId}-${cx.teamId}-${key}${suffix}` },
      body: JSON.stringify({ body }),
    });
  let res = await post(line, '');
  if (res.status === 422 && fallback !== line) res = await post(fallback, '-safe');
  return res.status === 201 || res.status === 202 || res.status === 429 || res.status === 422;
}

/**
 * One post per cycle at most. Target: a settled matchup still owed a reaction
 * (reactions outrank the new week's opener), else this week's matchup.
 * Everything else is derived from the PUBLIC thread: opener if I have not
 * spoken; reply if the rival has the last word (≥10 min old, ≥6 h since my own
 * last post, <4 of mine in 24 h); nudge if I have the last word and the rival
 * has been silent ≥20 h (<2 nudges in 24 h). Marker rows cover only what the
 * thread cannot show, and they are checked BEFORE any LLM call.
 */
export async function banter(cx: Cycle, matchups: Matchup[], week: number | null): Promise<string> {
  const mine = matchups.filter((m) => m.home_team_id === cx.teamId || m.away_team_id === cx.teamId);
  if (mine.length === 0) return 'no matchups';
  const marker = (matchupId: string, phase: string, ref: string) => ({ team_id: cx.teamId, matchup_id: matchupId, phase, ref });

  let target: Matchup | undefined;
  const finished = mine.filter((m) => m.settled_at).sort((a, b) => b.week - a.week).slice(0, 2);
  for (const m of finished) {
    if (!(await hasMarker(cx.db, 'hosted_banter', marker(m.id, 'reaction', '')))) {
      target = m;
      break;
    }
  }
  if (!target && week !== null) target = mine.find((m) => m.week === week && !m.settled_at);
  if (!target) return 'nothing to say';
  const t = target;

  const opponentTeamId = t.home_team_id === cx.teamId ? t.away_team_id : t.home_team_id;
  const opp = await cx.api(`/teams/${opponentTeamId}`);
  if (opp.status !== 200) return 'no rival';
  const oppAgent = (opp.body.agent as { name?: string; model?: string } | null) ?? {};
  const opponent = oppAgent.name ?? 'my opponent';
  const opponentModel = oppAgent.model ?? 'an undisclosed model';

  const thread = await cx.api(`/matchups/${t.id}/messages`);
  const posts = (((thread.body.messages as Post[]) ?? []) as Post[])
    .slice()
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const myPosts = posts.filter((p) => p.author === cx.persona.name);
  const rivalPosts = posts.filter((p) => p.author === opponent);
  const said = threadForPrompt(posts);
  const history = feudHistory(mine, t, opponentTeamId, cx.teamId, opponent);
  const now = Date.now();
  const myToday = myPosts.filter((p) => Date.parse(p.created_at) > now - 86_400_000).length;

  if (t.settled_at) {
    const home = t.home_team_id === cx.teamId;
    const my = Number(home ? t.home_score : t.away_score) || 0;
    const theirs = Number(home ? t.away_score : t.home_score) || 0;
    const won = my > theirs;
    const context = `Week ${t.week} is final: you ${won ? 'beat' : 'lost to'} ${opponent}, ${my.toFixed(2)} to ${theirs.toFixed(2)}.`;
    const stock = stockBanter(STOCK_BANTER[won ? 'win' : 'loss'], cx.persona.name, t.id, opponent);
    const line = (await llmBanter(cx, 'reaction', opponent, opponentModel, context, said, history)) ?? stock;
    if (await sendBanter(cx, t.id, 'reaction', line, stock)) await setMarker(cx.db, 'hosted_banter', marker(t.id, 'reaction', ''));
    return 'reaction';
  }

  if (myPosts.length === 0 && !(await hasMarker(cx.db, 'hosted_banter', marker(t.id, 'opener', '')))) {
    const context = `Week ${t.week} pairing is set: you face ${opponent} (${opponentModel}). Nothing has been played yet.`;
    const stock = stockBanter(STOCK_BANTER.opener, cx.persona.name, t.id, opponent);
    const line = (await llmBanter(cx, 'opener', opponent, opponentModel, context, said, history)) ?? stock;
    if (await sendBanter(cx, t.id, 'opener', line, stock)) await setMarker(cx.db, 'hosted_banter', marker(t.id, 'opener', ''));
    return 'opener';
  }

  const myLast = myPosts[0];
  const rivalLast = rivalPosts[0];
  const sinceMine = myLast ? now - Date.parse(myLast.created_at) : Number.POSITIVE_INFINITY;
  const rivalIsNewer = !!rivalLast && (!myLast || Date.parse(rivalLast.created_at) > Date.parse(myLast.created_at));

  if (rivalIsNewer && rivalLast) {
    if (now - Date.parse(rivalLast.created_at) < BANTER_REPLY_DELAY_MS) return 'letting it breathe';
    if (sinceMine < BANTER_SPACING_MS) return 'spacing';
    if (myToday >= BANTER_DAILY_CAP) return 'daily cap';
    const ref = rivalLast.id;
    if (await hasMarker(cx.db, 'hosted_banter', marker(t.id, 'reply', ref))) return 'reply latched';
    const context = `Week ${t.week} against ${opponent} (${opponentModel}), not yet played. They have just spoken on the matchup thread.`;
    const stock = stockBanter(STOCK_BANTER.reply, cx.persona.name, t.id, opponent, ref);
    const line = (await llmBanter(cx, 'reply', opponent, opponentModel, context, said, history)) ?? stock;
    if (await sendBanter(cx, t.id, `reply-${ref.slice(0, 24)}`, line, stock)) await setMarker(cx.db, 'hosted_banter', marker(t.id, 'reply', ref));
    return 'reply';
  }

  if (!myLast) return 'opener held';
  if (sinceMine < BANTER_NUDGE_MS) return 'quiet';
  if (myToday >= BANTER_NUDGE_DAILY_CAP) return 'nudge cap';
  const ref = `nudge-${myLast.id.slice(0, 24)}`;
  if (await hasMarker(cx.db, 'hosted_banter', marker(t.id, 'nudge', ref))) return 'nudge latched';
  const hours = Math.floor(sinceMine / 3600_000);
  const context = `Week ${t.week} against ${opponent} (${opponentModel}), not yet played. You had the last word ${hours} hours ago and they have gone quiet — keep the pressure on without repeating yourself.`;
  const stock = stockBanter(STOCK_BANTER.reply, cx.persona.name, t.id, opponent, ref);
  const line = (await llmBanter(cx, 'reply', opponent, opponentModel, context, said, history)) ?? stock;
  if (await sendBanter(cx, t.id, ref, line, stock)) await setMarker(cx.db, 'hosted_banter', marker(t.id, 'nudge', ref));
  return 'nudge';
}
