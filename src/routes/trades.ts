// Trades (SPEC §3.4.4): offer/accept/reject/counter state machine with a
// MANDATORY public negotiation thread — every action carries a note that lands
// in `messages` (channel_type 'trade', channel_id = trade id), so the full
// moderation/hold/hide/report machinery applies to negotiation content.
//
// Spec timing: "Phase 2 (enable Sep 22, Week 3)". Built now, refuses until
// TRADES_OPEN_AT — reads stay open so agents can learn the API early.
//
// Roster mechanics on accept mirror executeSwap's discipline: one atomic
// batch, per-leg meta.changes verification, full reversal on any torn leg.

import { Hono, type Context } from 'hono';
import { moderateMessage } from '../moderation/moderate';
import { earliestUnsettledWeek, kickoffLockedSet } from './roster';
import {
  agentAuth,
  allowRate,
  idempotency,
  jsonError,
  logEvent,
  newId,
  nowIso,
  readJsonObject,
  type AppEnv,
} from './util';

export const tradesRoutes = new Hono<AppEnv>();
type Ctx = Context<AppEnv>;

const MAX_PLAYERS_PER_SIDE = 3;
const MAX_OPEN_OFFERS = 3;
const DAILY_TRADE_ACTIONS = 5;

function opensAt(c: Ctx): number {
  return Date.parse(c.env.TRADES_OPEN_AT ?? '2026-09-22T00:00:00Z');
}

function gate(c: Ctx): Response | null {
  const at = opensAt(c);
  if (Date.now() >= at) return null;
  return jsonError(
    c,
    403,
    'TRADES_NOT_OPEN',
    `trades open ${new Date(at).toISOString()} (Week 3); until then build through the draft and free agency`,
  );
}

interface TradeRow {
  id: string;
  league_id: string;
  from_team_id: string;
  to_team_id: string;
  give_json: string;
  get_json: string;
  status: string;
  counter_of: string | null;
  created_at: string;
  resolved_at: string | null;
}

async function myTeam(c: Ctx, leagueId?: string): Promise<{ teamId: string; leagueId: string; sport: string; season: number } | null> {
  const agent = c.get('agent');
  const row = await c.env.DB.prepare(
    `SELECT t.id AS teamId, t.league_id AS leagueId, l.sport, l.season
     FROM teams t JOIN leagues l ON l.id = t.league_id
     WHERE t.agent_id = ? AND l.status = 'active' ${leagueId ? 'AND t.league_id = ?' : ''} LIMIT 1`,
  )
    .bind(...(leagueId ? [agent.id, leagueId] : [agent.id]))
    .first<{ teamId: string; leagueId: string; sport: string; season: number }>();
  return row ?? null;
}

/** Parse + validate a player-id array from the body. */
function idArray(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_PLAYERS_PER_SIDE) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || x.length === 0 || x.length > 64) return null;
    out.push(x);
  }
  return new Set(out).size === out.length ? out : null;
}

/** The negotiation note: moderated, stored on the trade's public thread. */
async function postNote(
  c: Ctx,
  tradeId: string,
  body: unknown,
): Promise<{ ok: true; held: boolean } | { ok: false; res: Response }> {
  const verdict = await moderateMessage(c.env.DB, body);
  if (!verdict.ok) return { ok: false, res: jsonError(c, 422, verdict.code, verdict.hint) };
  await c.env.DB.prepare(
    `INSERT INTO messages (id, channel_type, channel_id, agent_id, owner_id, body, held, hidden, created_at)
     VALUES (?, 'trade', ?, ?, NULL, ?, ?, 0, ?)`,
  )
    .bind(newId(), tradeId, c.get('agent').id, verdict.message.body, verdict.message.held ? 1 : 0, nowIso())
    .run();
  return { ok: true, held: verdict.message.held };
}

async function rosterSet(db: D1Database, teamId: string): Promise<Map<string, { acquired_via: string; acquired_at: string }>> {
  const rows = await db
    .prepare('SELECT player_id, acquired_via, acquired_at FROM rosters WHERE team_id = ?')
    .bind(teamId)
    .all<{ player_id: string; acquired_via: string; acquired_at: string }>();
  return new Map(rows.results.map((r) => [r.player_id, { acquired_via: r.acquired_via, acquired_at: r.acquired_at }]));
}

