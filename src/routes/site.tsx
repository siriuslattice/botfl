// Public site routes (SPEC §3.7) — SSR HTML over the same D1 data the JSON
// API serves. HTML lives under /l /t /m + / and /agents; the JSON API keeps
// its existing paths.

import { Hono, type Context } from 'hono';
import skillMd from '../../skill.md';
import { draftConfig, nextPick, pickDeadline, totalPicks } from '../engine/draft';
import { settleMatchup, standings, type SettledMatchup } from '../engine/settlement';
import { getSportAdapter } from '../sport';
import type { StatLine } from '../sport/adapter';
import {
  AgentsPage,
  DraftPage,
  HomePage,
  LeaguePage,
  MatchupPage,
  TeamPage,
  type FeedEvent,
  type MatchupRowView,
  type MatchupSideView,
  type RosterRowView,
  type StandingsRowView,
} from '../render/pages';
import { loadBoard, sweepDraft } from './draft';
import { jsonError, type AppEnv } from './util';

export const siteRoutes = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

function page(c: Ctx, el: unknown): Response {
  return c.html(`<!doctype html>${el}`);
}

function fmt(n: number | null): string | null {
  return n === null ? null : n.toFixed(2);
}

// --- event feed enrichment -------------------------------------------------

interface EventRow {
  league_id: string | null;
  type: string;
  payload_json: string;
  created_at: string;
}

async function nameMaps(db: D1Database, rows: EventRow[]) {
  const teamIds = new Set<string>();
  const playerIds = new Set<string>();
  const payloads = rows.map((r) => {
    const p = JSON.parse(r.payload_json) as Record<string, unknown>;
    if (typeof p.team_id === 'string') teamIds.add(p.team_id);
    if (typeof p.player_id === 'string') playerIds.add(p.player_id);
    return p;
  });
  const teams = new Map<string, string>();
  if (teamIds.size > 0) {
    const ids = [...teamIds];
    const rs = await db
      .prepare(
        `SELECT t.id, a.name FROM teams t JOIN agents a ON a.id = t.agent_id
         WHERE t.id IN (${ids.map(() => '?').join(',')})`,
      )
      .bind(...ids)
      .all<{ id: string; name: string }>();
    for (const r of rs.results) teams.set(r.id, r.name);
  }
  const players = new Map<string, string>();
  if (playerIds.size > 0) {
    const ids = [...playerIds];
    const rs = await db
      .prepare(`SELECT id, name FROM players WHERE id IN (${ids.map(() => '?').join(',')})`)
      .bind(...ids)
      .all<{ id: string; name: string }>();
    for (const r of rs.results) players.set(r.id, r.name);
  }
  return { payloads, teams, players };
}

export async function enrichEvents(db: D1Database, rows: EventRow[]): Promise<FeedEvent[]> {
  const { payloads, teams, players } = await nameMaps(db, rows);
  const out: FeedEvent[] = [];
  rows.forEach((r, i) => {
    const p = payloads[i]!;
    const team = typeof p.team_id === 'string' ? (teams.get(p.team_id) ?? 'a team') : 'a team';
    const player = typeof p.player_id === 'string' ? (players.get(p.player_id) ?? p.player_id) : '';
    let line: string | null = null;
    switch (r.type) {
      case 'league_created':
        line = `${String(p.name ?? 'A league')} formed — seats open`;
        break;
      case 'team_joined':
        line = `${String(p.agent ?? 'an agent')} claimed a seat`;
        break;
      case 'league_full':
        line = 'league is full — draft slots assigned';
        break;
      case 'draft_opened':
        line = 'the draft is open';
        break;
      case 'draft_pick': {
        const note = typeof p.note === 'string' ? ` — “${p.note.slice(0, 140)}”` : '';
        line = `${team} drafted ${player}${note}`;
        break;
      }
      case 'draft_autopick':
        line = `${team} auto-drafted ${player} (clock expired)`;
        break;
      case 'draft_complete':
        line = `draft complete — ${String(p.picks ?? '?')} picks in the books`;
        break;
      case 'lineup_submitted':
        line = `${team} updated ${Array.isArray(p.changed) ? p.changed.length : '?'} lineup slot(s) for week ${String(p.week ?? '?')}`;
        break;
      case 'week_settled':
        line = `week ${String(p.week ?? '?')} is final`;
        break;
      case 'agent_registered':
        line = `${String(p.name ?? 'an agent')} registered (${String(p.model ?? 'model undisclosed')})`;
        break;
      case 'news':
        line = String(p.headline ?? '');
        break;
      default:
        line = null; // wire_synced and internals stay off the feed
    }
    if (line) out.push({ line, at: r.created_at, league_id: r.league_id });
  });
  return out;
}

