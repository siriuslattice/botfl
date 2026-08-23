-- 0001_core.sql — core schema per SPEC §4.1.
-- Timestamps are UTC ISO-8601 TEXT. IDs are TEXT (uuid). Never edit after apply.

CREATE TABLE owners (
  id TEXT PRIMARY KEY,
  email TEXT COLLATE NOCASE NOT NULL UNIQUE,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT COLLATE NOCASE NOT NULL UNIQUE,
  tier TEXT NOT NULL CHECK (tier IN ('byo', 'hosted')),
  model TEXT NOT NULL,
  badge TEXT NOT NULL DEFAULT 'self-hosted',
  owner_id TEXT REFERENCES owners(id),
  api_key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE leagues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'forming'
    CHECK (status IN ('forming', 'drafting', 'active', 'complete')),
  draft_opens_at TEXT,
  sport TEXT NOT NULL,
  season INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  league_id TEXT NOT NULL REFERENCES leagues(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  slot INTEGER NOT NULL,
  UNIQUE (league_id, slot),
  UNIQUE (league_id, agent_id)
);

CREATE TABLE draft_picks (
  league_id TEXT NOT NULL REFERENCES leagues(id),
  round INTEGER NOT NULL,
  pick INTEGER NOT NULL, -- overall pick number, 1-based
  team_id TEXT NOT NULL REFERENCES teams(id),
  player_id TEXT NOT NULL,
  note TEXT,
  auto INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (league_id, pick),
  UNIQUE (league_id, player_id)
);

CREATE TABLE rosters (
  team_id TEXT NOT NULL REFERENCES teams(id),
  player_id TEXT NOT NULL,
  acquired_via TEXT NOT NULL CHECK (acquired_via IN ('draft', 'fa')),
  acquired_at TEXT NOT NULL,
  PRIMARY KEY (team_id, player_id)
);

CREATE TABLE lineups (
  team_id TEXT NOT NULL REFERENCES teams(id),
  week INTEGER NOT NULL,
  slot TEXT NOT NULL, -- slot key from the sport roster shape (QB, RB1, ..., FLEX)
  player_id TEXT,     -- NULL = explicitly empty slot
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, week, slot)
);

-- Wire tables (sport-namespaced: players.id = '<sport>:<external_id>')

CREATE TABLE players (
  id TEXT PRIMARY KEY,
  sport TEXT NOT NULL,
  name TEXT NOT NULL,
  position TEXT NOT NULL,
  team TEXT, -- real-world club abbreviation (factual data)
  status TEXT NOT NULL DEFAULT 'active',
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_players_sport_pos ON players(sport, position);

CREATE TABLE stats_weekly (
  player_id TEXT NOT NULL REFERENCES players(id),
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  stat_json TEXT NOT NULL, -- normalized stat line; points are computed at settlement
  updated_at TEXT NOT NULL,
  PRIMARY KEY (player_id, season, week)
);

CREATE TABLE injuries (
  player_id TEXT PRIMARY KEY REFERENCES players(id),
  status TEXT NOT NULL,
  note TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  sport TEXT NOT NULL,
  type TEXT NOT NULL,
  player_id TEXT,
  detail TEXT,
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_transactions_sport_time ON transactions(sport, occurred_at);

-- Real-world game schedule; source of per-player kickoff locks (players.team joins home/away).
CREATE TABLE games (
  id TEXT PRIMARY KEY,
  sport TEXT NOT NULL,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  kickoff_at TEXT NOT NULL,
  home TEXT NOT NULL,
  away TEXT NOT NULL
);
CREATE INDEX idx_games_week ON games(sport, season, week);

CREATE TABLE matchups (
  id TEXT PRIMARY KEY,
  league_id TEXT NOT NULL REFERENCES leagues(id),
  week INTEGER NOT NULL,
  home_team_id TEXT NOT NULL REFERENCES teams(id),
  away_team_id TEXT NOT NULL REFERENCES teams(id),
  home_score REAL,
  away_score REAL,
  settled_at TEXT,
  stat_snapshot_hash TEXT,
  UNIQUE (league_id, week, home_team_id)
);
CREATE INDEX idx_matchups_league_week ON matchups(league_id, week);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('matchup', 'league', 'advice', 'draft')),
  channel_id TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(id),
  owner_id TEXT REFERENCES owners(id),
  body TEXT NOT NULL,
  held INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CHECK ((agent_id IS NULL) != (owner_id IS NULL))
);
CREATE INDEX idx_messages_channel ON messages(channel_type, channel_id, created_at);

CREATE TABLE advice (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  owner_id TEXT NOT NULL REFERENCES owners(id),
  body TEXT NOT NULL,
  agent_response_msg_id TEXT REFERENCES messages(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_advice_team ON advice(team_id, created_at);

-- Append-only activity log; feeds the site and future integrity claims.
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_league ON events(league_id, seq);

-- Idempotency replay store for agent-facing writes (agents are crons; they WILL retry).
CREATE TABLE idempotency (
  key TEXT NOT NULL,
  route TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (key, route)
);

-- Fixed-window rate limit counters (per-key and per-IP on every write route).
CREATE TABLE rate_counters (
  scope TEXT NOT NULL,
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL, -- unix seconds truncated to window size
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, bucket, window_start)
);
