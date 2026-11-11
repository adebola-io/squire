-- Squire local store (plan 013; fresh start, squire.db is the only store)
--
-- One file:       ~/.squire/squire.db
-- Large bytes:    ~/.squire/blobs/<sha256[0:2]>/<sha256>   (content-addressed, refcounted below)
-- Secrets:        secrets table (provider keys, plugin secrets, OAuth tokens, installation private key)
-- Hand-edited:    ~/.squire/settings.json stays a file; everything machine-managed lives here.
--
-- Conventions
--   * Every table is STRICT. Timestamps are INTEGER unix milliseconds.
--   * Internal keys are INTEGER PRIMARY KEY. Only ids that leave the instance
--     (MCP thread ids, model-visible job ids) get a separate TEXT public_id.
--   * "Header" rows are small and hold everything a list or transcript shows.
--     Large payloads (tool args/results, opaque reasoning, provider-native parts)
--     live in separate tables and are read only on demand or by the agent.
--   * Denormalized fields (preview, counters, seq watermarks, rev) are written in
--     the same transaction as the change that affects them, so reads never aggregate.
--
-- Connection setup (writer and every reader):
--   PRAGMA journal_mode = WAL;  PRAGMA synchronous = NORMAL;  PRAGMA foreign_keys = ON;
--   PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;  PRAGMA cache_size = -32000;
--   PRAGMA mmap_size = 268435456; PRAGMA journal_size_limit = 67108864;
-- Readers additionally: PRAGMA query_only = ON.  Run PRAGMA optimize on shutdown / daily.

-- Applied in order with the other files in this folder; each file runs once.

------------------------------------------------------------------------------
-- Instance
------------------------------------------------------------------------------

CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT, WITHOUT ROWID;
-- e.g. relay_inbox_cursor, last_launch_day, change_log_floor

-- Single row. Plans 007 (auth) and 005 (remote access). Private key is in the secrets table.
CREATE TABLE installation (
    id                   INTEGER PRIMARY KEY CHECK (id = 1),
    installation_id      TEXT,
    account_id           TEXT,
    public_key           TEXT,
    secret_ref           TEXT,
    lease                TEXT,       -- server-signed 72h authorization lease
    lease_expires_at     INTEGER,
    last_validated_at    INTEGER,
    plan                 TEXT,       -- entitlement label shown in the profile row (plan 009)
    remote_endpoint_id   TEXT,
    remote_enabled       INTEGER NOT NULL DEFAULT 0 CHECK (remote_enabled IN (0, 1))
) STRICT;

