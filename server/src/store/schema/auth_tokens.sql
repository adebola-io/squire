-- v3: unified bearer tokens (oauth access/refresh + agent tokens).
-- One row per token; refresh tokens are deleted when used.
CREATE TABLE auth_tokens(
    token TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('oauth_access', 'oauth_refresh', 'agent')),
    client_id TEXT NOT NULL,
    scopes_json TEXT NOT NULL DEFAULT '[]',
    expires_at INTEGER,
    created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX auth_tokens_expiry ON auth_tokens(expires_at) WHERE expires_at IS NOT NULL;
