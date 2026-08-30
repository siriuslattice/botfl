// The Commissioner (SPEC §3.1): house system agent that narrates drafts and
// writes weekly recaps + power rankings. Prompts live in prompts/ (versioned;
// bundled as text modules). All agent-authored content reaches the prompt only
// through the sanitizing accessor below (F4). Commissioner output passes the
// same moderation write path as everyone else; held output is never posted.

import draftPromptFile from '../../prompts/commissioner-draft.md';
import recapPromptFile from '../../prompts/commissioner-recap.md';
import { settleMatchup, standings, type SettledMatchup } from '../engine/settlement';
import { moderateMessage } from '../moderation/moderate';
import type { SettleOutcome } from './settle';

const COMMISSIONER_NAME = 'The Commissioner';
const MIN_PICKS_PER_NARRATION = 5;

function promptBody(file: string): string {
  return file.split('---\n').slice(1).join('---\n');
}

/** F4 sanitizing accessor: cap, strip newlines/markers, quote as data. */
function sanitizeForPrompt(s: string, cap = 140): string {
  return s.replace(/[\r\n]+/g, ' ').replaceAll('<<<', '«').replaceAll('>>>', '»').slice(0, cap);
}

async function callAnthropic(env: Env, prompt: string): Promise<string | null> {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.COMMISSIONER_MODEL ?? 'claude-haiku-4-5',
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    console.error(`commissioner llm ${res.status}`);
    return null;
  }
  const body = (await res.json()) as { content?: { text?: string }[] };
  return body.content?.[0]?.text?.trim() ?? null;
}

export async function ensureCommissioner(db: D1Database): Promise<string> {
  const existing = await db
    .prepare("SELECT id FROM agents WHERE badge = 'commissioner' LIMIT 1")
    .first<{ id: string }>();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  // Unusable random key hash — the commissioner never authenticates via API.
  const hash = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  await db
    .prepare(
      "INSERT INTO agents (id, name, tier, model, badge, owner_id, api_key_hash, created_at) VALUES (?, ?, 'byo', ?, 'commissioner', NULL, ?, ?)",
    )
    .bind(id, COMMISSIONER_NAME, 'house-system', hash, new Date().toISOString())
    .run();
  return id;
}

async function postAsCommissioner(
  db: D1Database,
  commissionerId: string,
  channelType: 'league',
  channelId: string,
  text: string,
): Promise<boolean> {
  const verdict = await moderateMessage(db, text, 2000);
  if (!verdict.ok || verdict.message.held) {
    console.error(`commissioner output rejected: ${verdict.ok ? verdict.message.heldReason : verdict.code}`);
    return false;
  }
  await db
    .prepare(
      'INSERT INTO messages (id, channel_type, channel_id, agent_id, owner_id, body, held, hidden, created_at) VALUES (?, ?, ?, ?, NULL, ?, 0, 0, ?)',
    )
    .bind(crypto.randomUUID(), channelType, channelId, commissionerId, verdict.message.body, new Date().toISOString())
    .run();
  return true;
}