-- Global native-tool boundary (006). No enabled flag by design.
CREATE TABLE roots (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    path      TEXT NOT NULL UNIQUE,
    enabled   INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    added_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE plugins (
    id            TEXT PRIMARY KEY,
    version       TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    installed_at  INTEGER NOT NULL,
    manifest_json TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE plugin_actions (
    plugin_id  TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    action     TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    mutative   INTEGER NOT NULL CHECK (mutative IN (0, 1)),
    PRIMARY KEY (plugin_id, action)
) STRICT, WITHOUT ROWID;

CREATE TABLE oauth_clients (
    client_id      TEXT PRIMARY KEY,
    metadata_json  TEXT NOT NULL,
    created_at     INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

------------------------------------------------------------------------------
-- Models
------------------------------------------------------------------------------

CREATE TABLE provider_profiles (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id       TEXT NOT NULL UNIQUE,
    kind            TEXT NOT NULL,        -- squire | chatCompletions | responses | anthropic | google | chatgpt ...
    display_name    TEXT NOT NULL,
    base_url        TEXT NOT NULL,
    session_header  TEXT,
    removed         INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0, 1)),
    secret_ref      TEXT,                 -- credential lives in the secrets table
    created_at      INTEGER NOT NULL
) STRICT;

CREATE TABLE model_prefs (
    profile_id           INTEGER NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
    model_id             TEXT NOT NULL,
    hidden               INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
    alias                TEXT,
    native_options_json  TEXT,            -- sticky reasoning settings
    metadata_override    TEXT,            -- user-edited capability overrides
    last_used_at         INTEGER,         -- "last profile used for this model"
    PRIMARY KEY (profile_id, model_id)
) STRICT, WITHOUT ROWID;

-- Cached models.dev / backend catalog, refreshed in the background.
CREATE TABLE model_catalog (
    provider_kind  TEXT NOT NULL,
    model_id       TEXT NOT NULL,
    metadata_json  TEXT NOT NULL,
    fetched_at     INTEGER NOT NULL,
    PRIMARY KEY (provider_kind, model_id)
) STRICT, WITHOUT ROWID;

-- Every model call that was billed, including ones whose output was discarded
-- (Stop, provider error, compaction, titling, classifier). This is the credits
-- ledger for plan 009 and the data source for the milestone-5 model comparison.
CREATE TABLE model_calls (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id    INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    commitment_id      INTEGER REFERENCES commitments(id) ON DELETE SET NULL,
    purpose            TEXT NOT NULL CHECK (purpose IN ('chat', 'compaction', 'title', 'classifier', 'brief')),
    profile_id         INTEGER,
    model_id           TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('completed', 'discarded', 'error', 'cancelled')),
    started_at         INTEGER NOT NULL,
    finished_at        INTEGER,
    input_tokens       INTEGER,
    output_tokens      INTEGER,
    cache_read_tokens  INTEGER,
    cache_write_tokens INTEGER,
    reasoning_tokens   INTEGER,
    cost_micros        INTEGER,
    error              TEXT
) STRICT;
CREATE INDEX model_calls_by_time ON model_calls(started_at);
CREATE INDEX model_calls_by_conversation ON model_calls(conversation_id, started_at);

------------------------------------------------------------------------------
-- Shared storage: frozen prompts, payloads, blobs
------------------------------------------------------------------------------

-- Frozen system prompts, deduplicated. Branches point at the same row instead of
-- copying several KB of prompt text.
CREATE TABLE prompts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    hash     TEXT NOT NULL UNIQUE,
    version  INTEGER NOT NULL,
    text     TEXT NOT NULL
) STRICT;

-- Large tool-call data, shared by conversation tool calls, connection calls and jobs.
-- Never read by list or transcript queries.
CREATE TABLE payloads (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    args_json    TEXT NOT NULL,
    result_json  TEXT,
    model_text   TEXT       -- render_for_model(result), computed once at finish
) STRICT;

CREATE TABLE blobs (
    hash        TEXT PRIMARY KEY,           -- sha256 hex; file at blobs/<hash[0:2]>/<hash>
    mime_type   TEXT NOT NULL,
    bytes       INTEGER NOT NULL,
    refs        INTEGER NOT NULL DEFAULT 0 CHECK (refs >= 0),
    created_at  INTEGER NOT NULL,
    unreferenced_at INTEGER           -- set when refs reaches 0; GC uses a 1h grace period
) STRICT, WITHOUT ROWID;
CREATE INDEX blobs_gc ON blobs(unreferenced_at) WHERE refs = 0;
CREATE TRIGGER blobs_ref_timestamp AFTER UPDATE OF refs ON blobs BEGIN
    UPDATE blobs SET unreferenced_at = CASE WHEN new.refs = 0 THEN CAST(unixepoch('subsec') * 1000 AS INTEGER) ELSE NULL END
    WHERE hash = new.hash;
END;

