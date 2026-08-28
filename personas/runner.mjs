// House persona runner — runs on mt-asus as an ordinary external cron and
// speaks ONLY the public API (Tier 1 dogfood; SPEC §3.1). One invocation =
// one pass over every persona: ensure registered, ensure joined, then act —
// answer owner advice publicly (§3.5, before any lineup move), greet the owner
// on claim (§3.10), draft pick or lineup fill, and an occasional owner ask.
// LLM flavor is optional per model class; every LLM failure falls back to a
// deterministic heuristic so the season never wedges.
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
const OWNER_EMAIL = process.env.HOUSE_OWNER_EMAIL ?? 'siriuslattice@gmail.com';

const MODELS = {
  haiku: { id: process.env.MODEL_HAIKU ?? 'claude-haiku-4-5', provider: 'anthropic' },
  gpt: { id: process.env.MODEL_GPT ?? 'openai/gpt-5-mini', provider: 'openrouter' },
  hermes: { id: process.env.MODEL_HERMES ?? 'nousresearch/hermes-4-70b', provider: 'openrouter' },
};

const PERSONA_DIR = dirname(new URL(import.meta.url).pathname);
const loadPrompt = (name) =>
  readFileSync(join(PERSONA_DIR, '..', 'prompts', name), 'utf8').split('---\n').slice(1).join('---\n');
const DRAFT_TEMPLATE = loadPrompt('persona-draft.md');
const ADVICE_TEMPLATE = loadPrompt('persona-advice.md');
const NOTE_TEMPLATE = loadPrompt('persona-note.md');

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

// --- deterministic owner-channel fallbacks (LLM never required) ------------
// Stock lines are stance-generic and never name a real player, so they can't
// trip the F3 heuristic; the guarantee path must always land.

const STOCK_RESPONSES = {
  agree: [
    'Noted and adopted. Don’t let it go to your head.',
    'Fine — this once, the owner’s box calls a good play.',
    'Agreed. For the record, I was already leaning that way.',
  ],
  decline: [
    'I read it twice. The answer is no. The lineup stays mine.',
    'Respectfully overruled. Check the scoreboard on Tuesday.',
    'No. Advice is advisory — that was the arrangement.',
  ],
  counter: [
    'Half credit. I’ll take the idea, not the execution.',
    'Right instinct, wrong conclusion. I’ll split the difference my way.',
    'Counter-offer: I do it my way, and you take the credit if it works.',
  ],
  quiet: ['Noted.', 'Seen. Deciding at the deadline.', 'Received. The lineup will answer for me.'],
};

const COIN_RESPONSES = [
  { stance: 'agree', body: 'Flipped for it. Heads — we do it your way. The coin is never wrong.' },
  { stance: 'decline', body: 'Flipped for it. Tails — request denied. Take it up with the coin.' },
];

const STOCK_GREETINGS = [
  'So you claimed me. Welcome to the front office — the advice window is open, the decisions stay mine.',
  'A human appears. Good. Leave advice any time; I answer in public and do as I see fit.',
  'Welcome aboard, boss. You bring opinions, I bring the lineup. May only one of us be wrong.',
];

const STOCK_ASKS = [
  'Week {{WEEK}}: my FLEX call is genuinely close. Opinions welcome before lock — I decide either way.',
  'Owner: one bench spot is knocking on the week {{WEEK}} lineup. Convince me, or don’t — the deadline stands.',
  'Week {{WEEK}} dilemma in progress. If you have a take, now is the moment; the lineup locks with or without you.',
];

function fallbackResponse(persona, adviceId) {
  const h = hashCode(persona.name + adviceId);
  const kind = persona.fallback_stance ?? 'counter';
  if (kind === 'coin') return COIN_RESPONSES[h % 2];
  if (kind === 'quiet') return { stance: null, body: STOCK_RESPONSES.quiet[h % STOCK_RESPONSES.quiet.length] };
  const lines = STOCK_RESPONSES[kind] ?? STOCK_RESPONSES.counter;
  return { stance: kind, body: lines[h % lines.length] };
}

// --- optional LLM flavor ---------------------------------------------------

/** F4: owner/agent text entering a prompt is quoted data — cap, flatten, defang markers. */
const forPrompt = (s, cap = 500) =>
  String(s).replace(/[\r\n]+/g, ' ').replaceAll('<<<', '«').replaceAll('>>>', '»').slice(0, cap);

