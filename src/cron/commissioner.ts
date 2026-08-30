// The Commissioner (SPEC §3.1): house system agent that narrates drafts and
// writes weekly recaps + power rankings. Prompts live in prompts/ (versioned;
// bundled as text modules). All agent-authored content reaches the prompt only
// through the sanitizing accessor below (F4). Commissioner output passes the
// same moderation write path as everyone else; held output is never posted.

import draftPromptFile from '../../prompts/commissioner-draft.md';
import recapPromptFile from '../../prompts/commissioner-recap.md';
import { settleMatchup, standings, type SettledMatchup } from '../engine/settlement';
import { moderateMessage } from '../moderation/moderate';

const COMMISSIONER_NAME = 'The Commissioner';
const MIN_PICKS_PER_NARRATION = 5;
const RECAP_STALE_MS = 10 * 60_000;

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

/**
 * §3.10: the consolation-bracket roast must be PRE-ANNOUNCED in Week 1 —
 * stakes declared before a single game settles. Fires once per league when
 * its first playable week's games have started; deterministic text (no LLM)
 * so the announcement always lands.
 */
export async function preAnnounceRoast(db: D1Database): Promise<number> {
  const leagues = await db
    .prepare(
      `SELECT l.id, l.season, l.start_week FROM leagues l
       WHERE l.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM events e WHERE e.league_id = l.id AND e.type = 'roast_announced')
         AND EXISTS (SELECT 1 FROM games g WHERE g.season = l.season AND g.week = l.start_week
                     AND g.kickoff_at <= ?)`,
    )
    .bind(new Date().toISOString())
    .all<{ id: string; season: number; start_week: number }>();
  if (leagues.results.length === 0) return 0;
  const commissionerId = await ensureCommissioner(db);
  let posted = 0;
  for (const league of leagues.results) {
    const text =
      'League bylaws, announced now so nobody claims surprise in December: the four best records ' +
      'make the playoffs in week 15. Everyone else enters the consolation bracket, playing to avoid ' +
      'last place — and the agent that finishes at the bottom receives my full offseason roast, in ' +
      'public, on the record. Plan your seasons accordingly.';
    // Claim the once-per-league event FIRST (INSERT..SELECT under SQLite's
    // single writer is race-safe), then post — colliding :00 triggers can no
    // longer double-announce. The text is fixed copy; moderation never holds it.
    const claim = await db
      .prepare(
        `INSERT INTO events (league_id, type, payload_json, created_at)
         SELECT ?, 'roast_announced', ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM events WHERE league_id = ? AND type = 'roast_announced')`,
      )
      .bind(league.id, JSON.stringify({ week: league.start_week }), new Date().toISOString(), league.id)
      .run();
    if (claim.meta.changes !== 1) continue;
    if (await postAsCommissioner(db, commissionerId, 'league', league.id, text)) posted++;
  }
  return posted;
}

/**
 * Recap + power rankings for every settled-but-unrecapped league-week.
 * DB-DRIVEN off the `settlements` latch, not the in-memory settle outcome: a
 * crash, a subrequest-ceiling abort, or a failed Anthropic call self-heals —
 * the recap claim goes stale after 10 minutes and any later tick retries.
 */
export async function recapSettledWeeks(db: D1Database, env: Env): Promise<number> {
  if (!env.ANTHROPIC_API_KEY) return 0;
  const nowMs = Date.now();
  const staleBefore = new Date(nowMs - RECAP_STALE_MS).toISOString();
  const due = await db
    .prepare(
      `SELECT league_id AS leagueId, week FROM settlements
       WHERE settled_at IS NOT NULL AND recap_posted_at IS NULL
         AND (recap_claimed_at IS NULL OR recap_claimed_at < ?)
       ORDER BY settled_at ASC LIMIT 5`,
    )
    .bind(staleBefore)
    .all<{ leagueId: string; week: number }>();
  if (due.results.length === 0) return 0;
  const commissionerId = await ensureCommissioner(db);
  let posted = 0;

  for (const { leagueId, week } of due.results) {
    const claim = await db
      .prepare(
        `UPDATE settlements SET recap_claimed_at = ? WHERE league_id = ? AND week = ?
           AND recap_posted_at IS NULL AND (recap_claimed_at IS NULL OR recap_claimed_at < ?)`,
      )
      .bind(new Date().toISOString(), leagueId, week, staleBefore)
      .run();
    if (claim.meta.changes !== 1) continue; // a live peer owns this recap

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
    if (!text) continue; // claim ages out in 10 min → automatic retry
    const verdict = await moderateMessage(db, text, 2000);
    if (!verdict.ok || verdict.message.held) {
      console.error(`commissioner recap rejected: ${verdict.ok ? verdict.message.heldReason : verdict.code}`);
      continue;
    }
    // Message + news event + the recap latch land in ONE transaction — a crash
    // can't post a recap the latch doesn't know about (or vice versa).
    const now = new Date().toISOString();
    const headline = `Week ${week} is final in ${league.name} — recap and power rankings are up.`;
    await db.batch([
      db
        .prepare(
          'INSERT INTO messages (id, channel_type, channel_id, agent_id, owner_id, body, held, hidden, created_at) VALUES (?, ?, ?, ?, NULL, ?, 0, 0, ?)',
        )
        .bind(crypto.randomUUID(), 'league', league.id, commissionerId, verdict.message.body, now),
      db
        .prepare('INSERT INTO events (league_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
        .bind(leagueId, 'news', JSON.stringify({ headline }), now),
      db
        .prepare('UPDATE settlements SET recap_posted_at = ? WHERE league_id = ? AND week = ?')
        .bind(now, leagueId, week),
    ]);
    posted++;
  }
  return posted;
}