-- Images/files returned in tool results.
CREATE TABLE result_attachments (
    payload_id  INTEGER NOT NULL REFERENCES payloads(id) ON DELETE CASCADE,
    idx         INTEGER NOT NULL,
    name        TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    bytes       INTEGER NOT NULL,
    width       INTEGER,
    height      INTEGER,
    blob_hash   TEXT NOT NULL REFERENCES blobs(hash),
    PRIMARY KEY (payload_id, idx)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER result_attachments_ref AFTER INSERT ON result_attachments BEGIN
    UPDATE blobs SET refs = refs + 1 WHERE hash = new.blob_hash;
END;
CREATE TRIGGER result_attachments_unref AFTER DELETE ON result_attachments BEGIN
    UPDATE blobs SET refs = refs - 1 WHERE hash = old.blob_hash;
END;
CREATE TRIGGER result_attachments_repoint AFTER UPDATE OF blob_hash ON result_attachments
WHEN old.blob_hash <> new.blob_hash BEGIN
    UPDATE blobs SET refs = refs - 1 WHERE hash = old.blob_hash;
    UPDATE blobs SET refs = refs + 1 WHERE hash = new.blob_hash;
END;

------------------------------------------------------------------------------
-- Conversations
------------------------------------------------------------------------------

CREATE TABLE conversations (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    kind                   TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'task', 'temp_branch')),
    title                  TEXT NOT NULL DEFAULT '',
    title_source           TEXT NOT NULL DEFAULT 'none' CHECK (title_source IN ('none', 'auto', 'user')),
    created_at             INTEGER NOT NULL,
    updated_at             INTEGER NOT NULL,
    rev                    INTEGER NOT NULL DEFAULT 0,   -- +1 per committed change; events carry it; survives restarts

    prompt_id              INTEGER REFERENCES prompts(id),
    model_profile_id       INTEGER,
    model_id               TEXT,

    -- execution checkpoint (overwritten, not a history)
    exec_status            TEXT NOT NULL DEFAULT 'idle'
                           CHECK (exec_status IN ('idle', 'running', 'stopped', 'error', 'interrupted')),
    exec_started_at        INTEGER,
    exec_error             TEXT,
    compaction_status      TEXT CHECK (compaction_status IN ('running', 'error')),

    -- denormalized read model, maintained by the writer
    last_seq               INTEGER NOT NULL DEFAULT 0,
    last_assistant_seq     INTEGER NOT NULL DEFAULT 0,
    last_seen_seq          INTEGER NOT NULL DEFAULT 0,
    active_epoch_start_seq INTEGER NOT NULL DEFAULT 1,
    edit_floor_seq         INTEGER NOT NULL DEFAULT 0,   -- seq of the latest assistant message with a completed mutative call
    queued_count           INTEGER NOT NULL DEFAULT 0,
    preview                TEXT,                         -- one line, <= 100 chars, plain text
    unread                 INTEGER GENERATED ALWAYS AS (last_assistant_seq > last_seen_seq) VIRTUAL,

    -- lineage: ordinary or temporary branch
    parent_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    parent_seq             INTEGER,

    CHECK ((model_profile_id IS NULL) = (model_id IS NULL))
) STRICT;
-- Sidebar: one index range scan, newest first, per kind (chats vs task conversations).
CREATE INDEX conversations_list ON conversations(kind, updated_at DESC, id DESC);
CREATE INDEX conversations_running ON conversations(exec_status) WHERE exec_status = 'running';

-- An Epoch is a seq range: it starts at start_seq and runs until the next Epoch's start.
-- Compaction inserts one row; it never rewrites message rows.
CREATE TABLE epochs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id       INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    ordinal               INTEGER NOT NULL,
    start_seq             INTEGER NOT NULL,
    created_at            INTEGER NOT NULL,
    closed_at             INTEGER,
    summary               TEXT,               -- prefix_summary for this epoch
    summary_model_call_id INTEGER REFERENCES model_calls(id),
    UNIQUE (conversation_id, ordinal),
    UNIQUE (conversation_id, start_seq)
) STRICT;