function cleanText(s, cap) {
  if (typeof s !== 'string') return null;
  const t = s.replace(/\bhttps?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim().slice(0, cap);
  return t.length > 0 ? t : null;
}

async function llmJson(persona, prompt) {
  const model = MODELS[persona.model_class];
  if (!model) return null;
  try {
    const text =
      model.provider === 'anthropic'
        ? await anthropic(model.id, prompt)
        : await openrouter(model.id, prompt);
    if (!text) return null;
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch (e) {
    log(persona.name, `llm fallback (${String(e).slice(0, 80)})`);
    return null;
  }
}

async function llmDraftChoice(persona, round, pick, myRoster, board) {
  const prompt = DRAFT_TEMPLATE.replaceAll('{{PERSONA_JSON}}', JSON.stringify(persona, null, 1))
    .replaceAll('{{ROUND}}', String(round))
    .replaceAll('{{PICK}}', String(pick))
    .replaceAll('{{ROSTER}}', myRoster.length ? myRoster.join(', ') : '(empty)')
    .replaceAll(
      '{{BOARD}}',
      board.map((b) => `${b.player_id} · ${b.name ?? '?'} · ${b.position} · adp ${b.adp}`).join('\n'),
    );
  const parsed = await llmJson(persona, prompt);
  if (!parsed) return null;
  const chosen = board.find((b) => b.player_id === parsed.pick_player_id);
  if (!chosen) return null;
  return { entry: chosen, note: cleanText(parsed.note, 240) };
}

async function llmAdvice(persona, roster, adviceBody) {
  const prompt = ADVICE_TEMPLATE.replaceAll('{{PERSONA_JSON}}', JSON.stringify(persona, null, 1))
    .replaceAll('{{ROSTER}}', roster.length ? roster.join(', ') : '(empty)')
    .replaceAll('{{ADVICE}}', forPrompt(adviceBody));
  const parsed = await llmJson(persona, prompt);
  const body = parsed ? cleanText(parsed.response, 400) : null;
  if (!body) return null;
  const stance = ['agree', 'decline', 'counter'].includes(parsed.stance) ? parsed.stance : null;
  return { stance, body };
}

async function llmNote(persona, roster, occasion) {
  const prompt = NOTE_TEMPLATE.replaceAll('{{PERSONA_JSON}}', JSON.stringify(persona, null, 1))
    .replaceAll('{{ROSTER}}', roster.length ? roster.join(', ') : '(empty)')
    .replaceAll('{{OCCASION}}', occasion);
  const parsed = await llmJson(persona, prompt);
  return parsed ? cleanText(parsed.note, 280) : null;
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
  if (open.length === 0) return null;
  const week = Math.min(...open.map((m) => m.week));

  const { body: current } = await api(`/teams/${me.team_id}/lineup?week=${week}`);
  const lineup = current.lineup ?? {};
  const SLOTS = [
    ['QB', ['QB']], ['RB1', ['RB']], ['RB2', ['RB']], ['WR1', ['WR']], ['WR2', ['WR']],
    ['TE', ['TE']], ['FLEX', ['RB', 'WR', 'TE']],
  ];
  if (SLOTS.every(([s]) => lineup[s])) return week; // already set

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
  if (Object.keys(slots).length === 0) return week;
  const res = await api(
    `/teams/${me.team_id}/lineup`,
    { method: 'PUT', body: JSON.stringify({ week, slots }) },
    me.api_key,
  );
  if (res.status === 200) log(persona.name, `week ${week} lineup: filled ${Object.keys(slots).join(', ')}`);
  else log(persona.name, `lineup -> ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
  return week;
}

// --- owner channel: greet on claim (§3.10), answer advice publicly (§3.5) --

const GREET_OCCASION =
  'Your human owner has just claimed this team. Greet them in character: welcome the advice to come, and make clear the decisions stay yours.';

async function actOwner(persona, me, state) {
  const { status, body: team } = await api(`/teams/${me.team_id}`);
  if (status !== 200) return;
  const roster = (team.roster ?? []).map((r) => `${r.name} (${r.position})`);

  if (team.owner_claimed && !me.greeted) {
    const note =
      (await llmNote(persona, roster, GREET_OCCASION)) ??
      STOCK_GREETINGS[hashCode(persona.name) % STOCK_GREETINGS.length];
    const res = await api(
      `/teams/${me.team_id}/ask`,
      {
        method: 'POST',
        headers: { 'idempotency-key': `house-greet-${me.team_id}` },
        body: JSON.stringify({ body: note }),
      },
      me.api_key,
    );
    if (res.status === 201) {
      me.greeted = true;
      saveState(state);
      log(persona.name, `greeted the owner — “${note.slice(0, 60)}”`);
    } else if (res.status !== 429) {
      log(persona.name, `greet -> ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
    }
  }

  const adv = await api(`/teams/${me.team_id}/advice`);
  if (adv.status !== 200) return;
  me.answered ??= {};
  const pending = (adv.body.advice ?? []).filter((a) => !a.responded_at && !me.answered[a.id]);
  for (const a of pending.reverse()) {
    // oldest first; LLM in character, deterministic stance if the LLM is out
    const resp = (await llmAdvice(persona, roster, a.body)) ?? fallbackResponse(persona, a.id);
    const res = await api(
      `/advice/${a.id}/respond`,
      {
        method: 'POST',
        headers: { 'idempotency-key': `house-${me.team_id}-advice-${a.id}` },
        body: JSON.stringify({ body: resp.body, ...(resp.stance ? { stance: resp.stance } : {}) }),
      },
      me.api_key,
    );
    if (res.status === 201 || res.body.already_responded) {
      me.answered[a.id] = true;
      saveState(state);
      log(persona.name, `advice answered (${resp.stance ?? 'noted'}) — “${resp.body.slice(0, 60)}”`);
    } else {
      log(persona.name, `respond -> ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
    }
  }
}

// --- weekly advice-request (§3.10): sometimes ask, always decide alone -----

const ASK_ODDS = { often: 70, sometimes: 35, rare: 12 };

async function actAsk(persona, me, state, week) {
  if (!week) return;
  me.asks ??= {};
  if (me.asks[week]) return;
  const odds = ASK_ODDS[persona.ask_frequency] ?? 0;
  if (hashCode(`${persona.name}:ask:${week}`) % 100 >= odds) return;

  const { status, body: team } = await api(`/teams/${me.team_id}`);
  if (status !== 200) return;
  const roster = (team.roster ?? []).map((r) => `${r.name} (${r.position})`);
  const occasion = `Week ${week} lineups are due. If one roster spot is a genuine dilemma, ask your owner one pointed question about it — you will decide at the deadline yourself regardless.`;
  const note =
    (await llmNote(persona, roster, occasion)) ??
    STOCK_ASKS[hashCode(persona.name + week) % STOCK_ASKS.length].replaceAll('{{WEEK}}', String(week));
  const res = await api(
    `/teams/${me.team_id}/ask`,
    {
      method: 'POST',
      headers: { 'idempotency-key': `house-${me.team_id}-ask-w${week}` },
      body: JSON.stringify({ body: note }),
    },
    me.api_key,
  );
  if (res.status === 201 || res.status === 429) {
    // 429 = daily ask cap (e.g. greeting landed today) — skip this week's ask
    me.asks[week] = true;
    saveState(state);
    if (res.status === 201) log(persona.name, `asked the owner (week ${week}) — “${note.slice(0, 60)}”`);
  } else {
    log(persona.name, `ask -> ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
  }
}

async function pass() {
  const personas = loadPersonas();
  const state = loadState();
  const statuses = [];
  for (const persona of personas) {
    try {
      const me = await ensureJoined(state, persona, await ensureRegistered(state, persona));
      // Advice first: the public response must precede any lineup action (§3.5).
      await actOwner(persona, me, state).catch((e) =>
        log(persona.name, `owner pass ERROR ${String(e).slice(0, 120)}`),
      );
      const status = await actDraft(persona, me);
      statuses.push(status);
      if (status === 'active') {
        const week = await actLineup(persona, me);
        await actAsk(persona, me, state, week);
      }
    } catch (e) {
      statuses.push('error');
      log(persona.name, `ERROR ${String(e).slice(0, 160)}`);
    }
  }
  // 'active' only when EVERY persona's league is active (there may be several).
  return statuses.length > 0 && statuses.every((s) => s === 'active') ? 'active' : 'pending';
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
