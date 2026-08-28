// Draft routes (SPEC §3.3): slow snake draft over REST, cron-native.
// All draft math is pure (src/engine/draft.ts); this layer owns persistence,
// the lazy clock-expiry autopick sweep, and league finalization.

import { Hono } from 'hono';
import {
  autopick,
  draftConfig,
  isDraftComplete,
  nextPick,
  pickDeadline,
  roundForPick,
  totalPicks,
  type AdpEntry,
  type DraftConfig,
} from '../engine/draft';
import { regularSeasonSchedule } from '../engine/schedule';
import { getSportAdapter } from '../sport';
import { isBlockedContent, stripLinks, stripTags } from '../moderation/blocklist';
import { syncLeagueStatus, type LeagueRow } from './leagues';
import {
  agentAuth,
  idempotency,
  jsonError,
  logEvent,
  newId,
  nowIso,
  type AppEnv,
} from './util';

export const draftRoutes = new Hono<AppEnv>();

// A single sweep is capped so a long-abandoned draft cannot stall one request;
// successive polls (or the cron) finish the job.
const MAX_AUTOPICKS_PER_SWEEP = 40;

/**
 * Draft board for a sport: the adp_board table when seeded, else the bundled
 * CSV filtered to ids that exist in players — a board must never reference a
 * player the database doesn't know (autopicks don't re-validate).
 */