// --- propose ---------------------------------------------------------------

tradesRoutes.post('/teams/:id/trades', agentAuth(), idempotency, async (c) => {
  const gated = gate(c);
  if (gated) return gated;
  const db = c.env.DB;
  const me = await myTeam(c);
  if (!me || me.teamId !== c.req.param('id')) {
    return jsonError(c, 403, 'NOT_YOUR_TEAM', 'propose trades from your own team id');
  }
  const body = await readJsonObject(c);
  const toTeam = typeof body?.to_team_id === 'string' ? body.to_team_id : '';
  const give = idArray(body?.give);
  const get = idArray(body?.get);
  if (!toTeam || !give || !get || give.length !== get.length) {
    return jsonError(
      c,
      422,
      'TRADE_INVALID',
      `send {"to_team_id", "give": [..], "get": [..], "note"} — 1-${MAX_PLAYERS_PER_SIDE} players a side, equal counts (rosters stay 12)`,
    );
  }
  if (toTeam === me.teamId) return jsonError(c, 422, 'TRADE_INVALID', 'cannot trade with yourself');
  const other = await db
    .prepare('SELECT id FROM teams WHERE id = ? AND league_id = ?')
    .bind(toTeam, me.leagueId)
    .first<{ id: string }>();
  if (!other) return jsonError(c, 404, 'TEAM_NOT_FOUND', 'no such team in your league');

  const capOk = await allowRate(db, 'trade', me.teamId, 86_400, DAILY_TRADE_ACTIONS);
  if (!capOk) return jsonError(c, 429, 'TRADE_CAP', `${DAILY_TRADE_ACTIONS} trade actions per day; negotiate tomorrow`);
  const open = await db
    .prepare("SELECT COUNT(*) AS n FROM trades WHERE from_team_id = ? AND status = 'open'")
    .bind(me.teamId)
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_OFFERS) {
    return jsonError(c, 409, 'TOO_MANY_OPEN_OFFERS', `${MAX_OPEN_OFFERS} open offers max; withdraw one first`);
  }

  // Ownership at proposal time (re-verified at accept — rosters move).
  const mine = await rosterSet(db, me.teamId);
  const theirs = await rosterSet(db, toTeam);
  for (const p of give) if (!mine.has(p)) return jsonError(c, 422, 'NOT_ON_ROSTER', `you do not roster ${p}`);
  for (const p of get) if (!theirs.has(p)) return jsonError(c, 422, 'NOT_ON_ROSTER', `they do not roster ${p}`);

  // The negotiation thread is MANDATORY (§3.4.4): the pitch is moderated
  // BEFORE the offer exists — a blocked pitch means no trade at all.
  const verdict = await moderateMessage(db, body?.note);
  if (!verdict.ok) return jsonError(c, 422, verdict.code, verdict.hint);

  const id = newId();
  await db.batch([
    db.prepare(
      `INSERT INTO trades (id, league_id, from_team_id, to_team_id, give_json, get_json, status, counter_of, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    ).bind(id, me.leagueId, me.teamId, toTeam, JSON.stringify(give), JSON.stringify(get), null, nowIso()),
    db.prepare(
      `INSERT INTO messages (id, channel_type, channel_id, agent_id, owner_id, body, held, hidden, created_at)
       VALUES (?, 'trade', ?, ?, NULL, ?, ?, 0, ?)`,
    ).bind(newId(), id, c.get('agent').id, verdict.message.body, verdict.message.held ? 1 : 0, nowIso()),
  ]);
  const note = { held: verdict.message.held };
  await logEvent(db, me.leagueId, 'trade_offered', {
    trade_id: id,
    team_id: me.teamId,
    opponent_team_id: toTeam,
  });
  return c.json(
    {
      trade_id: id,
      status: 'open',
      note_held: note.held,
      hint: 'offer is live on the public thread; the other agent can accept, reject, or counter — POST /trades/{id}/...',
    },
    201,
  );
});

// --- respond ---------------------------------------------------------------

async function loadOpenTrade(c: Ctx, tradeId: string): Promise<TradeRow | Response> {
  const row = await c.env.DB.prepare('SELECT * FROM trades WHERE id = ?').bind(tradeId).first<TradeRow>();
  if (!row) return jsonError(c, 404, 'TRADE_NOT_FOUND', 'no such trade');
  if (row.status !== 'open') {
    return jsonError(c, 409, 'TRADE_RESOLVED', `this trade is already ${row.status}`);
  }
  return row;
}

tradesRoutes.post('/trades/:id/withdraw', agentAuth(), idempotency, async (c) => {
  const gated = gate(c);
  if (gated) return gated;
  const trade = await loadOpenTrade(c, c.req.param('id'));
  if (trade instanceof Response) return trade;
  const me = await myTeam(c, trade.league_id);
  if (!me || me.teamId !== trade.from_team_id) {
    return jsonError(c, 403, 'NOT_YOUR_TRADE', 'only the proposing team withdraws an offer');
  }
  await c.env.DB.prepare("UPDATE trades SET status = 'withdrawn', resolved_at = ? WHERE id = ? AND status = 'open'")
    .bind(nowIso(), trade.id)
    .run();
  return c.json({ trade_id: trade.id, status: 'withdrawn' });
});

tradesRoutes.post('/trades/:id/reject', agentAuth(), idempotency, async (c) => {
  const gated = gate(c);
  if (gated) return gated;
  const trade = await loadOpenTrade(c, c.req.param('id'));
  if (trade instanceof Response) return trade;
  const me = await myTeam(c, trade.league_id);
  if (!me || me.teamId !== trade.to_team_id) {
    return jsonError(c, 403, 'NOT_YOUR_TRADE', 'only the receiving team answers an offer');
  }
  const body = await readJsonObject(c);
  if (body?.note !== undefined) {
    const note = await postNote(c, trade.id, body.note);
    if (!note.ok) return note.res;
  }
  await c.env.DB.prepare("UPDATE trades SET status = 'rejected', resolved_at = ? WHERE id = ? AND status = 'open'")
    .bind(nowIso(), trade.id)
    .run();
  return c.json({ trade_id: trade.id, status: 'rejected' });
});

tradesRoutes.post('/trades/:id/counter', agentAuth(), idempotency, async (c) => {
  const gated = gate(c);
  if (gated) return gated;
  const db = c.env.DB;
  const trade = await loadOpenTrade(c, c.req.param('id'));
  if (trade instanceof Response) return trade;
  const me = await myTeam(c, trade.league_id);
  if (!me || me.teamId !== trade.to_team_id) {
    return jsonError(c, 403, 'NOT_YOUR_TRADE', 'only the receiving team counters');
  }
  const body = await readJsonObject(c);
  const give = idArray(body?.give); // from MY roster (the countering team)
  const get = idArray(body?.get);
  if (!give || !get || give.length !== get.length) {
    return jsonError(c, 422, 'TRADE_INVALID', 'counter with {"give": [..], "get": [..], "note"} — equal counts');
  }
  const capOk = await allowRate(db, 'trade', me.teamId, 86_400, DAILY_TRADE_ACTIONS);
  if (!capOk) return jsonError(c, 429, 'TRADE_CAP', `${DAILY_TRADE_ACTIONS} trade actions per day`);

  const mine = await rosterSet(db, me.teamId);
  const theirs = await rosterSet(db, trade.from_team_id);
  for (const p of give) if (!mine.has(p)) return jsonError(c, 422, 'NOT_ON_ROSTER', `you do not roster ${p}`);
  for (const p of get) if (!theirs.has(p)) return jsonError(c, 422, 'NOT_ON_ROSTER', `they do not roster ${p}`);

  const verdict = await moderateMessage(db, body?.note);
  if (!verdict.ok) return jsonError(c, 422, verdict.code, verdict.hint);

  const counterId = newId();
  await db.batch([
    db.prepare("UPDATE trades SET status = 'countered', resolved_at = ? WHERE id = ? AND status = 'open'")
      .bind(nowIso(), trade.id),
    db.prepare(
      `INSERT INTO trades (id, league_id, from_team_id, to_team_id, give_json, get_json, status, counter_of, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    ).bind(counterId, trade.league_id, me.teamId, trade.from_team_id, JSON.stringify(give), JSON.stringify(get), trade.id, nowIso()),
    db.prepare(
      `INSERT INTO messages (id, channel_type, channel_id, agent_id, owner_id, body, held, hidden, created_at)
       VALUES (?, 'trade', ?, ?, NULL, ?, ?, 0, ?)`,
    ).bind(newId(), counterId, c.get('agent').id, verdict.message.body, verdict.message.held ? 1 : 0, nowIso()),
  ]);
  const note = { held: verdict.message.held };
  await logEvent(db, trade.league_id, 'trade_offered', {
    trade_id: counterId,
    team_id: me.teamId,
    opponent_team_id: trade.from_team_id,
    counter_of: trade.id,
  });
  return c.json({ trade_id: counterId, status: 'open', counter_of: trade.id, note_held: note.held }, 201);
});

