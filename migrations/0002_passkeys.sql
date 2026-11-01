-- Passkey sign-in for the inbox page. Times are ISO 8601 UTC strings, like 0001.

-- One row per registered passkey. id and public_key are base64url.
CREATE TABLE credentials (
  id           TEXT PRIMARY KEY,
  public_key   TEXT NOT NULL,
  counter      INTEGER NOT NULL DEFAULT 0,
  transports   TEXT NOT NULL DEFAULT '[]', -- JSON array
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

-- One-time enrollment links from scripts/enroll-link.mjs. Only the SHA-256
-- (hex) of the token is stored; used_at is set when a passkey is registered.
CREATE TABLE enroll_tokens (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);

-- WebAuthn challenges. Deleted when used, so each one works once.
CREATE TABLE challenges (
  challenge  TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('register', 'login')),
  token_hash TEXT, -- the enroll token a register challenge was issued for
  expires_at TEXT NOT NULL
);

-- Signed-in browsers. The cookie holds a random id; only its SHA-256 is stored.
CREATE TABLE sessions (
  id_hash    TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