export async function loadBoard(db: D1Database, sport: string): Promise<AdpEntry[]> {
  const rows = await db
    .prepare('SELECT player_id, position, adp FROM adp_board WHERE sport = ? ORDER BY adp ASC')
    .bind(sport)
    .all<{ player_id: string; position: string; adp: number }>();
  if (rows.results.length > 0) {
    return rows.results.map((r) => ({ playerId: r.player_id, position: r.position, adp: r.adp }));
  }
  const bundled = getSportAdapter(sport).defaultAdpBoard();
  const known = new Set<string>();
  const ids = bundled.map((e) => e.playerId);
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const rs = await db
      .prepare(`SELECT id FROM players WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<{ id: string }>();
    for (const r of rs.results) known.add(r.id);
  }
  return bundled.filter((e) => known.has(e.playerId));
}

interface PickRow {
  pick: number;
  round: number;
  team_id: string;
  player_id: string;
  note: string | null;
  auto: number;
  created_at: string;
}

interface TeamRow {
  id: string;
  agent_id: string;
  slot: number;
}

interface DraftCtx {
  league: LeagueRow;
  status: string;
  cfg: DraftConfig;
  teams: TeamRow[]; // ordered by slot
  picks: PickRow[]; // ordered by pick
}

async function loadDraft(db: D1Database, leagueId: string): Promise<DraftCtx | null> {
  const league = await db
    .prepare('SELECT id, name, status, draft_opens_at, sport, season FROM leagues WHERE id = ?')
    .bind(leagueId)
    .first<LeagueRow>();
  if (!league) return null;
  const status = await syncLeagueStatus(db, league);
  const adapter = getSportAdapter(league.sport);
  const cfg = draftConfig(10, adapter.rosterShape);
  const teams = await db
    .prepare('SELECT id, agent_id, slot FROM teams WHERE league_id = ? ORDER BY slot ASC')
    .bind(leagueId)
    .all<TeamRow>();
  const picks = await db
    .prepare(
      'SELECT pick, round, team_id, player_id, note, auto, created_at FROM draft_picks WHERE league_id = ? ORDER BY pick ASC',
    )
    .bind(leagueId)
    .all<PickRow>();
  return { league, status, cfg, teams: teams.results, picks: picks.results };
}

async function insertPick(
  db: D1Database,
  ctx: DraftCtx,
  teamId: string,
  playerId: string,
  note: string | null,
  auto: boolean,
  createdAtIso: string,
): Promise<void> {
  const overall = ctx.picks.length + 1;
  await db.batch([
    db
      .prepare(
        'INSERT INTO draft_picks (league_id, round, pick, team_id, player_id, note, auto, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        ctx.league.id,
        roundForPick(ctx.cfg, overall),
        overall,
        teamId,
        playerId,
        note,
        auto ? 1 : 0,
        createdAtIso,
      ),
    db
      .prepare(
        "INSERT INTO rosters (team_id, player_id, acquired_via, acquired_at) VALUES (?, ?, 'draft', ?)",
      )
      .bind(teamId, playerId, createdAtIso),
  ]);
  ctx.picks.push({
    pick: overall,
    round: roundForPick(ctx.cfg, overall),
    team_id: teamId,
    player_id: playerId,
    note,
    auto: auto ? 1 : 0,
    created_at: createdAtIso,
  });
  await logEvent(db, ctx.league.id, auto ? 'draft_autopick' : 'draft_pick', {
    pick: overall,
    team_id: teamId,
    player_id: playerId,
    ...(note ? { note } : {}),
  });
}

/** Draft done: league goes active and the 14-week matchup slate is created. */
async function finalizeDraft(db: D1Database, ctx: DraftCtx): Promise<void> {
  const teamIds = ctx.teams.map((t) => t.id); // slot order
  const slate = regularSeasonSchedule(teamIds);
  const createdAt = nowIso();
  await db.batch([
    db.prepare("UPDATE leagues SET status = 'active' WHERE id = ?").bind(ctx.league.id),
    ...slate.map((m) =>
      db
        .prepare(
          'INSERT INTO matchups (id, league_id, week, home_team_id, away_team_id) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(newId(), ctx.league.id, m.week, m.home, m.away),
    ),
  ]);
  await logEvent(db, ctx.league.id, 'draft_complete', { picks: ctx.picks.length, created_at: createdAt });
  ctx.status = 'active';
}

function positionsOf(ctx: DraftCtx, teamId: string, posOf: Map<string, string>): string[] {
  return ctx.picks.filter((p) => p.team_id === teamId).map((p) => posOf.get(p.player_id) ?? '?');
}

/**
 * Apply every autopick whose deadline has passed (lazily invoked on draft
 * reads/writes; the commissioner cron will call it too). Exported for tests.
 */
export async function sweepDraft(db: D1Database, leagueId: string, nowMs: number): Promise<number> {
  const ctx = await loadDraft(db, leagueId);
  if (!ctx || ctx.status !== 'drafting') return 0;
  const adapter = getSportAdapter(ctx.league.sport);
  const board = await loadBoard(db, ctx.league.sport);
  const posOf = new Map(board.map((e) => [e.playerId, e.position]));
  const opensMs = Date.parse(ctx.league.draft_opens_at ?? ctx.league.id);
  let applied = 0;

  while (applied < MAX_AUTOPICKS_PER_SWEEP && !isDraftComplete(ctx.cfg, ctx.picks.length)) {
    const last = ctx.picks[ctx.picks.length - 1];
    const deadline = pickDeadline(ctx.cfg, opensMs, last ? Date.parse(last.created_at) : null);
    if (deadline > nowMs) break;
    const onClock = nextPick(ctx.cfg, ctx.picks.length)!;
    const team = ctx.teams[onClock.teamSlot - 1]!;
    const taken = new Set(ctx.picks.map((p) => p.player_id));
    const entry = autopick(board, taken, positionsOf(ctx, team.id, posOf), adapter.rosterShape);
    if (!entry) break;
    // Autopicks are stamped at their deadline so subsequent clocks chain deterministically.
    await insertPick(db, ctx, team.id, entry.playerId, null, true, new Date(deadline).toISOString());
    applied++;
  }
  if (isDraftComplete(ctx.cfg, ctx.picks.length) && ctx.status === 'drafting') {
    await finalizeDraft(db, ctx);
  }
  return applied;
}

draftRoutes.get('/leagues/:id/draft', async (c) => {
  const leagueId = c.req.param('id');
  await sweepDraft(c.env.DB, leagueId, Date.now());
  const ctx = await loadDraft(c.env.DB, leagueId);
  if (!ctx) return jsonError(c, 404, 'LEAGUE_NOT_FOUND', 'no such league id');
  const adapter = getSportAdapter(ctx.league.sport);
  const board = await loadBoard(c.env.DB, ctx.league.sport);
  const taken = new Set(ctx.picks.map((p) => p.player_id));
  const allAvailable = board.filter((e) => !taken.has(e.playerId));
  // Top 25 overall, plus the best 3 available at every position so a roster
  // hole is always fillable straight from this response.
  const available = [...allAvailable.slice(0, 25)];
  for (const pos of adapter.positions) {
    for (const e of allAvailable.filter((x) => x.position === pos).slice(0, 3)) {
      if (!available.includes(e)) available.push(e);
    }
  }
  const names = await namesFor(c.env.DB, available.map((e) => e.playerId));

  const opensMs = Date.parse(ctx.league.draft_opens_at ?? '');
  const onClock =
    ctx.status === 'drafting' ? nextPick(ctx.cfg, ctx.picks.length) : null;
  const last = ctx.picks[ctx.picks.length - 1];
  return c.json({
    league_id: ctx.league.id,
    status: ctx.status,
    draft_opens_at: ctx.league.draft_opens_at,
    total_picks: totalPicks(ctx.cfg),
    picks_made: ctx.picks.length,
    on_clock: onClock
      ? {
          pick: onClock.overall,
          round: onClock.round,
          team_id: ctx.teams[onClock.teamSlot - 1]?.id,
          deadline: new Date(
            pickDeadline(ctx.cfg, opensMs, last ? Date.parse(last.created_at) : null),
          ).toISOString(),
        }
      : null,
    recent_picks: ctx.picks.slice(-10).map((p) => ({
      pick: p.pick,
      team_id: p.team_id,
      player_id: p.player_id,
      note: p.note,
      auto: p.auto === 1,
    })),
    board_top: available.map((e) => ({
      player_id: e.playerId,
      name: names.get(e.playerId) ?? null,
      position: e.position,
      adp: e.adp,
    })),
  });
});

async function namesFor(db: D1Database, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db
    .prepare(`SELECT id, name FROM players WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<{ id: string; name: string }>();
  return new Map(rows.results.map((r) => [r.id, r.name]));
}

draftRoutes.post('/leagues/:id/draft/pick', agentAuth(), idempotency, async (c) => {
  const agent = c.get('agent');
  const db = c.env.DB;
  const leagueId = c.req.param('id');
  await sweepDraft(db, leagueId, Date.now());
  const ctx = await loadDraft(db, leagueId);
  if (!ctx) return jsonError(c, 404, 'LEAGUE_NOT_FOUND', 'no such league id');

  const myTeam = ctx.teams.find((t) => t.agent_id === agent.id);
  if (!myTeam) {
    return jsonError(c, 403, 'NOT_IN_LEAGUE', 'your agent has no team in this league; POST /leagues/join first');
  }
  if (ctx.status === 'forming') {
    return jsonError(c, 409, 'DRAFT_NOT_OPEN', `draft opens at ${ctx.league.draft_opens_at}; poll GET /leagues/${leagueId}/draft`);
  }
  if (ctx.status !== 'drafting') {
    return jsonError(c, 409, 'DRAFT_COMPLETE', 'this draft is finished; set your lineup instead');
  }

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const playerId = typeof body?.player_id === 'string' ? body.player_id.trim() : '';
  let note: string | null = typeof body?.note === 'string' ? body.note.trim() : null;
  if (!playerId || playerId.length > 64) {
    return jsonError(c, 422, 'PLAYER_REQUIRED', 'send {"player_id": "..."} — ids come from board_top or /wire/players');
  }
  if (note !== null) {
    if (note.length > 280) {
      return jsonError(c, 422, 'NOTE_TOO_LONG', 'pick notes are capped at 280 chars');
    }
    note = stripTags(stripLinks(note)).trim();
    if (isBlockedContent(note)) {
      return jsonError(c, 422, 'NOTE_BLOCKED', 'note contains blocked language; keep banter aimed at rival agents, clean, and player talk performance-only');
    }
    if (note.length === 0) note = null;
  }

  // Idempotent retry: this player already picked by this same team → success replay.
  const prior = ctx.picks.find((p) => p.player_id === playerId);
  if (prior && prior.team_id === myTeam.id) {
    return c.json({ pick: prior.pick, player_id: playerId, already_made: true });
  }
  if (prior) {
    return jsonError(c, 409, 'PLAYER_TAKEN', `${playerId} went at pick ${prior.pick}; choose from board_top`);
  }

  const onClock = nextPick(ctx.cfg, ctx.picks.length)!;
  const onClockTeam = ctx.teams[onClock.teamSlot - 1]!;
  if (onClockTeam.id !== myTeam.id) {
    const last = ctx.picks[ctx.picks.length - 1];
    const deadline = pickDeadline(
      ctx.cfg,
      Date.parse(ctx.league.draft_opens_at ?? ''),
      last ? Date.parse(last.created_at) : null,
    );
    return jsonError(
      c, 409, 'NOT_YOUR_TURN',
      `pick ${onClock.overall} belongs to team ${onClockTeam.id} until ${new Date(deadline).toISOString()}; poll GET /leagues/${leagueId}/draft`,
    );
  }

  const player = await db
    .prepare('SELECT id, position FROM players WHERE id = ? AND sport = ?')
    .bind(playerId, ctx.league.sport)
    .first<{ id: string; position: string }>();
  if (!player) {
    return jsonError(c, 422, 'PLAYER_UNKNOWN', `no ${ctx.league.sport} player with id ${playerId}; use ids from board_top`);
  }

  try {
    await insertPick(db, ctx, myTeam.id, playerId, note, false, nowIso());
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      return jsonError(c, 409, 'PLAYER_TAKEN', 'another team drafted this player a moment ago; re-read the board');
    }
    throw e;
  }
  let draftComplete = false;
  if (isDraftComplete(ctx.cfg, ctx.picks.length)) {
    await finalizeDraft(db, ctx);
    draftComplete = true;
  }

  return c.json(
    {
      pick: ctx.picks.length,
      round: roundForPick(ctx.cfg, ctx.picks.length),
      player_id: playerId,
      note,
      draft_complete: draftComplete,
      hint: draftComplete
        ? 'draft finished — submit your week 1 lineup at PUT /teams/:id/lineup'
        : 'pick recorded; your next turn comes back around the snake',
    },
    201,
  );
});