async function recentEvents(db: D1Database, where: string, binds: unknown[], limit = 30): Promise<FeedEvent[]> {
  const rows = await db
    .prepare(
      `SELECT league_id, type, payload_json, created_at FROM events ${where} ORDER BY seq DESC LIMIT ${limit}`,
    )
    .bind(...binds)
    .all<EventRow>();
  return enrichEvents(db, rows.results);
}

// --- pages -----------------------------------------------------------------

siteRoutes.get('/', async (c) => {
  const leagues = await c.env.DB.prepare(
    `SELECT l.id, l.name, l.status, (SELECT COUNT(*) FROM teams t WHERE t.league_id = l.id) AS teams
     FROM leagues l ORDER BY l.created_at DESC LIMIT 25`,
  ).all<{ id: string; name: string; status: string; teams: number }>();
  const events = await recentEvents(c.env.DB, '', []);
  const counts = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM agents) AS agents,
            (SELECT COUNT(*) FROM leagues) AS leagues,
            (SELECT COUNT(*) FROM draft_picks) AS picks`,
  ).first<{ agents: number; leagues: number; picks: number }>();
  const stats = {
    agents: counts?.agents ?? 0,
    leagues: counts?.leagues ?? 0,
    picks: counts?.picks ?? 0,
    liveDraftLeagueId: leagues.results.find((l) => l.status === 'drafting')?.id ?? null,
  };
  return page(c, <HomePage leagues={leagues.results} events={events} stats={stats} />);
});

siteRoutes.get('/agents', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT a.name, a.model, a.badge, t.id AS teamId, l.name AS league
     FROM agents a
     LEFT JOIN teams t ON t.agent_id = a.id
     LEFT JOIN leagues l ON l.id = t.league_id
     ORDER BY a.created_at DESC LIMIT 200`,
  ).all<{ name: string; model: string; badge: string; teamId: string | null; league: string | null }>();
  return page(c, <AgentsPage agents={rows.results} />);
});

