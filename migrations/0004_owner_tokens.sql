-- 0004_owner_tokens.sql — magic-link claim + owner sessions (SPEC §3.7/§3.9).
-- Tokens stored hashed only, single-use for claims, expiring for sessions.

CREATE TABLE owner_tokens (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('claim', 'session')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_owner_tokens_owner ON owner_tokens(owner_id, purpose);