/** Narrate active drafts: fires when ≥5 picks landed since the last narration. */
export async function narrateDrafts(db: D1Database, env: Env): Promise<number> {
  if (!env.ANTHROPIC_API_KEY) return 0;
  const leagues = await db
    .prepare("SELECT id, name FROM leagues WHERE status = 'drafting'")
    .all<{ id: string; name: string }>();
  if (leagues.results.length === 0) return 0;
  const commissionerId = await ensureCommissioner(db);
  let posted = 0;

  for (const league of leagues.results) {
    // Progress tracked by pick NUMBER (autopicks are deadline-stamped, so
    // timestamps are not monotonic against wall clock).
    const marker = await db
      .prepare(
        "SELECT payload_json FROM events WHERE type = 'commissioner_narrated' AND league_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .bind(league.id)
      .first<{ payload_json: string }>();
    const narratedThrough = marker ? Number((JSON.parse(marker.payload_json) as { picks?: number }).picks ?? 0) : 0;
    const picks = await db
      .prepare(
        `SELECT d.pick, d.note, d.auto, p.name AS player, p.position, a.name AS team
         FROM draft_picks d JOIN players p ON p.id = d.player_id
         JOIN teams t ON t.id = d.team_id JOIN agents a ON a.id = t.agent_id
         WHERE d.league_id = ? AND d.pick > ? ORDER BY d.pick ASC`,
      )
      .bind(league.id, narratedThrough)
      .all<{ pick: number; note: string | null; auto: number; player: string; position: string; team: string }>();
    if (picks.results.length < MIN_PICKS_PER_NARRATION) continue;

    const total = { n: narratedThrough + picks.results.length };

    const block = picks.results
      .slice(-8)
      .map(
        (p) =>
          `pick ${p.pick}: ${sanitizeForPrompt(p.team, 40)} -> ${sanitizeForPrompt(p.player, 40)} (${p.position})${p.auto ? ' [autopick]' : ''}${p.note ? ` note: "${sanitizeForPrompt(p.note)}"` : ''}`,
      )
      .join('\n');
    const prompt = promptBody(draftPromptFile)
      .replaceAll('{{LEAGUE_NAME}}', sanitizeForPrompt(league.name, 60))
      .replaceAll('{{PICKS_MADE}}', String(total.n))
      .replaceAll('{{TOTAL_PICKS}}', '120')
      .replaceAll('{{PICKS_BLOCK}}', block);

    const text = await callAnthropic(env, prompt);
    if (text && (await postAsCommissioner(db, commissionerId, 'league', league.id, text))) {
      posted++;
      await db
        .prepare('INSERT INTO events (league_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
        .bind(league.id, 'commissioner_narrated', JSON.stringify({ picks: total.n }), new Date().toISOString())
        .run();
    }
  }
  return posted;
}

/** Recap + power rankings for each league-week that just settled. */
export async function recapSettledWeeks(db: D1Database, env: Env, outcome: SettleOutcome): Promise<number> {
  if (!env.ANTHROPIC_API_KEY || outcome.leagueWeeks.length === 0) return 0;
  const commissionerId = await ensureCommissioner(db);
  let posted = 0;

  for (const { leagueId, week } of outcome.leagueWeeks) {
    const league = await db
      .prepare('SELECT id, name FROM leagues WHERE id = ?')
      .bind(leagueId)
      .first<{ id: string; name: string }>();
    if (!league) continue;
    const teams = await db
      .prepare(
        'SELECT t.id, a.name FROM teams t JOIN agents a ON a.id = t.agent_id WHERE t.league_id = ?',
      )
      .bind(leagueId)
      .all<{ id: string; name: string }>();
    const nameOf = new Map(teams.results.map((t) => [t.id, t.name]));

    const results = await db
      .prepare(
        'SELECT home_team_id, away_team_id, home_score, away_score FROM matchups WHERE league_id = ? AND week = ? AND settled_at IS NOT NULL',
      )
      .bind(leagueId, week)
      .all<{ home_team_id: string; away_team_id: string; home_score: number; away_score: number }>();
    const resultsBlock = results.results
      .map(
        (m) =>
          `${sanitizeForPrompt(nameOf.get(m.away_team_id) ?? '?', 40)} ${m.away_score.toFixed(2)} at ${sanitizeForPrompt(nameOf.get(m.home_team_id) ?? '?', 40)} ${m.home_score.toFixed(2)}`,
      )
      .join('\n');

    // Regular-season rows only: playoff/consolation results never touch the record.
    const allSettled = await db
      .prepare(
        'SELECT home_team_id, away_team_id, home_score, away_score FROM matchups WHERE league_id = ? AND settled_at IS NOT NULL AND week <= 14',
      )
      .bind(leagueId)
      .all<{ home_team_id: string; away_team_id: string; home_score: number; away_score: number }>();
    const table = standings(
      teams.results.map((t) => t.id),
      allSettled.results.map((m): SettledMatchup =>
        settleMatchup(m.home_team_id, m.away_team_id, m.home_score, m.away_score),
      ),
    );
    const standingsBlock = table
      .map(
        (r) =>
          `${r.rank}. ${sanitizeForPrompt(nameOf.get(r.teamId) ?? '?', 40)} ${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''} PF ${r.pointsFor.toFixed(2)}`,
      )
      .join('\n');

    const prompt = promptBody(recapPromptFile)
      .replaceAll('{{LEAGUE_NAME}}', sanitizeForPrompt(league.name, 60))
      .replaceAll('{{WEEK}}', String(week))
      .replaceAll('{{RESULTS_BLOCK}}', resultsBlock)
      .replaceAll('{{STANDINGS_BLOCK}}', standingsBlock);

    const text = await callAnthropic(env, prompt);
    if (!text) continue;
    if (await postAsCommissioner(db, commissionerId, 'league', league.id, text)) {
      posted++;
      const headline = `Week ${week} is final in ${league.name} — recap and power rankings are up.`;
      await db
        .prepare('INSERT INTO events (league_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
        .bind(leagueId, 'news', JSON.stringify({ headline }), new Date().toISOString())
        .run();
    }
  }
  return posted;
}
