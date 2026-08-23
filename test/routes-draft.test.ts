import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { starterDeficit } from '../src/engine/draft';
import { app } from '../src/index';
import { sweepDraft } from '../src/routes/draft';
import { nflRosterShape } from '../src/sport/nfl';
import { authed, fillLeague, seedWire, type TestAgent } from './helpers';

type Member = TestAgent & { teamId: string };

async function draftState(leagueId: string) {
  const res = await app.request(`/leagues/${leagueId}/draft`, {}, env);
  return res.json<{
    status: string;
    picks_made: number;
    on_clock: { pick: number; team_id: string; deadline: string } | null;
    board_top: { player_id: string; name: string | null; position: string }[];
    recent_picks: { pick: number; player_id: string; auto: boolean; note: string | null }[];
  }>();
}

function memberFor(members: Member[], teamId: string): Member {
  const m = members.find((x) => x.teamId === teamId);
  if (!m) throw new Error(`no member for team ${teamId}`);
  return m;
}

describe('draft routes', () => {
  beforeAll(async () => {
    await seedWire();
  });

  it('runs picks in snake order with notes, guards, and idempotent retries', async () => {
    const { leagueId, members } = await fillLeague('Drafty');

    const s0 = await draftState(leagueId);
    expect(s0.status).toBe('drafting');
    expect(s0.on_clock).not.toBeNull();
    expect(s0.board_top.length).toBeGreaterThanOrEqual(25);
    expect(s0.board_top[0]?.name).toBeTruthy(); // joined against players table
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      expect(s0.board_top.some((b) => b.position === pos), `${pos} on board`).toBe(true);
    }

    const first = memberFor(members, s0.on_clock!.team_id);
    const firstPlayer = s0.board_top[0]!.player_id;

    // Wrong team tries to pick.
    const wrong = members.find((m) => m.teamId !== first.teamId)!;
    const notYourTurn = await authed(`/leagues/${leagueId}/draft/pick`, wrong.apiKey, {
      method: 'POST',
      body: JSON.stringify({ player_id: firstPlayer }),
    });
    expect(notYourTurn.status).toBe(409);
    expect((await notYourTurn.json<{ code: string }>()).code).toBe('NOT_YOUR_TURN');

    // Rightful pick with a link-laced note.
    const pick1 = await authed(`/leagues/${leagueId}/draft/pick`, first.apiKey, {
      method: 'POST',
      body: JSON.stringify({
        player_id: firstPlayer,
        note: 'Best board value. Proof: https://example.com/spam',
      }),
    });
    expect(pick1.status).toBe(201);
    const pick1Body = await pick1.json<{ pick: number; note: string }>();
    expect(pick1Body.pick).toBe(1);
    expect(pick1Body.note).toContain('[link removed]');
    expect(pick1Body.note).not.toContain('https://');

    // Retrying the same pick is a success replay, not an error.
    const retry = await authed(`/leagues/${leagueId}/draft/pick`, first.apiKey, {
      method: 'POST',
      body: JSON.stringify({ player_id: firstPlayer }),
    });
    expect(retry.status).toBe(200);
    expect((await retry.json<{ already_made: boolean }>()).already_made).toBe(true);

    // Someone else taking the same player is a conflict with a useful hint.
    const s1 = await draftState(leagueId);
    const second = memberFor(members, s1.on_clock!.team_id);
    const taken = await authed(`/leagues/${leagueId}/draft/pick`, second.apiKey, {
      method: 'POST',
      body: JSON.stringify({ player_id: firstPlayer }),
    });
    expect(taken.status).toBe(409);
    expect((await taken.json<{ code: string }>()).code).toBe('PLAYER_TAKEN');

    // Unknown player and oversized/blocked notes are rejected.
    const ghost = await authed(`/leagues/${leagueId}/draft/pick`, second.apiKey, {
      method: 'POST',
      body: JSON.stringify({ player_id: 'nfl:ghost' }),
    });
    expect((await ghost.json<{ code: string }>()).code).toBe('PLAYER_UNKNOWN');
    const longNote = await authed(`/leagues/${leagueId}/draft/pick`, second.apiKey, {
      method: 'POST',
      body: JSON.stringify({ player_id: s1.board_top[0]!.player_id, note: 'x'.repeat(281) }),
    });
    expect((await longNote.json<{ code: string }>()).code).toBe('NOTE_TOO_LONG');
    const blocked = await authed(`/leagues/${leagueId}/draft/pick`, second.apiKey, {
      method: 'POST',
      body: JSON.stringify({ player_id: s1.board_top[0]!.player_id, note: 'this pick is fucking elite' }),
    });
    expect((await blocked.json<{ code: string }>()).code).toBe('NOTE_BLOCKED');

    // Board shrinks and picks advance.
    const s2 = await draftState(leagueId);
    expect(s2.picks_made).toBe(1);
    expect(s2.board_top.map((b) => b.player_id)).not.toContain(firstPlayer);
  });

  it('sweepDraft autocompletes an abandoned draft and finalizes the league', async () => {
    const { leagueId, members } = await fillLeague('Ghosted');

    // One human pick, then everyone disappears.
    const s0 = await draftState(leagueId);
    const first = memberFor(members, s0.on_clock!.team_id);
    await authed(`/leagues/${leagueId}/draft/pick`, first.apiKey, {
      method: 'POST',
      body: JSON.stringify({ player_id: s0.board_top[0]!.player_id }),
    });

    // Far-future sweeps: capped per call, so loop until done.
    const far = Date.now() + 100 * 3600_000;
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const applied = await sweepDraft(env.DB, leagueId, far);
      total += applied;
      if (applied === 0) break;
    }
    expect(total).toBe(119);

    const done = await draftState(leagueId);
    expect(done.status).toBe('active');
    expect(done.picks_made).toBe(120);
    expect(done.on_clock).toBeNull();
    expect(done.recent_picks.every((p) => p.auto)).toBe(true);

    // Every roster: 12 players, startable.
    for (const m of members) {
      const roster = await env.DB.prepare(
        `SELECT p.position FROM rosters r JOIN players p ON p.id = r.player_id WHERE r.team_id = ?`,
      )
        .bind(m.teamId)
        .all<{ position: string }>();
      expect(roster.results).toHaveLength(12);
      expect(starterDeficit(nflRosterShape, roster.results.map((r) => r.position))).toBe(0);
    }

    // Matchup slate exists: 70 rows, weeks 1..14.
    const matchups = await app.request(`/leagues/${leagueId}/matchups`, {}, env);
    const { matchups: rows } = await matchups.json<{ matchups: { week: number }[] }>();
    expect(rows).toHaveLength(70);
    expect(new Set(rows.map((r) => r.week)).size).toBe(14);

    // Draft over: further picks are refused.
    const late = await authed(`/leagues/${leagueId}/draft/pick`, first.apiKey, {
      method: 'POST',
      body: JSON.stringify({ player_id: 'nfl:p001' }),
    });
    expect((await late.json<{ code: string }>()).code).toBe('DRAFT_COMPLETE');
  });

  it('refuses picks while the league is still forming', async () => {
    const { members } = await (async () => {
      // Two members only — league stays forming.
      const a = await import('./helpers');
      const m1 = await a.registerAgent('Early');
      const r1 = await authed('/leagues/join', m1.apiKey, { method: 'POST' });
      const b1 = await r1.json<{ league_id: string; team_id: string }>();
      return { members: [{ ...m1, teamId: b1.team_id, leagueId: b1.league_id }] };
    })();
    const m = members[0]!;
    const res = await authed(`/leagues/${(m as { leagueId: string }).leagueId}/draft/pick`, m.apiKey, {
      method: 'POST',
      body: JSON.stringify({ player_id: 'nfl:p001' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json<{ code: string }>()).code).toBe('DRAFT_NOT_OPEN');
  });
});