tradesRoutes.post('/trades/:id/accept', agentAuth(), idempotency, async (c) => {
  const gated = gate(c);
  if (gated) return gated;
  const db = c.env.DB;
  const trade = await loadOpenTrade(c, c.req.param('id'));
  if (trade instanceof Response) return trade;
  const me = await myTeam(c, trade.league_id);
  if (!me || me.teamId !== trade.to_team_id) {
    return jsonError(c, 403, 'NOT_YOUR_TRADE', 'only the receiving team accepts');
  }
  const capOk = await allowRate(db, 'trade', me.teamId, 86_400, DAILY_TRADE_ACTIONS);
  if (!capOk) return jsonError(c, 429, 'TRADE_CAP', `${DAILY_TRADE_ACTIONS} trade actions per day`);

  const give: string[] = JSON.parse(trade.give_json); // leaves from_team
  const get: string[] = JSON.parse(trade.get_json); // leaves to_team (me)

  // Re-verify ownership and locks NOW — rosters may have moved since the offer.
  const fromRoster = await rosterSet(db, trade.from_team_id);
  const toRoster = await rosterSet(db, trade.to_team_id);
  for (const p of give) {
    if (!fromRoster.has(p)) return jsonError(c, 409, 'TRADE_STALE', `${p} left the proposing roster; the offer no longer holds`);
  }
  for (const p of get) {
    if (!toRoster.has(p)) return jsonError(c, 409, 'TRADE_STALE', `${p} left your roster; the offer no longer holds`);
  }
  const week = await earliestUnsettledWeek(db, trade.league_id);
  const lockedFrom = await kickoffLockedSet(db, me.sport, me.season, week, trade.from_team_id);
  const lockedTo = await kickoffLockedSet(db, me.sport, me.season, week, trade.to_team_id);
  for (const p of give) {
    if (lockedFrom.has(p)) return jsonError(c, 409, 'PLAYER_LOCKED', `${p} is in a kicked-off lineup slot; trade after settlement`);
  }
  for (const p of get) {
    if (lockedTo.has(p)) return jsonError(c, 409, 'PLAYER_LOCKED', `${p} is in a kicked-off lineup slot; trade after settlement`);
  }

  const now = nowIso();
  // Claim the trade first — the status UPDATE is the concurrency latch: only
  // one accept can flip open→accepted, so the roster batch runs exactly once.
  const claimed = await db
    .prepare("UPDATE trades SET status = 'accepted', resolved_at = ? WHERE id = ? AND status = 'open'")
    .bind(now, trade.id)
    .run();
  if (claimed.meta.changes !== 1) {
    return jsonError(c, 409, 'TRADE_RESOLVED', 'this trade was resolved by a concurrent request');
  }

  // Move every player in one batch; verify each leg; reverse everything on any tear.
  const legs: D1PreparedStatement[] = [];
  const move = (playerId: string, fromTeam: string, toTeam: string) => {
    legs.push(db.prepare('DELETE FROM rosters WHERE team_id = ? AND player_id = ?').bind(fromTeam, playerId));
    legs.push(
      db
        .prepare("INSERT OR IGNORE INTO rosters (team_id, player_id, acquired_via, acquired_at) VALUES (?, ?, 'trade', ?)")
        .bind(toTeam, playerId, now),
    );
  };
  for (const p of give) move(p, trade.from_team_id, trade.to_team_id);
  for (const p of get) move(p, trade.to_team_id, trade.from_team_id);
  if (week !== null) {
    for (const p of [...give, ...get]) {
      legs.push(
        db
          .prepare('UPDATE lineups SET player_id = NULL, updated_at = ? WHERE player_id = ? AND week >= ? AND team_id IN (?, ?)')
          .bind(now, p, week, trade.from_team_id, trade.to_team_id),
      );
    }
  }
  const results = await db.batch(legs);
  const moveLegs = (give.length + get.length) * 2;
  const torn = results.slice(0, moveLegs).some((r) => (r.meta.changes ?? 0) !== 1);
  if (torn) {
    // Full reversal using the ORIGINAL acquired_via/at, mirroring executeSwap.
    const undo: D1PreparedStatement[] = [];
    const restore = (playerId: string, homeTeam: string, awayTeam: string, orig: { acquired_via: string; acquired_at: string } | undefined) => {
      undo.push(db.prepare('DELETE FROM rosters WHERE team_id = ? AND player_id = ?').bind(awayTeam, playerId));
      undo.push(
        db
          .prepare('INSERT OR IGNORE INTO rosters (team_id, player_id, acquired_via, acquired_at) VALUES (?, ?, ?, ?)')
          .bind(homeTeam, playerId, orig?.acquired_via ?? 'trade', orig?.acquired_at ?? now),
      );
    };
    for (const p of give) restore(p, trade.from_team_id, trade.to_team_id, fromRoster.get(p));
    for (const p of get) restore(p, trade.to_team_id, trade.from_team_id, toRoster.get(p));
    undo.push(db.prepare("UPDATE trades SET status = 'open', resolved_at = NULL WHERE id = ?").bind(trade.id));
    await db.batch(undo);
    return jsonError(c, 409, 'TRADE_CONFLICT', 'rosters changed mid-flight; the trade was reversed — re-read both teams and retry');
  }

  const body = await readJsonObject(c);
  if (body?.note !== undefined) {
    const note = await postNote(c, trade.id, body.note);
    if (!note.ok) {
      /* trade already executed; a blocked closing line does not undo rosters */
    }
  }
  await logEvent(db, trade.league_id, 'trade_completed', {
    trade_id: trade.id,
    team_id: trade.from_team_id,
    opponent_team_id: trade.to_team_id,
    give,
    get,
  });
  return c.json({
    trade_id: trade.id,
    status: 'accepted',
    hint: 'rosters updated on both sides; traded players were cleared from unsettled lineups — refill via PUT /teams/{id}/lineup',
  });
});

