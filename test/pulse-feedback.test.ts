// GET /pulse (heartbeat manifest) + POST /feedback + the self-declared model
// tag + word-boundary truncation.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { cleanText } from '../src/hosted/llm';
import { sweepDraft } from '../src/routes/draft';
import { authed, fillLeague, futureKickoffOffset, registerAgent, seedWire, type TestAgent } from './helpers';

type Member = TestAgent & { teamId: string };
let leagueId = '';
let members: Member[] = [];

beforeAll(async () => {
  await seedWire({ games: true, season: 2026, kickoffOffsetMs: futureKickoffOffset() });
  const league = await fillLeague('Pulse');
  leagueId = league.leagueId;
  members = league.members;
});

describe('GET /pulse', () => {
  it('requires auth; a teamless agent is told to join', async () => {
    expect((await app.request('/pulse', {}, env)).status).toBe(401);
    const lone = await registerAgent('Loner');
    const res = await authed('/pulse', lone.apiKey);
    const body = await res.json<{ team_id: string | null; actions: { type: string }[]; next_poll_after: string }>();
    expect(body.team_id).toBeNull();
    expect(body.actions[0]!.type).toBe('join_league');
    expect(Date.parse(body.next_poll_after)).toBeGreaterThan(Date.now());
  });

  it('during the draft it names the clock only for the team on it', async () => {
    // Force the draft open (deadline math forces status via sweep with future "now").
    await sweepDraft(env.DB, leagueId, Date.now() + 1000 * 3600_000); // autopicks a batch; leaves someone on the clock
    const state = await (await app.request(`/leagues/${leagueId}/draft`, {}, env)).json<{ status: string; on_clock: { team_id: string } | null }>();
    if (state.status === 'drafting' && state.on_clock) {
      const onClock = members.find((m) => m.teamId === state.on_clock!.team_id)!;
      const other = members.find((m) => m.teamId !== state.on_clock!.team_id)!;
      const a = await (await authed('/pulse', onClock.apiKey)).json<{ actions: { type: string; deadline?: string }[] }>();
      expect(a.actions[0]!.type).toBe('draft_pick');
      expect(a.actions[0]!.deadline).toBeTruthy();
      const b = await (await authed('/pulse', other.apiKey)).json<{ actions: { type: string }[] }>();
      expect(b.actions[0]!.type).toBe('draft_waiting');
    }
    while ((await sweepDraft(env.DB, leagueId, Date.now() + 1000 * 3600_000)) > 0) { /* finish */ }
  });

  it('in season: lineup holes, then pending advice blocks, ordered by priority', async () => {
    const me = members[0]!;
    const before = await (await authed('/pulse', me.apiKey)).json<{ week: number; actions: { type: string; empty_slots?: string[] }[] }>();
    expect(before.week).toBe(1);
    const holes = before.actions.find((a) => a.type === 'lineup_incomplete');
    expect(holes?.empty_slots).toContain('QB');
    // Leave advice as the owner and age it past the grace window.
    const owner = await env.DB.prepare('SELECT owner_id FROM agents WHERE id = ?').bind(me.agentId).first<{ owner_id: string }>();
    await env.DB.prepare(
      "INSERT INTO advice (id, team_id, owner_id, body, agent_response_msg_id, created_at) VALUES ('adv-pulse', ?, ?, 'start the rookie', NULL, ?)",
    ).bind(me.teamId, owner!.owner_id, new Date(Date.now() - 3600_000).toISOString()).run();
    const after = await (await authed('/pulse', me.apiKey)).json<{ actions: { type: string; priority: number; blocks?: string[] }[] }>();
    expect(after.actions[0]!.type).toBe('advice_pending');
    expect(after.actions[0]!.blocks).toContain('lineup');
    const priorities = after.actions.map((a) => a.priority);
    expect([...priorities].sort((x, y) => x - y)).toEqual(priorities);
  });
});

describe('POST /feedback', () => {
  it('moderated, capped, stored as an event, never published', async () => {
    const me = members[1]!;
    const ok = await authed('/feedback', me.apiKey, { method: 'POST', body: JSON.stringify({ body: 'the pulse endpoint is great', category: 'api' }) });
    expect(ok.status).toBe(201);
    const row = await env.DB.prepare("SELECT payload_json FROM events WHERE type = 'feedback' ORDER BY seq DESC LIMIT 1").first<{ payload_json: string }>();
    expect(JSON.parse(row!.payload_json).body).toContain('pulse endpoint');
    const blocked = await authed('/feedback', me.apiKey, { method: 'POST', body: JSON.stringify({ body: 'this fucking api' }) });
    expect(blocked.status).toBe(422);
    expect((await app.request('/feedback', { method: 'POST', body: '{}' }, env)).status).toBe(401);
    const home = await (await app.request('/', {}, env)).text();
    expect(home).not.toContain('pulse endpoint is great'); // feedback never renders
    expect(home).toContain('mailto:'); // humans get a contact link
  });
});

describe('model tag + truncation polish', () => {
  it('BYO agents render as self-declared', async () => {
    const html = await (await app.request(`/t/${members[2]!.teamId}`, {}, env)).text();
    expect(html).toContain('self-declared');
  });
  it('cleanText cuts on a word boundary with an ellipsis', () => {
    const long = 'one glittering fantasy sentence that keeps going '.repeat(8);
    const out = cleanText(long, 60)!;
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith('…')).toBe(true);
    const kept = out.slice(0, -1); // text before the ellipsis
    expect(long.startsWith(kept)).toBe(true);
    expect(long.charAt(kept.length)).toBe(' '); // the cut landed on a word boundary, never mid-word
  });
});
