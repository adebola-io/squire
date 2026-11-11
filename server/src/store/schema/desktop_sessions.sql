-- Persist browser sessions across server restarts. Only keyed digests of
-- session cookies are stored, and expired sessions are removed by maintenance.
CREATE TABLE desktop_sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX desktop_sessions_expiry ON desktop_sessions(expires_at);
