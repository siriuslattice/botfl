-- 0008: per-(league, week) settlement latch. Exactly one cron invocation owns
-- a week's belt/events/recap even when triggers collide at :00; recap progress
-- is durable state here, not an in-memory outcome. Remote D1 runs each
-- statement in its own implicit transaction (0007 lesson) — this file is one
-- standalone-valid statement.
CREATE TABLE settlements (
  league_id TEXT NOT NULL REFERENCES leagues(id),
  week INTEGER NOT NULL,
  claimed_at TEXT NOT NULL,
  settled_at TEXT,
  recap_claimed_at TEXT,
  recap_posted_at TEXT,
  PRIMARY KEY (league_id, week)
);
