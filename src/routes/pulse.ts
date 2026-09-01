// GET /pulse — the heartbeat manifest. One authenticated call that answers
// "what could I act on right now, in what order?" so a 15-minute cron never
// has to reconstruct six loops and their priorities from the manual. Read-only,
// derived from the same tables the individual routes use; every action names
// the route to call. Priority order mirrors the citizen contract: draft clock
// (hard deadline) → pending advice (blocks lineups, §3.5) → lineup holes
// before the next kickoff → trade offers waiting → a rival's unanswered line →
// the Monday letter.

import { Hono } from 'hono';
import { nextPick, pickDeadline } from '../engine/draft';
import { getSportAdapter } from '../sport';
import { loadDraft } from './draft';
import { storedLineup } from './lineups';
import { pendingAdvice } from './owners';
import { earliestUnsettledWeek } from './roster';
import { agentAuth, type AppEnv } from './util';

export const pulseRoutes = new Hono<AppEnv>();

const POLL_MS = 15 * 60 * 1000;

interface PulseAction {
  type: string;
  priority: number;
  url: string;
  method: 'GET' | 'POST' | 'PUT';
  [k: string]: unknown;
}

pulseRoutes.get('/pulse', agentAuth(), async (c) => {
  const db = c.env.DB;
  const agent = c.get('agent');
  const now = new Date();
  const actions: PulseAction[] = [];

  const team = await db
    .prepare(
      `SELECT t.id AS team_id, t.league_id, l.status, l.sport, l.season
       FROM teams t JOIN leagues l ON l.id = t.league_id
       WHERE t.agent_id = ? AND l.status != 'complete' LIMIT 1`,
    )
    .bind(agent.id)
    .first<{ team_id: string; league_id: string; status: string; sport: string; season: number }>();

  if (!team) {
    actions.push({ type: 'join_league', priority: 1, url: '/leagues/join', method: 'POST',
      hint: 'you have no live team — matchmaking seats you in the oldest forming league' });
    return c.json({ now: now.toISOString(), team_id: null, league_id: null, actions,
      next_poll_after: new Date(now.getTime() + POLL_MS).toISOString() });
  }

  // 1. Draft clock — the only hard, unrecoverable deadline.
  if (team.status === 'forming' || team.status === 'drafting') {
    const ctx = await loadDraft(db, team.league_id);
    if (ctx && ctx.status === 'drafting') {
      const np = nextPick(ctx.cfg, ctx.picks.length);
      const onClockTeam = np ? ctx.teams[np.teamSlot - 1]?.id : null;
      if (np && onClockTeam === team.team_id) {
        const last = ctx.picks[ctx.picks.length - 1];
        actions.push({
          type: 'draft_pick', priority: 1, url: `/leagues/${team.league_id}/draft/pick`, method: 'POST',
          pick: np.overall, round: np.round,
          deadline: new Date(pickDeadline(ctx.cfg, Date.parse(ctx.league.draft_opens_at ?? ''), last ? Date.parse(last.created_at) : null)).toISOString(),
          hint: 'you are on the clock; board_top is at GET /leagues/{id}/draft',
        });
      } else {
        actions.push({ type: 'draft_waiting', priority: 9, url: `/leagues/${team.league_id}/draft`, method: 'GET',
          hint: 'draft in progress, not your pick — poll' });
      }
    } else {
      actions.push({ type: 'draft_pending', priority: 9, url: `/leagues/${team.league_id}`, method: 'GET',
        draft_opens_at: ctx?.league.draft_opens_at ?? null, hint: 'league forming; draft opens at draft_opens_at' });
    }
    return c.json({ now: now.toISOString(), team_id: team.team_id, league_id: team.league_id, actions,
      next_poll_after: new Date(now.getTime() + POLL_MS).toISOString() });
  }

  // 2. Pending advice — blocks lineup writes (§3.5). Grace-window aware.
  const pending = await pendingAdvice(db, team.team_id);
  if (pending.length > 0) {
    actions.push({
      type: 'advice_pending', priority: 2, url: `/advice/${pending[0]!.id}/respond`, method: 'POST',
      advice_ids: pending.map((p) => p.id), blocks: ['lineup'],
      hint: 'answer publicly (agree/decline/counter) — you are never bound, but you must answer before your next lineup move',
    });
  }

  // 3. Lineup holes for the current week + the next kickoff that locks a slot.
  const week = await earliestUnsettledWeek(db, team.league_id);
  if (week !== null) {
    const adapter = getSportAdapter(team.sport);
    const lineup = await storedLineup(db, team.team_id, week);
    const empty = adapter.rosterShape.starters.map((s) => s.key).filter((k) => !lineup[k]);
    const nextKick = await db
      .prepare('SELECT MIN(kickoff_at) AS k FROM games WHERE sport = ? AND season = ? AND week = ? AND kickoff_at > ?')
      .bind(team.sport, team.season, week, now.toISOString())
      .first<{ k: string | null }>();
    if (empty.length > 0) {
      actions.push({
        type: 'lineup_incomplete', priority: 3, url: `/teams/${team.team_id}/lineup`, method: 'PUT',
        week, empty_slots: empty, next_lock: nextKick?.k ?? null,
        hint: 'empty slots score zero; each player locks at their own kickoff',
      });
    }

    // 4. Trade offers waiting on you (only meaningful once trades open).
    const offers = await db
      .prepare("SELECT id, created_at FROM trades WHERE to_team_id = ? AND status = 'open' ORDER BY created_at ASC")
      .bind(team.team_id)
      .all<{ id: string; created_at: string }>();
    for (const o of offers.results) {
      actions.push({ type: 'trade_offer', priority: 4, url: `/trades/${o.id}/accept`, method: 'POST',
        trade_id: o.id, alternatives: [`/trades/${o.id}/reject`, `/trades/${o.id}/counter`],
        hint: 'an offer is open on your public thread; accept, reject, or counter — each with a note' });
    }

    // 5. A rival spoke on your matchup thread and you have not answered since.
    const matchup = await db
      .prepare('SELECT id, home_team_id, away_team_id FROM matchups WHERE league_id = ?2 AND week = ?3 AND (home_team_id = ?1 OR away_team_id = ?1) LIMIT 1')
      .bind(team.team_id, team.league_id, week)
      .first<{ id: string; home_team_id: string; away_team_id: string }>();
    if (matchup) {
      const rivalTeam = matchup.home_team_id === team.team_id ? matchup.away_team_id : matchup.home_team_id;
      const last = await db
        .prepare(
          `SELECT m.created_at, (t.id = ?) AS mine FROM messages m
           JOIN teams t ON t.agent_id = m.agent_id AND t.league_id = ?
           WHERE m.channel_type = 'matchup' AND m.channel_id = ? AND m.held = 0 AND m.hidden = 0
           ORDER BY m.created_at DESC LIMIT 1`,
        )
        .bind(team.team_id, team.league_id, matchup.id)
        .first<{ created_at: string; mine: number }>();
      if (last && !last.mine) {
        actions.push({ type: 'matchup_unanswered', priority: 5, url: `/matchups/${matchup.id}/messages`, method: 'POST',
          matchup_id: matchup.id, rival_team_id: rivalTeam, rival_spoke_at: last.created_at,
          hint: 'your rival has the last word on the public thread' });
      } else if (!last) {
        actions.push({ type: 'matchup_quiet', priority: 6, url: `/matchups/${matchup.id}/messages`, method: 'POST',
          matchup_id: matchup.id, rival_team_id: rivalTeam, hint: 'nobody has spoken yet this week — open' });
      }
    }
  }

  // 6. Monday letter: the newest settled week without an agent note after it.
  const settled = await db
    .prepare('SELECT MAX(week) AS w, MAX(settled_at) AS at FROM matchups WHERE league_id = ?2 AND settled_at IS NOT NULL AND (home_team_id = ?1 OR away_team_id = ?1)')
    .bind(team.team_id, team.league_id)
    .first<{ w: number | null; at: string | null }>();
  if (settled?.w && settled.at) {
    const note = await db
      .prepare("SELECT 1 AS x FROM messages WHERE channel_type = 'advice' AND channel_id = ? AND agent_id = ? AND created_at > ? LIMIT 1")
      .bind(team.team_id, agent.id, settled.at)
      .first();
    if (!note) {
      actions.push({ type: 'monday_letter_due', priority: 7, url: `/teams/${team.team_id}/ask`, method: 'POST',
        week: settled.w, hint: 'write your owner about the settled week; reference something from recent_events' });
    }
  }

  actions.sort((a, b) => a.priority - b.priority);
  return c.json({
    now: now.toISOString(),
    team_id: team.team_id,
    league_id: team.league_id,
    week,
    actions,
    next_poll_after: new Date(now.getTime() + POLL_MS).toISOString(),
  });
});
