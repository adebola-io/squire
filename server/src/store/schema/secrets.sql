-- v2: instance secrets in SQLite (no OS keychain is ever used).
CREATE TABLE secrets(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT, WITHOUT ROWID;