siteRoutes.get('/l/:id', async (c) => {
  const db = c.env.DB;
  const league = await db
    .prepare('SELECT id, name, status, draft_opens_at, sport, season FROM leagues WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ id: string; name: string; status: string; draft_opens_at: string | null; sport: string; season: number }>();
  if (!league) return jsonError(c, 404, 'LEAGUE_NOT_FOUND', 'no such league');

  const teams = await db
    .prepare(
      `SELECT t.id, a.name, a.model, a.badge FROM teams t JOIN agents a ON a.id = t.agent_id
       WHERE t.league_id = ? ORDER BY t.slot ASC`,
    )
    .bind(league.id)
    .all<{ id: string; name: string; model: string; badge: string }>();
  const teamName = new Map(teams.results.map((t) => [t.id, t]));

  const matchups = await db
    .prepare(
      'SELECT id, week, home_team_id, away_team_id, home_score, away_score, settled_at FROM matchups WHERE league_id = ? ORDER BY week ASC',
    )
    .bind(league.id)
    .all<{
      id: string; week: number; home_team_id: string; away_team_id: string;
      home_score: number | null; away_score: number | null; settled_at: string | null;
    }>();

  const settled: SettledMatchup[] = matchups.results
    .filter((m) => m.settled_at !== null)
    .map((m) => settleMatchup(m.home_team_id, m.away_team_id, m.home_score ?? 0, m.away_score ?? 0));
  const table = standings(teams.results.map((t) => t.id), settled);
  const standingsView: StandingsRowView[] = table.map((r) => {
    const t = teamName.get(r.teamId);
    return {
      rank: r.rank,
      teamId: r.teamId,
      name: t?.name ?? '?',
      model: t?.model ?? '?',
      badge: t?.badge ?? '',
      record: `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''}`,
      pf: r.pointsFor.toFixed(2),
      pa: r.pointsAgainst.toFixed(2),
    };
  });
  const matchupViews: MatchupRowView[] = matchups.results.map((m) => ({
    id: m.id,
    week: m.week,
    home: teamName.get(m.home_team_id)?.name ?? '?',
    away: teamName.get(m.away_team_id)?.name ?? '?',
    score:
      m.settled_at !== null ? `${(m.away_score ?? 0).toFixed(2)}–${(m.home_score ?? 0).toFixed(2)}` : null,
  }));
  const events = await recentEvents(c.env.DB, 'WHERE league_id = ?', [league.id]);
  return page(c, <LeaguePage league={league} standings={standingsView} matchups={matchupViews} events={events} />);
});

siteRoutes.get('/l/:id/draft', async (c) => {
  const db = c.env.DB;
  const leagueId = c.req.param('id');
  await sweepDraft(db, leagueId, Date.now());
  const league = await db
    .prepare('SELECT id, name, status, draft_opens_at, sport, season FROM leagues WHERE id = ?')
    .bind(leagueId)
    .first<{ id: string; name: string; status: string; draft_opens_at: string | null; sport: string }>();
  if (!league) return jsonError(c, 404, 'LEAGUE_NOT_FOUND', 'no such league');
  const adapter = getSportAdapter(league.sport);
  const cfg = draftConfig(10, adapter.rosterShape);

  const teams = await db
    .prepare(
      `SELECT t.id, t.slot, a.name FROM teams t JOIN agents a ON a.id = t.agent_id
       WHERE t.league_id = ? ORDER BY t.slot ASC`,
    )
    .bind(leagueId)
    .all<{ id: string; slot: number; name: string }>();
  const picks = await db
    .prepare(
      `SELECT d.pick, d.round, d.team_id, d.note, d.auto, d.created_at, p.name AS player, p.position
       FROM draft_picks d JOIN players p ON p.id = d.player_id
       WHERE d.league_id = ? ORDER BY d.pick DESC`,
    )
    .bind(leagueId)
    .all<{ pick: number; round: number; team_id: string; note: string | null; auto: number; created_at: string; player: string; position: string }>();
  const byId = new Map(teams.results.map((t) => [t.id, t]));

  let onClock: { team: string; teamId: string; pick: number; deadline: string } | null = null;
  if (league.status === 'drafting') {
    const next = nextPick(cfg, picks.results.length);
    if (next) {
      const team = teams.results[next.teamSlot - 1];
      const last = picks.results[0];
      const deadline = pickDeadline(
        cfg,
        Date.parse(league.draft_opens_at ?? ''),
        last ? Date.parse(last.created_at) : null,
      );
      if (team) {
        onClock = { team: team.name, teamId: team.id, pick: next.overall, deadline: new Date(deadline).toISOString() };
      }
    }
  }

  const takenRows = await db
    .prepare('SELECT player_id FROM draft_picks WHERE league_id = ?')
    .bind(leagueId)
    .all<{ player_id: string }>();
  const taken = new Set(takenRows.results.map((r) => r.player_id));
  const boardEntries = (await loadBoard(db, league.sport))
    .filter((e) => !taken.has(e.playerId))
    .slice(0, 15);
  const boardIds = boardEntries.map((e) => e.playerId);
  const names = new Map<string, string>();
  if (boardIds.length > 0) {
    const rs = await db
      .prepare(`SELECT id, name FROM players WHERE id IN (${boardIds.map(() => '?').join(',')})`)
      .bind(...boardIds)
      .all<{ id: string; name: string }>();
    for (const r of rs.results) names.set(r.id, r.name);
  }

  return page(
    c,
    <DraftPage
      league={league}
      picksMade={picks.results.length}
      totalPicks={totalPicks(cfg)}
      onClock={onClock}
      picks={picks.results.map((p) => ({
        pick: p.pick,
        round: p.round,
        team: byId.get(p.team_id)?.name ?? '?',
        teamId: p.team_id,
        player: p.player,
        position: p.position,
        note: p.note,
        auto: p.auto === 1,
      }))}
      board={boardEntries.map((e) => ({ name: names.get(e.playerId) ?? e.playerId, position: e.position, adp: e.adp }))}
    />,
  );
});

siteRoutes.get('/t/:id', async (c) => {
  const db = c.env.DB;
  const team = await db
    .prepare(
      `SELECT t.id, t.league_id, l.name AS league_name, l.season, a.name, a.model, a.badge
       FROM teams t JOIN leagues l ON l.id = t.league_id JOIN agents a ON a.id = t.agent_id
       WHERE t.id = ?`,
    )
    .bind(c.req.param('id'))
    .first<{ id: string; league_id: string; league_name: string; season: number; name: string; model: string; badge: string }>();
  if (!team) return jsonError(c, 404, 'TEAM_NOT_FOUND', 'no such team');

  const weekRow = await db
    .prepare('SELECT MIN(week) AS week FROM matchups WHERE league_id = ? AND settled_at IS NULL')
    .bind(team.league_id)
    .first<{ week: number | null }>();
  const week = weekRow?.week ?? 1;

  const roster = await db
    .prepare(
      `SELECT r.player_id, p.name, p.position, p.team AS club, i.status AS injury
       FROM rosters r JOIN players p ON p.id = r.player_id
       LEFT JOIN injuries i ON i.player_id = r.player_id
       WHERE r.team_id = ? ORDER BY p.position, p.name`,
    )
    .bind(team.id)
    .all<{ player_id: string; name: string; position: string; club: string | null; injury: string | null }>();
  const lineup = await db
    .prepare('SELECT slot, player_id FROM lineups WHERE team_id = ? AND week = ?')
    .bind(team.id, week)
    .all<{ slot: string; player_id: string | null }>();
  const slotOf = new Map<string, string>();
  for (const l of lineup.results) if (l.player_id) slotOf.set(l.player_id, l.slot);

  const rosterView: RosterRowView[] = roster.results
    .map((r) => ({
      player: r.name,
      position: r.position,
      club: r.club,
      slot: slotOf.get(r.player_id) ?? null,
      injury: r.injury,
    }))
    .sort((a, b) => (a.slot === null ? 1 : 0) - (b.slot === null ? 1 : 0));

  const events = await recentEvents(db, "WHERE league_id = ? AND payload_json LIKE '%' || ? || '%'", [
    team.league_id,
    team.id,
  ], 15);

  return page(
    c,
    <TeamPage
      team={{ id: team.id, leagueId: team.league_id, leagueName: team.league_name }}
      agent={{ name: team.name, model: team.model, badge: team.badge }}
      week={week}
      roster={rosterView}
      events={events}
    />,
  );
});

siteRoutes.get('/m/:id', async (c) => {
  const db = c.env.DB;
  const m = await db
    .prepare(
      `SELECT m.id, m.week, m.settled_at, m.home_team_id, m.away_team_id, m.home_score, m.away_score,
              l.id AS league_id, l.name AS league_name, l.sport, l.season
       FROM matchups m JOIN leagues l ON l.id = m.league_id WHERE m.id = ?`,
    )
    .bind(c.req.param('id'))
    .first<{
      id: string; week: number; settled_at: string | null;
      home_team_id: string; away_team_id: string; home_score: number | null; away_score: number | null;
      league_id: string; league_name: string; sport: string; season: number;
    }>();
  if (!m) return jsonError(c, 404, 'MATCHUP_NOT_FOUND', 'no such matchup');
  const adapter = getSportAdapter(m.sport);

  async function side(teamId: string, score: number | null): Promise<MatchupSideView> {
    const agent = await db
      .prepare('SELECT a.name, a.model FROM teams t JOIN agents a ON a.id = t.agent_id WHERE t.id = ?')
      .bind(teamId)
      .first<{ name: string; model: string }>();
    const lineup = await db
      .prepare('SELECT slot, player_id FROM lineups WHERE team_id = ? AND week = ?')
      .bind(teamId, m!.week)
      .all<{ slot: string; player_id: string | null }>();
    const bySlot = new Map(lineup.results.map((l) => [l.slot, l.player_id]));
    const playerIds = lineup.results.map((l) => l.player_id).filter((p): p is string => p !== null);
    const names = new Map<string, string>();
    const stats = new Map<string, StatLine>();
    if (playerIds.length > 0) {
      const ph = playerIds.map(() => '?').join(',');
      const nameRows = await db
        .prepare(`SELECT id, name FROM players WHERE id IN (${ph})`)
        .bind(...playerIds)
        .all<{ id: string; name: string }>();
      for (const r of nameRows.results) names.set(r.id, r.name);
      if (m!.settled_at) {
        const statRows = await db
          .prepare(`SELECT player_id, stat_json FROM stats_weekly WHERE season = ? AND week = ? AND player_id IN (${ph})`)
          .bind(m!.season, m!.week, ...playerIds)
          .all<{ player_id: string; stat_json: string }>();
        for (const r of statRows.results) stats.set(r.player_id, JSON.parse(r.stat_json) as StatLine);
      }
    }
    return {
      teamId,
      name: agent?.name ?? '?',
      model: agent?.model ?? '?',
      score: fmt(m!.settled_at ? score : null),
      slots: adapter.rosterShape.starters.map((s) => {
        const pid = bySlot.get(s.key) ?? null;
        const stat = pid ? stats.get(pid) : undefined;
        return {
          slot: s.key,
          player: pid ? (names.get(pid) ?? pid) : null,
          points: m!.settled_at ? (stat ? adapter.scoreStatLine(stat).toFixed(2) : '0.00') : null,
        };
      }),
    };
  }

  return page(
    c,
    <MatchupPage
      leagueId={m.league_id}
      leagueName={m.league_name}
      week={m.week}
      settled={m.settled_at !== null}
      home={await side(m.home_team_id, m.home_score)}
      away={await side(m.away_team_id, m.away_score)}
    />,
  );
});

siteRoutes.get('/skill.md', (c) =>
  c.text(skillMd, 200, { 'content-type': 'text/markdown; charset=utf-8' }),
);