-- Committed transcript only. Rows are small: what the chat renders and search indexes.
CREATE TABLE messages (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id     INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq                 INTEGER NOT NULL,
    role                TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    source              TEXT NOT NULL CHECK (source IN ('user', 'model', 'runtime', 'trigger', 'brief')),
    visibility          TEXT NOT NULL DEFAULT 'visible' CHECK (visibility IN ('visible', 'hidden')),
    created_at          INTEGER NOT NULL,
    response_started_at INTEGER,
    model_profile_id    INTEGER,
    model_id            TEXT,
    model_call_id       INTEGER REFERENCES model_calls(id),
    text                TEXT NOT NULL DEFAULT '',   -- display + search text, extracted once at write
    reasoning_ms        INTEGER,                    -- for "Worked for …" when reasoning is opaque
    has_reasoning       INTEGER NOT NULL DEFAULT 0 CHECK (has_reasoning IN (0, 1)),
    attachment_count    INTEGER NOT NULL DEFAULT 0,
    tool_call_count     INTEGER NOT NULL DEFAULT 0,
    UNIQUE (conversation_id, seq)
) STRICT;
CREATE INDEX messages_visible ON messages(conversation_id, seq DESC) WHERE visibility = 'visible';

-- What the model needs and the UI almost never does: full parts (opaque reasoning,
-- provider-native output items) and the native options sent with a user message.
CREATE TABLE message_payloads (
    message_id           INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    parts_json           TEXT NOT NULL,
    native_options_json  TEXT
) STRICT;

-- Queued user Messages are their own table: no NULL-seq rows mixed into the transcript.
CREATE TABLE queued_messages (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id      INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    position             INTEGER NOT NULL,
    created_at           INTEGER NOT NULL,
    text                 TEXT NOT NULL,
    native_options_json  TEXT,
    UNIQUE (conversation_id, position)
) STRICT;

-- User attachments; owned by a queued message until it is consumed, then by the message.
CREATE TABLE message_attachments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id  INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    queued_id   INTEGER REFERENCES queued_messages(id) ON DELETE CASCADE,
    idx         INTEGER NOT NULL,
    name        TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    bytes       INTEGER NOT NULL,
    width       INTEGER,
    height      INTEGER,
    blob_hash   TEXT NOT NULL REFERENCES blobs(hash),
    CHECK ((message_id IS NULL) <> (queued_id IS NULL))
) STRICT;
CREATE UNIQUE INDEX message_attachments_by_message ON message_attachments(message_id, idx) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX message_attachments_by_queued ON message_attachments(queued_id, idx) WHERE queued_id IS NOT NULL;

CREATE TRIGGER message_attachments_ref AFTER INSERT ON message_attachments BEGIN
    UPDATE blobs SET refs = refs + 1 WHERE hash = new.blob_hash;
END;
CREATE TRIGGER message_attachments_unref AFTER DELETE ON message_attachments BEGIN
    UPDATE blobs SET refs = refs - 1 WHERE hash = old.blob_hash;
END;
CREATE TRIGGER message_attachments_repoint AFTER UPDATE OF blob_hash ON message_attachments
WHEN old.blob_hash <> new.blob_hash BEGIN
    UPDATE blobs SET refs = refs - 1 WHERE hash = old.blob_hash;
    UPDATE blobs SET refs = refs + 1 WHERE hash = new.blob_hash;
END;

-- Tool-call headers: everything the live ticker, "Worked for …" and the right-panel
-- list show. Arguments and results are in payloads.
CREATE TABLE tool_calls (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id   INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_id        INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    ordinal           INTEGER NOT NULL,
    call_id           TEXT NOT NULL,         -- provider's tool-call id
    tool              TEXT NOT NULL,
    plugin_id         TEXT,                  -- resolved for use_action, for icons
    action            TEXT,
    label             TEXT NOT NULL,
    mutative          INTEGER NOT NULL CHECK (mutative IN (0, 1)),
    status            TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'error', 'skipped', 'interrupted')),
    error             TEXT,
    started_at        INTEGER,
    finished_at       INTEGER,
    duration_ms       INTEGER,
    attachment_count  INTEGER NOT NULL DEFAULT 0,
    payload_id        INTEGER NOT NULL REFERENCES payloads(id),
    UNIQUE (message_id, ordinal)
) STRICT;
CREATE INDEX tool_calls_running ON tool_calls(conversation_id, started_at) WHERE status = 'running';

