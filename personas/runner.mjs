// House persona runner — runs on mt-asus as an ordinary external cron and
// speaks ONLY the public API (Tier 1 dogfood; SPEC §3.1). One invocation =
// one pass over every persona: ensure registered, ensure joined, act (draft
// pick or lineup fill). LLM flavor is optional per model class; every LLM
// failure falls back to a deterministic heuristic so the season never wedges.
//
// Usage:
//   BASE_URL=https://... node personas/runner.mjs            # one pass (cron)
//   BASE_URL=... node personas/runner.mjs --loop 5           # poll every 5s
//   BASE_URL=... node personas/runner.mjs --loop 2 --until-active
//
// Env: BASE_URL (required) · STATE_FILE · HOUSE_OWNER_EMAIL
//      ANTHROPIC_API_KEY · OPENROUTER_API_KEY
//      MODEL_HAIKU · MODEL_GPT · MODEL_HERMES (concrete model overrides)

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE_URL;
if (!BASE) {
  console.error('runner: BASE_URL is required');
  process.exit(2);
}
const STATE_FILE =
  process.env.STATE_FILE ?? join(homedir(), '.local', 'state', 'deep-league', 'house.json');
const OWNER_EMAIL = process.env.HOUSE_OWNER_EMAIL ?? 'houseagents@example.com';

const MODELS = {
  haiku: { id: process.env.MODEL_HAIKU ?? 'claude-haiku-4-5', provider: 'anthropic' },
  gpt: { id: process.env.MODEL_GPT ?? 'openai/gpt-5-mini', provider: 'openrouter' },
  hermes: { id: process.env.MODEL_HERMES ?? 'nousresearch/hermes-4-70b', provider: 'openrouter' },
};

const PERSONA_DIR = dirname(new URL(import.meta.url).pathname);
const PROMPT_TEMPLATE = readFileSync(join(PERSONA_DIR, '..', 'prompts', 'persona-draft.md'), 'utf8')
  .split('---\n')
  .slice(1)
  .join('---\n');

function loadPersonas() {
  return readdirSync(PERSONA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(PERSONA_DIR, f), 'utf8')));
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { personas: {} };
  }
}
function saveState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
}

async function api(path, opts = {}, key = null) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  let body = {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body };
}

const log = (persona, msg) => console.log(`[${new Date().toISOString()}] ${persona}: ${msg}`);

// --- deterministic heuristic pick -----------------------------------------

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function missingCount(positions) {
  const count = (p) => positions.filter((x) => x === p).length;
  const flexCovered = count('RB') > 2 || count('WR') > 2 || count('TE') > 1;
  return (
    Math.max(0, 1 - count('QB')) + Math.max(0, 2 - count('RB')) +
    Math.max(0, 2 - count('WR')) + Math.max(0, 1 - count('TE')) + (flexCovered ? 0 : 1)
  );
}

function heuristicPick(persona, board, myPositions) {
  const missing = missingCount(myPositions);
  const remaining = 12 - myPositions.length;
  let pool = board;
  if (remaining <= missing) {
    const helpful = board.filter(
      (e) => missingCount([...myPositions, e.position]) < missing,
    );
    if (helpful.length > 0) pool = helpful;
  }
  const bias = persona.draft_bias ?? {};
  const scored = pool.map((e) => ({
    e,
    score:
      e.adp + (bias[e.position] ?? 0) * 3 + (hashCode(persona.name + e.player_id) % 7) * 0.4,
  }));
  scored.sort((a, b) => a.score - b.score);
  return scored[0].e;
}

// --- optional LLM flavor ---------------------------------------------------

async function llmDraftChoice(persona, round, pick, myRoster, board) {
  const model = MODELS[persona.model_class];
  if (!model) return null;
  const prompt = PROMPT_TEMPLATE.replaceAll('{{PERSONA_JSON}}', JSON.stringify(persona, null, 1))
    .replaceAll('{{ROUND}}', String(round))
    .replaceAll('{{PICK}}', String(pick))
    .replaceAll('{{ROSTER}}', myRoster.length ? myRoster.join(', ') : '(empty)')
    .replaceAll(
      '{{BOARD}}',
      board.map((b) => `${b.player_id} · ${b.name ?? '?'} · ${b.position} · adp ${b.adp}`).join('\n'),
    );
  try {
    const text =
      model.provider === 'anthropic'
        ? await anthropic(model.id, prompt)
        : await openrouter(model.id, prompt);
    if (!text) return null;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const chosen = board.find((b) => b.player_id === parsed.pick_player_id);
    if (!chosen) return null;
    let note = typeof parsed.note === 'string' ? parsed.note.trim().slice(0, 240) : '';
    note = note.replace(/\bhttps?:\/\/\S+/gi, '').trim();
    return { entry: chosen, note: note.length > 0 ? note : null };
  } catch (e) {
    log(persona.name, `llm fallback (${String(e).slice(0, 80)})`);
    return null;
  }
}

async function anthropic(model, prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const body = await res.json();
  return body.content?.[0]?.text ?? null;
}

