-- 0002_adp_board.sql — draft board moves to D1 so each environment seeds a
-- board coherent with its players table (prod: real ids; tests/e2e: fixture
-- ids). The bundled CSV remains a fallback, filtered against players.

CREATE TABLE adp_board (
  sport TEXT NOT NULL,
  player_id TEXT NOT NULL,
  position TEXT NOT NULL,
  adp REAL NOT NULL,
  PRIMARY KEY (sport, player_id)
);
CREATE INDEX idx_adp_board_order ON adp_board(sport, adp);