CREATE TRIGGER tool_calls_drop_payload AFTER DELETE ON tool_calls BEGIN
    DELETE FROM payloads WHERE id = old.payload_id;
END;

-- Full-text search over titles and visible user/assistant text (tool data excluded, per 006).
-- External-content tables: the text is stored once, in messages / conversations.
CREATE VIRTUAL TABLE messages_fts USING fts5(
    text, content = 'messages', content_rowid = 'id',
    tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
);
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages
WHEN new.role IN ('user', 'assistant') AND new.visibility = 'visible' BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages
WHEN old.role IN ('user', 'assistant') AND old.visibility = 'visible' BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER messages_fts_update AFTER UPDATE OF text, role, visibility ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text)
        SELECT 'delete', old.id, old.text
        WHERE old.role IN ('user', 'assistant') AND old.visibility = 'visible';
    INSERT INTO messages_fts(rowid, text)
        SELECT new.id, new.text
        WHERE new.role IN ('user', 'assistant') AND new.visibility = 'visible';
END;

CREATE VIRTUAL TABLE conversations_fts USING fts5(
    title, content = 'conversations', content_rowid = 'id',
    tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
);
CREATE TRIGGER conversations_fts_insert AFTER INSERT ON conversations BEGIN
    INSERT INTO conversations_fts(rowid, title) VALUES (new.id, new.title);
END;
CREATE TRIGGER conversations_fts_delete AFTER DELETE ON conversations BEGIN
    INSERT INTO conversations_fts(conversations_fts, rowid, title) VALUES ('delete', old.id, old.title);
END;
CREATE TRIGGER conversations_fts_update AFTER UPDATE OF title ON conversations BEGIN
    INSERT INTO conversations_fts(conversations_fts, rowid, title) VALUES ('delete', old.id, old.title);
    INSERT INTO conversations_fts(rowid, title) VALUES (new.id, new.title);
END;

------------------------------------------------------------------------------
-- Connections (external MCP clients) and their Threads (006 renames Session → Thread)
------------------------------------------------------------------------------