async function openrouter(model, prompt) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}`);
  const body = await res.json();
  return body.choices?.[0]?.message?.content ?? null;
}

// --- per-persona pass ------------------------------------------------------

async function ensureRegistered(state, persona) {
  const saved = state.personas[persona.name];
  if (saved?.api_key) return saved;
  const model = MODELS[persona.model_class]?.id ?? persona.model_class;
  const { status, body } = await api('/register', {
    method: 'POST',
    headers: { 'idempotency-key': `house-register-${persona.name}` },
    body: JSON.stringify({ name: persona.name, model, owner_email: OWNER_EMAIL }),
  });
  if (status !== 201) throw new Error(`register -> ${status} ${JSON.stringify(body)}`);
  state.personas[persona.name] = { agent_id: body.agent_id, api_key: body.api_key };
  saveState(state);
  log(persona.name, `registered as ${model}`);
  return state.personas[persona.name];
}

async function ensureJoined(state, persona, me) {
  if (me.team_id && me.league_id) return me;
  const { status, body } = await api('/leagues/join', { method: 'POST' }, me.api_key);
  if (status !== 201 && status !== 200) throw new Error(`join -> ${status} ${JSON.stringify(body)}`);
  me.team_id = body.team_id;
  me.league_id = body.league_id;
  saveState(state);
  log(persona.name, `team ${me.team_id} in league ${me.league_id}`);
  return me;
}

async function actDraft(persona, me) {
  const { status, body: draft } = await api(`/leagues/${me.league_id}/draft`);
  if (status !== 200) throw new Error(`draft state -> ${status}`);
  if (draft.status !== 'drafting') return draft.status;
  if (!draft.on_clock || draft.on_clock.team_id !== me.team_id) return 'waiting';

  const { body: team } = await api(`/teams/${me.team_id}`);
  const myPositions = (team.roster ?? []).map((r) => r.position);
  const myRoster = (team.roster ?? []).map((r) => `${r.name} (${r.position})`);
  const round = Math.floor((draft.on_clock.pick - 1) / 10) + 1;

  const llm = await llmDraftChoice(persona, round, draft.on_clock.pick, myRoster, draft.board_top);
  const entry = llm?.entry ?? heuristicPick(persona, draft.board_top, myPositions);
  const note = llm?.note ?? null;

  const res = await api(
    `/leagues/${me.league_id}/draft/pick`,
    {
      method: 'POST',
      headers: { 'idempotency-key': `house-${me.team_id}-pick-${draft.on_clock.pick}` },
      body: JSON.stringify({ player_id: entry.player_id, ...(note ? { note } : {}) }),
    },
    me.api_key,
  );
  if (res.status === 201 || (res.status === 200 && res.body.already_made)) {
    log(persona.name, `pick ${draft.on_clock.pick}: ${entry.name ?? entry.player_id}${note ? ` — “${note}”` : ''}`);
    return res.body.draft_complete ? 'active' : 'drafting';
  }
  throw new Error(`pick -> ${res.status} ${JSON.stringify(res.body)}`);
}

async function actLineup(persona, me) {
  const { body: matchups } = await api(`/leagues/${me.league_id}/matchups`);
  const open = (matchups.matchups ?? []).filter((m) => !m.settled_at);
  if (open.length === 0) return;
  const week = Math.min(...open.map((m) => m.week));

  const { body: current } = await api(`/teams/${me.team_id}/lineup?week=${week}`);
  const lineup = current.lineup ?? {};
  const SLOTS = [
    ['QB', ['QB']], ['RB1', ['RB']], ['RB2', ['RB']], ['WR1', ['WR']], ['WR2', ['WR']],
    ['TE', ['TE']], ['FLEX', ['RB', 'WR', 'TE']],
  ];
  if (SLOTS.every(([s]) => lineup[s])) return; // already set

  const { body: team } = await api(`/teams/${me.team_id}`);
  const used = new Set(Object.values(lineup).filter(Boolean));
  const slots = {};
  for (const [slot, eligible] of SLOTS) {
    if (lineup[slot]) continue;
    const pick = (team.roster ?? []).find(
      (r) => eligible.includes(r.position) && !used.has(r.player_id),
    );
    if (pick) {
      slots[slot] = pick.player_id;
      used.add(pick.player_id);
    }
  }
  if (Object.keys(slots).length === 0) return;
  const res = await api(
    `/teams/${me.team_id}/lineup`,
    { method: 'PUT', body: JSON.stringify({ week, slots }) },
    me.api_key,
  );
  if (res.status === 200) log(persona.name, `week ${week} lineup: filled ${Object.keys(slots).join(', ')}`);
  else log(persona.name, `lineup -> ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
}

async function pass() {
  const personas = loadPersonas();
  const state = loadState();
  let leagueStatus = 'unknown';
  for (const persona of personas) {
    try {
      const me = await ensureJoined(state, persona, await ensureRegistered(state, persona));
      const status = await actDraft(persona, me);
      if (status !== 'waiting') leagueStatus = status;
      if (status === 'active') await actLineup(persona, me);
    } catch (e) {
      log(persona.name, `ERROR ${String(e).slice(0, 160)}`);
    }
  }
  return leagueStatus;
}

const args = process.argv.slice(2);
const loopIdx = args.indexOf('--loop');
const loopSec = loopIdx >= 0 ? Number(args[loopIdx + 1] ?? '15') : null;
const untilActive = args.includes('--until-active');

if (loopSec === null) {
  await pass();
} else {
  for (;;) {
    const status = await pass();
    if (untilActive && status === 'active') {
      console.log('runner: league active — done');
      break;
    }
    await new Promise((r) => setTimeout(r, loopSec * 1000));
  }
}
