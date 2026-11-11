//! Indexed Connection / Thread history reads. Large call payloads are kept
//! separately and never decoded by list endpoints.
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionHeader {
    pub id: i64,
    pub client_key: String,
    pub display_name: String,
    pub last_activity_at: i64,
    pub thread_count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadHeader {
    pub id: i64,
    pub public_id: String,
    pub connection_id: i64,
    pub title: String,
    pub started_at: i64,
    pub last_activity_at: i64,
    pub call_count: i64,
    pub running_count: i64,
    pub error_count: i64,
    pub rev: i64,
    pub foreground_count: i64,
    pub last_foreground_started_at: Option<i64>,
    pub last_foreground_end_at: Option<i64>,
    pub foreground_grace_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallHeader {
    pub id: i64,
    pub thread_id: i64,
    pub source: String,
    pub tool: String,
    pub description: String,
    pub plugin_id: Option<String>,
    pub action: Option<String>,
    pub status: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub metadata: Option<String>,
    pub error: Option<String>,
    pub payload_available: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WithThreads {
    pub connection: ConnectionHeader,
    pub threads: Vec<ThreadHeader>,
}

fn row_connection(r: &rusqlite::Row<'_>) -> rusqlite::Result<ConnectionHeader> {
    Ok(ConnectionHeader {
        id: r.get(0)?,
        client_key: r.get(1)?,
        display_name: r.get(2)?,
        last_activity_at: r.get(3)?,
        thread_count: r.get(4)?,
    })
}
fn row_thread(r: &rusqlite::Row<'_>) -> rusqlite::Result<ThreadHeader> {
    Ok(ThreadHeader {
        id: r.get(0)?,
        public_id: r.get(1)?,
        connection_id: r.get(2)?,
        title: r.get(3)?,
        started_at: r.get(4)?,
        last_activity_at: r.get(5)?,
        call_count: r.get(6)?,
        running_count: r.get(7)?,
        error_count: r.get(8)?,
        rev: r.get(9)?,
        foreground_count: r.get(10)?,
        last_foreground_started_at: r.get(11)?,
        last_foreground_end_at: r.get(12)?,
        foreground_grace_ms: r.get(13)?,
    })
}
fn row_call(r: &rusqlite::Row<'_>) -> rusqlite::Result<CallHeader> {
    Ok(CallHeader {
        id: r.get(0)?,
        thread_id: r.get(1)?,
        source: r.get(2)?,
        tool: r.get(3)?,
        description: r.get(4)?,
        plugin_id: r.get(5)?,
        action: r.get(6)?,
        status: r.get(7)?,
        started_at: r.get(8)?,
        finished_at: r.get(9)?,
        duration_ms: r.get(10)?,
        command: r.get(11)?,
        cwd: r.get(12)?,
        metadata: r.get(13)?,
        error: r.get(14)?,
        payload_available: r.get::<_, Option<i64>>(15)?.is_some(),
    })
}
const THREAD_COLS: &str = "id, public_id, connection_id, title, started_at,
    last_activity_at, call_count, running_count, error_count, rev,
    foreground_count, last_foreground_started_at, last_foreground_end_at, foreground_grace_ms";

/// A case-insensitive substring search over thread titles. A client whose
/// name matches keeps all of its threads; any other client keeps only the
/// threads whose title matches.
pub struct ThreadSearch {
    needle: String,
    pattern: String,
}

impl ThreadSearch {
    /// `None` for a blank query, so callers can skip filtering entirely.
    pub fn new(query: &str) -> Option<Self> {
        let query = query.trim();
        if query.is_empty() {
            return None;
        }
        let escaped = query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        Some(Self {
            needle: query.to_lowercase(),
            pattern: format!("%{escaped}%"),
        })
    }

    /// The title pattern to apply to a client's threads, or `None` when the
    /// client's own name matches and every thread should be listed.
    pub fn title_filter(&self, client_name: &str) -> Option<&str> {
        if client_name.to_lowercase().contains(&self.needle) {
            None
        } else {
            Some(&self.pattern)
        }
    }

    pub fn pattern(&self) -> &str {
        &self.pattern
    }
}

/// How many of a connection's threads have a title matching `pattern`.
pub fn count_threads(db: &Connection, connection_id: i64, pattern: &str) -> Result<i64> {
    Ok(db.query_row(
        "SELECT COUNT(*) FROM threads WHERE connection_id = ?1
         AND title LIKE ?2 ESCAPE '\\'",
        params![connection_id, pattern],
        |r| r.get(0),
    )?)
}
const CALL_COLS: &str = "id, thread_id, source, tool, description, plugin_id, action,
    status, started_at, finished_at, duration_ms, command, cwd, metadata, error, payload_id";

/// Every client with its newest threads. Clients are ranked by how many
/// threads they have, most first, and only that: activity reorders the
/// threads within a client, never the clients themselves. Equal counts
/// keep a fixed order by name, so a client does not hop past its peers.
/// With a search, clients without a match are left out and each client's
/// `thread_count` is its number of matching threads.
pub fn list(db: &Connection, search: Option<&ThreadSearch>) -> Result<Vec<WithThreads>> {
    // One consistent snapshot for all connection and thread counters.
    let tx = db.unchecked_transaction()?;
    let connections: Vec<ConnectionHeader> = {
        let mut stmt = tx.prepare(
            "SELECT id,client_key,display_name,last_activity_at,thread_count
            FROM connections
            ORDER BY thread_count DESC, display_name COLLATE NOCASE, id",
        )?;
        let rows = stmt.query_map([], row_connection)?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut all = Vec::with_capacity(connections.len());
    for mut connection in connections {
        let filter = search.and_then(|search| search.title_filter(&connection.display_name));
        if let Some(pattern) = filter {
            connection.thread_count = count_threads(&tx, connection.id, pattern)?;
            if connection.thread_count == 0 {
                continue;
            }
        }
        let threads = threads(&tx, connection.id, None, 5, filter)?;
        all.push(WithThreads {
            connection,
            threads,
        });
    }
    tx.commit()?;
    Ok(all)
}

/// One page of threads across every client, ordered by most recent activity.
pub fn all_threads(
    db: &Connection,
    before: Option<(i64, i64)>,
    limit: i64,
    search: Option<&ThreadSearch>,
) -> Result<(Vec<(ThreadHeader, String)>, i64)> {
    let tx = db.unchecked_transaction()?;
    let pattern = search.map(ThreadSearch::pattern);
    let total = tx.query_row(
        "SELECT COUNT(*) FROM threads t
         JOIN connections c ON c.id = t.connection_id
         WHERE (?1 IS NULL OR c.display_name LIKE ?1 ESCAPE '\\'
                OR t.title LIKE ?1 ESCAPE '\\')",
        params![pattern],
        |row| row.get(0),
    )?;
    let (at, id) = before.unwrap_or((i64::MAX, i64::MAX));
    let mut stmt = tx.prepare(
        "SELECT t.id, t.public_id, t.connection_id, t.title, t.started_at,
                t.last_activity_at, t.call_count, t.running_count, t.error_count,
                t.rev, t.foreground_count, t.last_foreground_started_at,
                t.last_foreground_end_at, t.foreground_grace_ms, c.display_name
         FROM threads t JOIN connections c ON c.id = t.connection_id
         WHERE (t.last_activity_at, t.id) < (?1, ?2)
           AND (?4 IS NULL OR c.display_name LIKE ?4 ESCAPE '\\'
                OR t.title LIKE ?4 ESCAPE '\\')
         ORDER BY t.last_activity_at DESC, t.id DESC LIMIT ?3",
    )?;
    let threads = stmt
        .query_map(params![at, id, limit.clamp(1, 1000), pattern], |row| {
            Ok((row_thread(row)?, row.get(14)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    tx.commit()?;
    Ok((threads, total))
}

pub fn threads(
    db: &Connection,
    connection_id: i64,
    before: Option<(i64, i64)>,
    limit: i64,
    title_pattern: Option<&str>,
) -> Result<Vec<ThreadHeader>> {
    let (at, id) = before.unwrap_or((i64::MAX, i64::MAX));
    let mut stmt = db.prepare(&format!(
        "SELECT {THREAD_COLS} FROM threads WHERE connection_id = ?1
         AND (last_activity_at,id) < (?2,?3)
         AND (?5 IS NULL OR title LIKE ?5 ESCAPE '\\')
         ORDER BY last_activity_at DESC,id DESC LIMIT ?4"
    ))?;
    let rows = stmt
        .query_map(
            params![connection_id, at, id, limit.clamp(1, 200), title_pattern],
            row_thread,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn calls(
    db: &Connection,
    thread_id: i64,
    before: Option<(i64, i64)>,
    limit: i64,
) -> Result<Vec<CallHeader>> {
    let (at, id) = before.unwrap_or((i64::MAX, i64::MAX));
    let mut stmt = db.prepare(&format!(
        "SELECT {CALL_COLS} FROM thread_calls WHERE thread_id = ?1
         AND (started_at,id) < (?2,?3) ORDER BY started_at DESC,id DESC LIMIT ?4"
    ))?;
    let rows = stmt
        .query_map(params![thread_id, at, id, limit.clamp(1, 201)], row_call)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn call_payload(
    db: &Connection,
    thread_id: i64,
    call_id: i64,
) -> Result<Option<(String, Option<String>)>> {
    Ok(db
        .query_row(
            "SELECT p.args_json, p.result_json FROM thread_calls c
         JOIN payloads p ON p.id = c.payload_id WHERE c.thread_id = ?1 AND c.id = ?2",
            params![thread_id, call_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

/// Retain the call headers permanently; drop large payloads after 90 days.
/// The caller runs this on the dedicated writer under a bounded transaction.
pub fn prune_payloads(
    tx: &rusqlite::Transaction<'_>,
    now: i64,
    retention_days: i64,
) -> Result<usize> {
    let cutoff = now - retention_days.max(1) * 86_400_000;
    let ids: Vec<i64> = {
        let mut stmt = tx.prepare(
            "SELECT payload_id FROM thread_calls INDEXED BY thread_calls_by_time
             WHERE started_at < ?1 AND payload_id IS NOT NULL AND status <> 'running' LIMIT 500",
        )?;
        let rows = stmt.query_map([cutoff], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    if ids.is_empty() {
        return Ok(0);
    }
    // SET NULL is provided by the payload_id FK; keep headers and all counters.
    for payload in &ids {
        tx.execute("DELETE FROM payloads WHERE id = ?1", [payload])?;
    }
    Ok(ids.len())
}