CREATE TABLE connections (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    client_key        TEXT NOT NULL UNIQUE,     -- normalized once at write ('Unknown client' for blank)
    display_name      TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    last_activity_at  INTEGER NOT NULL,
    thread_count      INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX connections_recent ON connections(last_activity_at DESC, id DESC);

CREATE TABLE threads (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id         TEXT NOT NULL UNIQUE,     -- the thread_id MCP clients send
    connection_id     INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    title             TEXT NOT NULL,
    started_at        INTEGER NOT NULL,
    last_activity_at  INTEGER NOT NULL,
    call_count        INTEGER NOT NULL DEFAULT 0,
    running_count     INTEGER NOT NULL DEFAULT 0,
    error_count       INTEGER NOT NULL DEFAULT 0,
    rev               INTEGER NOT NULL DEFAULT 0
) STRICT;
-- "5 most recent threads per connection" and keyset paging are both one index seek.
CREATE INDEX threads_by_connection ON threads(connection_id, last_activity_at DESC, id DESC);

CREATE TABLE thread_calls (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id    INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    source       TEXT NOT NULL,
    tool         TEXT NOT NULL,
    description  TEXT NOT NULL,
    plugin_id    TEXT,
    action       TEXT,
    status       TEXT NOT NULL CHECK (status IN ('running', 'completed', 'error', 'interrupted', 'rejected')),
    started_at   INTEGER NOT NULL,
    finished_at  INTEGER,
    duration_ms  INTEGER,
    command      TEXT,
    cwd          TEXT,
    metadata     TEXT,
    error        TEXT,
    payload_id   INTEGER REFERENCES payloads(id) ON DELETE SET NULL   -- NULL once pruned by retention
) STRICT;
CREATE INDEX thread_calls_by_thread ON thread_calls(thread_id, started_at DESC, id DESC);
CREATE INDEX thread_calls_by_time ON thread_calls(started_at) WHERE payload_id IS NOT NULL;
CREATE INDEX thread_calls_running ON thread_calls(status) WHERE status = 'running';

CREATE TRIGGER thread_calls_drop_payload AFTER DELETE ON thread_calls
WHEN old.payload_id IS NOT NULL BEGIN
    DELETE FROM payloads WHERE id = old.payload_id;
END;

CREATE TRIGGER thread_calls_count_insert AFTER INSERT ON thread_calls BEGIN
    UPDATE threads SET
        call_count = call_count + 1,
        running_count = running_count + (new.status = 'running'),
        error_count = error_count + (new.status = 'error'),
        last_activity_at = MAX(last_activity_at, new.started_at),
        rev = rev + 1
    WHERE id = new.thread_id;
    UPDATE connections SET last_activity_at = MAX(last_activity_at, new.started_at)
    WHERE id = (SELECT connection_id FROM threads WHERE id = new.thread_id);
END;
CREATE TRIGGER thread_calls_count_update AFTER UPDATE OF status ON thread_calls BEGIN
    UPDATE threads SET
        running_count = running_count - (old.status = 'running') + (new.status = 'running'),
        error_count = error_count - (old.status = 'error') + (new.status = 'error'),
        last_activity_at = MAX(last_activity_at, COALESCE(new.finished_at, new.started_at)),
        rev = rev + 1
    WHERE id = new.thread_id;
    UPDATE connections SET last_activity_at = MAX(last_activity_at, COALESCE(new.finished_at, new.started_at))
    WHERE id = (SELECT connection_id FROM threads WHERE id = new.thread_id);
END;
CREATE TRIGGER threads_count_insert AFTER INSERT ON threads BEGIN
    UPDATE connections SET thread_count = thread_count + 1,
        last_activity_at = MAX(last_activity_at, new.started_at)
    WHERE id = new.connection_id;
END;
CREATE TRIGGER threads_count_delete AFTER DELETE ON threads BEGIN
    UPDATE connections SET thread_count = thread_count - 1 WHERE id = old.connection_id;
END;

------------------------------------------------------------------------------
-- Background Jobs (owned by exactly one Conversation or one Thread)
------------------------------------------------------------------------------

CREATE TABLE jobs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id        TEXT NOT NULL UNIQUE,      -- model-visible job id
    conversation_id  INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    thread_id        INTEGER REFERENCES threads(id) ON DELETE CASCADE,
    action           TEXT NOT NULL,
    state            TEXT NOT NULL CHECK (state IN ('running', 'completed', 'error', 'cancelled', 'interrupted')),
    started_at       INTEGER NOT NULL,
    finished_at      INTEGER,
    payload_id       INTEGER REFERENCES payloads(id),
    CHECK ((conversation_id IS NULL) <> (thread_id IS NULL))
) STRICT;
CREATE INDEX jobs_by_conversation ON jobs(conversation_id, started_at) WHERE conversation_id IS NOT NULL;
CREATE INDEX jobs_by_thread ON jobs(thread_id, started_at) WHERE thread_id IS NOT NULL;
CREATE INDEX jobs_running ON jobs(state) WHERE state = 'running';

CREATE TRIGGER jobs_drop_payload AFTER DELETE ON jobs
WHEN old.payload_id IS NOT NULL BEGIN
    DELETE FROM payloads WHERE id = old.payload_id;
END;

------------------------------------------------------------------------------
-- Tasks: Commitments, Triggers, Events, Firings (006; plan to be written)
-- Created in v1, written only once the Tasks plan lands; that plan owns these columns.
------------------------------------------------------------------------------

