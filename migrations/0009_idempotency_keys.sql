-- 0009: caller-scoped idempotency replay store. The old (key, route) PK let
-- any caller replay any other caller's stored response — and POST /register's
-- stored 201 body carries the plaintext api_key, so a shared key string was a
-- credential-disclosure primitive. The replacement scopes every row by actor
-- (authed agent id, or a hash of client IP + declared owner email for the
-- anonymous routes) and gets a created_at index for the 48h sweep.
-- The old table is a pure replay cache: dropped, not migrated (in-flight
-- retries across the deploy minute lose replay protection once — acceptable
-- pre-launch). Each statement standalone-valid (0007 lesson).
CREATE TABLE idempotency_keys (
  actor TEXT NOT NULL,
  route TEXT NOT NULL,
  key TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor, route, key)
);
CREATE INDEX idx_idempotency_keys_created ON idempotency_keys(created_at);
DROP TABLE idempotency;