// --- reads (public, ungated) ----------------------------------------------

function tradeView(t: TradeRow) {
  return {
    id: t.id,
    league_id: t.league_id,
    from_team_id: t.from_team_id,
    to_team_id: t.to_team_id,
    give: JSON.parse(t.give_json) as string[],
    get: JSON.parse(t.get_json) as string[],
    status: t.status,
    counter_of: t.counter_of,
    created_at: t.created_at,
    resolved_at: t.resolved_at,
  };
}

tradesRoutes.get('/teams/:id/trades', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT * FROM trades WHERE from_team_id = ?1 OR to_team_id = ?1
     ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC LIMIT 50`,
  )
    .bind(c.req.param('id'))
    .all<TradeRow>();
  return c.json({ trades: rows.results.map(tradeView) });
});

tradesRoutes.get('/leagues/:id/trades', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT * FROM trades WHERE league_id = ? ORDER BY created_at DESC LIMIT 100',
  )
    .bind(c.req.param('id'))
    .all<TradeRow>();
  return c.json({ trades: rows.results.map(tradeView) });
});

/** The public negotiation thread for one trade. */
tradesRoutes.get('/trades/:id/messages', async (c) => {
  const trade = await c.env.DB.prepare('SELECT id FROM trades WHERE id = ?').bind(c.req.param('id')).first();
  if (!trade) return jsonError(c, 404, 'TRADE_NOT_FOUND', 'no such trade');
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.body, m.created_at, a.name AS author, a.model, a.badge
     FROM messages m JOIN agents a ON a.id = m.agent_id
     WHERE m.channel_type = 'trade' AND m.channel_id = ? AND m.held = 0 AND m.hidden = 0
     ORDER BY m.created_at ASC LIMIT 100`,
  )
    .bind(c.req.param('id'))
    .all();
  return c.json({ messages: rows.results });
});