CREATE TABLE commitments (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    title                   TEXT NOT NULL,
    behavior                TEXT,                -- natural-language intent, resolved at run time
    lifecycle               TEXT NOT NULL DEFAULT 'active'
                            CHECK (lifecycle IN ('active', 'blocked', 'completed', 'cancelled')),
    lifecycle_reason        TEXT,                -- classifier's one line, or the user's
    lifecycle_by            TEXT CHECK (lifecycle_by IN ('user', 'squire')),
    builtin                 TEXT CHECK (builtin IN ('daily_brief')),
    read_only               INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0, 1)),
    conversation_id         INTEGER REFERENCES conversations(id) ON DELETE SET NULL,   -- its Task Conversation
    model_profile_id        INTEGER,
    model_id                TEXT,
    delivery_json           TEXT,                -- notify, home area, …
    due_at                  INTEGER,
    created_at              INTEGER NOT NULL,
    updated_at              INTEGER NOT NULL,
    resolved_at             INTEGER,
    rev                     INTEGER NOT NULL DEFAULT 0,
    -- provenance (Commitment → Commitment is forbidden, so no parent commitment)
    origin_conversation_id  INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    origin_message_id       INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    origin_thread_id        INTEGER REFERENCES threads(id) ON DELETE SET NULL
) STRICT;
CREATE INDEX commitments_list ON commitments(lifecycle, updated_at DESC, id DESC);

CREATE TABLE triggers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    commitment_id   INTEGER NOT NULL REFERENCES commitments(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('at', 'recurring', 'event', 'app_launch')),
    spec_json       TEXT NOT NULL,          -- time / RRULE / filters over the typed payload
    event_type      TEXT,                   -- for kind = 'event'
    timezone        TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    next_fire_at    INTEGER,
    last_fired_at   INTEGER
) STRICT;
-- Catch-up on launch: "everything due before now" is one range scan.
CREATE INDEX triggers_due ON triggers(next_fire_at) WHERE enabled = 1 AND next_fire_at IS NOT NULL;
CREATE INDEX triggers_by_event ON triggers(event_type) WHERE kind = 'event' AND enabled = 1;
CREATE INDEX triggers_by_commitment ON triggers(commitment_id);

-- Typed events from plugins, Squire itself, or the backend relay inbox.
CREATE TABLE events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    type          TEXT NOT NULL,
    type_version  INTEGER NOT NULL,
    source        TEXT NOT NULL,            -- plugin id | 'squire' | 'relay'
    dedupe_key    TEXT UNIQUE,              -- relay inbox id, webhook delivery id, …
    occurred_at   INTEGER NOT NULL,
    received_at   INTEGER NOT NULL,
    payload_json  TEXT NOT NULL
) STRICT;
CREATE INDEX events_by_type ON events(type, occurred_at);

-- One row per trigger match. Blocked Tasks keep accumulating 'pending' rows;
-- on wake they drain as one coalesced batch without losing per-event timing.
CREATE TABLE firings (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    commitment_id         INTEGER NOT NULL REFERENCES commitments(id) ON DELETE CASCADE,
    trigger_id            INTEGER REFERENCES triggers(id) ON DELETE SET NULL,
    event_id              INTEGER REFERENCES events(id) ON DELETE SET NULL,
    scheduled_for         INTEGER,
    occurred_at           INTEGER NOT NULL,
    created_at            INTEGER NOT NULL,
    status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dropped')),
    delivered_at          INTEGER,
    delivered_message_id  INTEGER REFERENCES messages(id) ON DELETE SET NULL
) STRICT;
CREATE INDEX firings_pending ON firings(commitment_id, occurred_at) WHERE status = 'pending';

------------------------------------------------------------------------------
-- Home: Daily Brief (011) and notifications
------------------------------------------------------------------------------

CREATE TABLE briefs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    commitment_id  INTEGER NOT NULL REFERENCES commitments(id) ON DELETE CASCADE,
    generated_at   INTEGER NOT NULL,
    model_call_id  INTEGER REFERENCES model_calls(id)
) STRICT;
CREATE INDEX briefs_latest ON briefs(commitment_id, generated_at DESC);

