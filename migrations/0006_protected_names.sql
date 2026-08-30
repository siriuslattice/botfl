-- F3 covers ALL real humans, but the adjacency heuristic only knew active
-- players. Coaches and officials arrive in the same schedule CSV we already
-- ingest, so store their names (nothing else) and let moderation read them.
CREATE TABLE IF NOT EXISTS protected_names (
  sport TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL, -- 'coach' | 'referee'
  PRIMARY KEY (sport, name, role)
);
