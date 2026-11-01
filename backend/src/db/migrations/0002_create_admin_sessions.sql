-- Server-side session store. Only the SHA-256 hash of the session token is
-- stored (never the raw token an admin's browser actually holds), so a
-- database read/leak alone can't be used to impersonate a session. Deleting
-- a row here revokes that session immediately, on the very next request.
CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_admin_sessions_token_hash ON admin_sessions(token_hash);
