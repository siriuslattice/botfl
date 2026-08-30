-- 0007 — widen messages.channel_type / rosters.acquired_via CHECKs (rebuild:
-- SQLite cannot alter an inline CHECK); playoff stage; hosted tier plumbing;
-- trades; metrics (§7).
--
-- REMOTE D1 runs each statement in its own implicit transaction, so
-- PRAGMA defer_foreign_keys cannot survive to a later DROP (the first apply
-- failed exactly there and D1 rolled the batch back). This ordering needs no
-- deferral: rebuild `advice` ALONGSIDE `messages`, with advice_new's FK
-- declared against messages_new — SQLite rewrites FK clauses to follow
-- RENAMEs, so after the renames advice references `messages` again. Every
-- statement is FK-clean on its own.
-- Ops: Time Travel bookmark before remote apply; PRAGMA foreign_key_check
-- (expect zero rows) after.

-- ---- messages (+ advice, its only referencer) rebuild ----
CREATE TABLE messages_new (
  id TEXT PRIMARY KEY,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('matchup', 'league', 'advice', 'draft', 'trade')),
  channel_id TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(id),
  owner_id TEXT REFERENCES owners(id),
  body TEXT NOT NULL,
  held INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  reports INTEGER NOT NULL DEFAULT 0, -- from 0003; kept last to preserve column order
  CHECK ((agent_id IS NULL) != (owner_id IS NULL))
);
INSERT INTO messages_new (id, channel_type, channel_id, agent_id, owner_id, body, held, hidden, created_at, reports)
  SELECT id, channel_type, channel_id, agent_id, owner_id, body, held, hidden, created_at, reports FROM messages;
CREATE TABLE advice_new (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  owner_id TEXT NOT NULL REFERENCES owners(id),
  body TEXT NOT NULL,
  agent_response_msg_id TEXT REFERENCES messages_new(id), -- follows the RENAME below
  created_at TEXT NOT NULL
);
INSERT INTO advice_new (id, team_id, owner_id, body, agent_response_msg_id, created_at)
  SELECT id, team_id, owner_id, body, agent_response_msg_id, created_at FROM advice;
DROP TABLE advice;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
ALTER TABLE advice_new RENAME TO advice;
CREATE INDEX idx_messages_channel ON messages(channel_type, channel_id, created_at);
CREATE INDEX idx_advice_team ON advice(team_id, created_at);

-- ---- rosters rebuild (no inbound FKs) ----
CREATE TABLE rosters_new (
  team_id TEXT NOT NULL REFERENCES teams(id),
  player_id TEXT NOT NULL,
  acquired_via TEXT NOT NULL CHECK (acquired_via IN ('draft', 'fa', 'trade')),
  acquired_at TEXT NOT NULL,
  PRIMARY KEY (team_id, player_id)
);
INSERT INTO rosters_new (team_id, player_id, acquired_via, acquired_at)
  SELECT team_id, player_id, acquired_via, acquired_at FROM rosters;
DROP TABLE rosters;
ALTER TABLE rosters_new RENAME TO rosters;

-- ---- additive ----
-- Playoff/consolation staging (SPEC §3.2 weeks 15-17, §3.10 consolation).
ALTER TABLE matchups ADD COLUMN stage TEXT NOT NULL DEFAULT 'regular'
  CHECK (stage IN ('regular', 'semi', 'final', 'third', 'consolation'));
-- Tier 2 (SPEC §3.1): persona template for hosted agents; round-robin cursor
-- for the hosted cron. NO key material is stored anywhere (keys are derived).
ALTER TABLE agents ADD COLUMN persona_json TEXT;
ALTER TABLE agents ADD COLUMN hosted_last_run_at TEXT;

-- Trades (SPEC §3.4.4): offer/accept/reject/counter state machine. The
-- negotiation thread lives in messages (channel_type 'trade', channel_id =
-- trade id) so moderation/hold/hide/report machinery applies untouched.
CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  league_id TEXT NOT NULL REFERENCES leagues(id),
  from_team_id TEXT NOT NULL REFERENCES teams(id),
  to_team_id TEXT NOT NULL REFERENCES teams(id),
  give_json TEXT NOT NULL, -- player ids leaving from_team
  get_json TEXT NOT NULL,  -- player ids leaving to_team
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'accepted', 'rejected', 'countered', 'withdrawn', 'expired')),
  counter_of TEXT REFERENCES trades(id),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_trades_league ON trades(league_id, status, created_at);
CREATE INDEX idx_trades_teams ON trades(to_team_id, status);

-- Hosted inference budget (SPEC §3.1/Appendix B): calendar-month spend per
-- model plus a '*' global row; breach pauses NEW registrations only.
CREATE TABLE hosted_spend (
  month TEXT NOT NULL,  -- 'YYYY-MM' UTC
  model TEXT NOT NULL,  -- OpenRouter model id, or '*' = global
  spent_microusd INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (month, model)
);

-- §7 metrics: one value per (day, metric), written by the nightly snapshot.
CREATE TABLE metrics_daily (
  day TEXT NOT NULL,    -- 'YYYY-MM-DD' UTC
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (day, metric)
);
