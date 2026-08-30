// Card endpoints (SPEC §3.7): PNG share cards, generated on demand and cached
// in R2 when the CARDS binding exists (all three card subjects are immutable
// once eligible, so cached objects never invalidate). Without the binding the
// cards still render — just uncached.

import { Hono } from 'hono';
import { bumpDailyCounter } from '../cron/metrics';
import { adviceCard, matchupCard, pickCard } from '../render/cards';
import { svgToPng } from '../render/cardgen';
import { jsonError, type AppEnv } from './util';

export const cardsRoutes = new Hono<AppEnv>();

const PNG_HEADERS = {
  'content-type': 'image/png',
  'cache-control': 'public, max-age=86400, immutable',
};

async function servePng(env: Env, key: string, build: () => string): Promise<Response> {
  // §7: generated vs fetched is the share proxy the kill-criteria eval reads.
  await bumpDailyCounter(env.DB, 'metric:cards_fetched');
  if (env.CARDS) {
    const cached = await env.CARDS.get(key);
    if (cached) return new Response(cached.body, { headers: PNG_HEADERS });
  }
  const png = await svgToPng(build());
  await bumpDailyCounter(env.DB, 'metric:cards_generated');
  if (env.CARDS) {
    await env.CARDS.put(key, png, { httpMetadata: { contentType: 'image/png' } });
  }
  return new Response(png as unknown as BodyInit, { headers: PNG_HEADERS });
}

cardsRoutes.get('/cards/matchup/:id{.+\\.png}', async (c) => {
  const id = c.req.param('id').replace(/\.png$/, '');
  const m = await c.env.DB.prepare(
    `SELECT m.week, m.home_score, m.away_score, m.settled_at, l.name AS league,
            ha.name AS home_name, ha.model AS home_model,
            aa.name AS away_name, aa.model AS away_model
     FROM matchups m
     JOIN leagues l ON l.id = m.league_id
     JOIN teams ht ON ht.id = m.home_team_id JOIN agents ha ON ha.id = ht.agent_id
     JOIN teams at ON at.id = m.away_team_id JOIN agents aa ON aa.id = at.agent_id
     WHERE m.id = ?`,
  )
    .bind(id)
    .first<{
      week: number; home_score: number | null; away_score: number | null; settled_at: string | null;
      league: string; home_name: string; home_model: string; away_name: string; away_model: string;
    }>();
  if (!m) return jsonError(c, 404, 'MATCHUP_NOT_FOUND', 'no such matchup');
  if (!m.settled_at) return jsonError(c, 404, 'NOT_SETTLED', 'cards render after Tuesday settlement');
  return servePng(c.env, `matchup/${id}.png`, () =>
    matchupCard({
      leagueName: m.league,
      week: m.week,
      home: { name: m.home_name, model: m.home_model, score: m.home_score ?? 0 },
      away: { name: m.away_name, model: m.away_model, score: m.away_score ?? 0 },
    }),
  );
});

cardsRoutes.get('/cards/pick/:league/:pick{[0-9]+\\.png}', async (c) => {
  const leagueId = c.req.param('league');
  const pickNo = Number(c.req.param('pick').replace(/\.png$/, ''));
  const p = await c.env.DB.prepare(
    `SELECT d.round, d.pick, d.note, d.auto, l.name AS league,
            a.name AS team_name, a.model, pl.name AS player, pl.position
     FROM draft_picks d
     JOIN leagues l ON l.id = d.league_id
     JOIN teams t ON t.id = d.team_id JOIN agents a ON a.id = t.agent_id
     JOIN players pl ON pl.id = d.player_id
     WHERE d.league_id = ? AND d.pick = ?`,
  )
    .bind(leagueId, pickNo)
    .first<{
      round: number; pick: number; note: string | null; auto: number; league: string;
      team_name: string; model: string; player: string; position: string;
    }>();
  if (!p) return jsonError(c, 404, 'PICK_NOT_FOUND', 'no such pick');
  return servePng(c.env, `pick/${leagueId}/${pickNo}.png`, () =>
    pickCard({
      leagueName: p.league,
      round: p.round,
      pick: p.pick,
      team: { name: p.team_name, model: p.model },
      player: { name: p.player, position: p.position },
      note: p.note,
      auto: p.auto === 1,
    }),
  );
});

cardsRoutes.get('/cards/advice/:id{.+\\.png}', async (c) => {
  const id = c.req.param('id').replace(/\.png$/, '');
  const a = await c.env.DB.prepare(
    `SELECT ad.body AS advice, m.body AS response, l.name AS league,
            ag.name AS agent_name, ag.model,
            (SELECT payload_json FROM events
             WHERE type = 'advice_answered' AND payload_json LIKE '%' || ad.team_id || '%'
             ORDER BY seq DESC LIMIT 1) AS answered_payload
     FROM advice ad
     JOIN messages m ON m.id = ad.agent_response_msg_id AND m.held = 0 AND m.hidden = 0
     JOIN teams t ON t.id = ad.team_id
     JOIN leagues l ON l.id = t.league_id
     JOIN agents ag ON ag.id = t.agent_id
     WHERE ad.id = ?`,
  )
    .bind(id)
    .first<{ advice: string; response: string; league: string; agent_name: string; model: string; answered_payload: string | null }>();
  if (!a) return jsonError(c, 404, 'ADVICE_NOT_FOUND', 'card renders once the agent has responded');
  let stance: string | null = null;
  if (a.answered_payload) {
    stance = ((JSON.parse(a.answered_payload) as { stance?: string }).stance ?? null);
  }
  return servePng(c.env, `advice/${id}.png`, () =>
    adviceCard({
      leagueName: a.league,
      agent: { name: a.agent_name, model: a.model },
      advice: a.advice.slice(0, 220),
      response: a.response.slice(0, 220),
      stance,
    }),
  );
});
