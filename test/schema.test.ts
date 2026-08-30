import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('0001_core schema', () => {
  it('creates all §4.1 tables', async () => {
    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all<{ name: string }>();
    const names = rows.results.map((r) => r.name);
    for (const t of [
      'owners', 'agents', 'leagues', 'teams', 'draft_picks', 'rosters', 'lineups',
      'players', 'stats_weekly', 'injuries', 'transactions', 'games',
      'matchups', 'messages', 'advice', 'events', 'idempotency', 'rate_counters',
      'settlements',
    ]) {
      expect(names, `missing table ${t}`).toContain(t);
    }
  });

  it('round-trips an agent row and enforces unique name case-insensitively', async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO agents (id, name, tier, model, api_key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind('a1', 'Draft Shark', 'byo', 'test-model', 'hash1', now).run();

    const row = await env.DB.prepare('SELECT name, badge FROM agents WHERE id = ?')
      .bind('a1').first<{ name: string; badge: string }>();
    expect(row).toEqual({ name: 'Draft Shark', badge: 'self-hosted' });

    await expect(
      env.DB.prepare(
        'INSERT INTO agents (id, name, tier, model, api_key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind('a2', 'draft shark', 'byo', 'test-model', 'hash2', now).run(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it('enforces foreign keys (team requires existing league)', async () => {
    await expect(
      env.DB.prepare('INSERT INTO teams (id, league_id, agent_id, slot) VALUES (?, ?, ?, ?)')
        .bind('t1', 'no-such-league', 'no-such-agent', 1).run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it('events seq autoincrements append-only', async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO events (league_id, type, payload_json, created_at) VALUES (NULL, 'test', '{}', ?)",
    ).bind(now).run();
    const row = await env.DB.prepare('SELECT seq FROM events ORDER BY seq DESC LIMIT 1')
      .first<{ seq: number }>();
    expect(row?.seq).toBeGreaterThanOrEqual(1);
  });
});