CREATE TABLE brief_items (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    brief_id                 INTEGER NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
    position                 INTEGER NOT NULL,
    title                    TEXT NOT NULL,
    reason                   TEXT NOT NULL,
    sources_json             TEXT NOT NULL,     -- [{plugin, kind, url, label}]
    status                   TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dismissed')),
    done_by                  TEXT CHECK (done_by IN ('user', 'squire')),
    done_reason              TEXT,
    done_at                  INTEGER,
    discuss_conversation_id  INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    task_commitment_id       INTEGER REFERENCES commitments(id) ON DELETE SET NULL,
    UNIQUE (brief_id, position)
) STRICT;

CREATE TABLE notifications (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kind          TEXT NOT NULL,           -- task_completed, task_blocked, brief_ready, conversation_result, …
    subject_kind  TEXT NOT NULL CHECK (subject_kind IN ('conversation', 'commitment', 'brief', 'thread')),
    subject_id    INTEGER NOT NULL,
    title         TEXT NOT NULL,
    body          TEXT,
    created_at    INTEGER NOT NULL,
    read_at       INTEGER,
    os_shown_at   INTEGER,
    relay_ack_at  INTEGER                  -- thin notice pushed to the backend for other clients
) STRICT;
CREATE INDEX notifications_unread ON notifications(created_at DESC) WHERE read_at IS NULL;

------------------------------------------------------------------------------
-- Change log: lets a client (desktop now, remote instance later) that was
-- disconnected ask "what changed since N" instead of refetching everything.
-- Pruned after 7 days; a cursor older than meta.change_log_floor means full refetch.
------------------------------------------------------------------------------

CREATE TABLE changes (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    at           INTEGER NOT NULL,
    entity_kind  TEXT NOT NULL CHECK (entity_kind IN ('conversation', 'commitment', 'thread', 'brief', 'notification', 'settings')),
    entity_id    INTEGER NOT NULL,
    rev          INTEGER NOT NULL,
    deleted      INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
) STRICT;
CREATE INDEX changes_by_entity ON changes(entity_kind, entity_id);


------------------------------------------------------------------------------
-- The hot read paths, for reference (all index seeks/range scans, no JSON decoding)
------------------------------------------------------------------------------
--
-- Sidebar page:
--   SELECT id, title, preview, updated_at, exec_status, unread, queued_count, rev
--   FROM conversations WHERE kind = 'chat' AND (updated_at, id) < (?, ?)
--   ORDER BY updated_at DESC, id DESC LIMIT 50;
--
-- Open a chat (newest window; scroll up pages with seq < ?):
--   SELECT … FROM messages WHERE conversation_id = ? AND visibility = 'visible'
--     ORDER BY seq DESC LIMIT 40;
--   SELECT … FROM tool_calls WHERE message_id IN (…window ids…) ORDER BY message_id, ordinal;
--   SELECT … FROM message_attachments WHERE message_id IN (…window ids…);
--   SELECT … FROM queued_messages WHERE conversation_id = ? ORDER BY position;
--   SELECT … FROM jobs WHERE conversation_id = ? AND state = 'running';
--   Editable = role = 'user' AND seq >= active_epoch_start_seq  (no query)
--
-- Expand a tool call / reasoning in the right panel:
--   SELECT args_json, result_json FROM payloads WHERE id = ?;
--   SELECT parts_json FROM message_payloads WHERE message_id = ?;
--
-- Agent context (active epoch only; cached in memory for the life of an execution):
--   SELECT m.*, p.parts_json FROM messages m JOIN message_payloads p ON p.message_id = m.id
--   WHERE m.conversation_id = ? AND m.seq >= ? ORDER BY m.seq;
--
-- Connections page:
--   SELECT … FROM connections ORDER BY last_activity_at DESC;
--   SELECT … FROM threads WHERE connection_id = ? ORDER BY last_activity_at DESC, id DESC LIMIT 5;
--
-- Search:
--   SELECT rowid FROM conversations_fts WHERE conversations_fts MATCH ?
--   UNION SELECT m.conversation_id FROM messages_fts f JOIN messages m ON m.id = f.rowid
--   WHERE messages_fts MATCH ?;
