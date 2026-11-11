//! Connection threads, tool call headers, and shared result validation.
use crate::{roots, state::AppState};
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Serialize, Serializer};
use serde_json::{json, value::RawValue, Value};
use std::{fs, io::Read, path::Path};
pub const MAX_TOOL_RESULT_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_ATTACHMENTS: usize = 16;
pub(crate) const MAX_ATTACHMENT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES: u64 = 32 * 1024 * 1024;
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn timestamp(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .expect("valid stored timestamp")
        .to_rfc3339()
}
fn cursor_time(time: &str) -> Result<i64> {
    Ok(chrono::DateTime::parse_from_rfc3339(time)?.timestamp_millis())
}
fn random_id() -> String {
    (uuid::Uuid::new_v4().as_u128() as u64 & i64::MAX as u64).to_string()
}
macro_rules! store_read {
    ($state:ident, [$($arg:ident),*], |$db:ident| $body:block) => {{
        $(let $arg = $arg.to_string();)*
        $state.store.read_blocking(move |$db| {
            $(let $arg = $arg.as_str();)*
            $body
        })
    }};
}
macro_rules! store_write {
    ($state:ident, [$($arg:ident),*], |$db:ident| $body:block) => {{
        $(let $arg = $arg.to_string();)*
        $state.store.write_blocking(move |$db| {
            $(let $arg = $arg.as_str();)*
            $body
        })
    }};
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCall {
    pub id: String,
    pub thread_id: String,
    pub source: String,
    pub tool: String,
    pub description: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
    #[serde(rename = "args", serialize_with = "serialize_json")]
    pub args_json: String,
    #[serde(rename = "result", serialize_with = "serialize_optional_json")]
    pub result_json: Option<String>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub metadata: Option<String>,
    pub error: Option<String>,
}

/// List row for the activity UI: everything except the (potentially large)
/// arguments and result, which are fetched per entry on demand.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCallHeader {
    pub id: String,
    pub thread_id: String,
    pub source: String,
    pub tool: String,
    pub description: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub metadata: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: String,
    pub cursor_id: String,
    pub title: String,
    pub client: String,
    pub started_at: String,
    pub last_activity_at: String,
    pub entry_count: usize,
    pub running_count: usize,
    pub working_remaining_ms: Option<i64>,
    pub error_count: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadsPage {
    pub threads: Vec<ThreadSummary>,
    pub total: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallsPage {
    pub entries: Vec<ThreadCallHeader>,
    pub total: usize,
    pub next_before: Option<String>,
}

pub struct AttachmentRecord {
    pub mime_type: String,
    pub bytes: u64,
}

/// A recorded tool result plus the byte size of each snapshotted attachment.
pub struct PreparedResult {
    pub result: Value,
    pub attachment_bytes: Vec<u64>,
    pub(crate) attachments: Vec<PreparedAttachment>,
}

fn serialize_json<S: Serializer>(
    value: &str,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    let raw: &RawValue = serde_json::from_str(value).map_err(serde::ser::Error::custom)?;
    raw.serialize(serializer)
}

fn serialize_optional_json<S: Serializer>(
    value: &Option<String>,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    match value {
        Some(value) => serialize_json(value, serializer),
        None => serializer.serialize_none(),
    }
}

#[derive(Clone)]
pub struct PendingStart {
    pub id: String,
    source: String,
    tool: String,
    description: String,
    started_at: i64,
    args_json: String,
    metadata: Option<String>,
    command: Option<String>,
    cwd: Option<String>,
}

pub fn start(
    state: &AppState,
    thread_id: &str,
    source: &str,
    tool: &str,
    args: &Value,
) -> Result<String> {
    let pending = prepare_start(source, tool, args)?;
    insert_start(state, thread_id, &pending)?;
    Ok(pending.id)
}

pub fn prepare_start(source: &str, tool: &str, args: &Value) -> Result<PendingStart> {
    let id = random_id();
    let description = match tool {
        "use_action" => crate::agent::tools::label(tool, args),
        "multi_tool_use_parallel" => format!(
            "Parallel tool call ({} calls)",
            args.get("calls")
                .and_then(Value::as_array)
                .context("Missing calls")?
                .len()
        ),
        _ => tool.to_string(),
    };
    if description.chars().count() > 120 {
        bail!("Tool description must be 120 characters or fewer");
    }
    Ok(PendingStart {
        id,
        source: source.to_string(),
        tool: tool.to_string(),
        description,
        started_at: now(),
        args_json: serde_json::to_string(args)?,
        metadata: call_metadata(tool, args),
        command: args.get("cmd").and_then(Value::as_str).map(str::to_string),
        cwd: args.get("cwd").and_then(Value::as_str).map(str::to_string),
    })
}

fn call_metadata(tool: &str, args: &Value) -> Option<String> {
    let path = match tool {
        "edit_files" => first_item_field(args, "edits", "path"),
        "read_files" | "write_files" => first_item_field(args, "files", "path"),
        "delete" | "mkdir" => first_item(args, "paths").and_then(Value::as_str),
        _ => args.get("path").and_then(Value::as_str),
    };
    let path = path.and_then(|value| {
        let path = Path::new(value);
        Some(format!(
            "{}/{}",
            path.parent()?.file_name()?.to_str()?,
            path.file_name()?.to_str()?
        ))
    });
    match tool {
        "read_files" | "write_files" => batch_metadata(args, "files", "files", path),
        "edit_files" => batch_metadata(args, "edits", "edits", path),
        "get_file_tree" | "delete" | "mkdir" => path,
        "search_files" => string_field(args, "query"),
        "search_file_contents" => string_field(args, "regex"),
        "search_actions" => {
            let joined = args
                .get("keywords")?
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ");
            (!joined.is_empty()).then_some(joined)
        }
        "use_action" => string_field(args, "action"),
        "check_job" | "cancel_job" => string_field(args, "job"),
        "use_skills" => batch_metadata(
            args,
            "skills",
            "skills",
            first_item_field(args, "skills", "skill").map(str::to_string),
        ),
        "read_skill_resources" => batch_metadata(
            args,
            "resources",
            "resources",
            first_item_field(args, "resources", "resource_path").map(str::to_string),
        ),
        _ => None,
    }
}

fn batch_metadata(
    args: &Value,
    field: &str,
    plural: &str,
    single: Option<String>,
) -> Option<String> {
    match args.get(field)?.as_array()?.len() {
        0 => None,
        1 => single,
        count => Some(format!("{count} {plural}")),
    }
}

fn first_item<'a>(args: &'a Value, field: &str) -> Option<&'a Value> {
    args.get(field)?.as_array()?.first()
}

fn first_item_field<'a>(args: &'a Value, array: &str, field: &str) -> Option<&'a str> {
    first_item(args, array)?.get(field)?.as_str()
}

fn string_field(args: &Value, field: &str) -> Option<String> {
    args.get(field)?.as_str().map(str::to_string)
}

#[derive(Clone)]
pub(crate) struct PreparedAttachment {
    pub name: String,
    pub mime: String,
    pub data: Vec<u8>,
    pub width: Option<i64>,
    pub height: Option<i64>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionClient {
    pub id: String,
    pub client: String,
    pub total: usize,
    pub threads: Vec<ThreadSummary>,
}
#[derive(Serialize)]
pub struct ConnectionClients {
    pub clients: Vec<ConnectionClient>,
}
fn thread_summary(
    t: crate::store::connections::ThreadHeader,
    client: &str,
    as_of: Option<i64>,
) -> ThreadSummary {
    // Only the active Connections list requests inferred activity. Everything
    // here comes from observed, persisted call boundaries; no history scan.
    const MAX_FOREGROUND_MS: i64 = 15 * 60_000;
    let working_remaining_ms = as_of.and_then(|now| {
        let deadline = if t.foreground_count > 0 {
            t.last_foreground_started_at?
                .saturating_add(MAX_FOREGROUND_MS)
        } else {
            t.last_foreground_end_at?
                .saturating_add(t.foreground_grace_ms)
        };
        let remaining = deadline.saturating_sub(now);
        (remaining > 0).then_some(remaining)
    });
    ThreadSummary {
        id: t.public_id,
        cursor_id: t.id.to_string(),
        title: t.title,
        client: client.into(),
        started_at: timestamp(t.started_at),
        last_activity_at: timestamp(t.last_activity_at),
        entry_count: t.call_count as usize,
        running_count: t.running_count as usize,
        working_remaining_ms,
        error_count: t.error_count as usize,
    }
}
pub fn list_connection_clients(state: &AppState, query: &str) -> Result<ConnectionClients> {
    let search = crate::store::connections::ThreadSearch::new(query);
    store_read!(state, [], |db| {
        let rows = crate::store::connections::list(db, search.as_ref())?;
        Ok(ConnectionClients {
            clients: rows
                .into_iter()
                .map(|r| ConnectionClient {
                    id: r.connection.id.to_string(),
                    client: r.connection.display_name.clone(),
                    total: r.connection.thread_count as usize,
                    threads: r
                        .threads
                        .into_iter()
                        .map(|t| thread_summary(t, &r.connection.display_name, None))
                        .collect(),
                })
                .collect(),
        })
    })
}
/// Globally paginated connection history, including matching client names.
pub fn list_all_threads(
    state: &AppState,
    limit: usize,
    before: Option<(&str, &str)>,
    query: &str,
) -> Result<ThreadsPage> {
    let before = before
        .map(|(time, id)| Ok::<_, anyhow::Error>((cursor_time(time)?, id.parse::<i64>()?)))
        .transpose()?;
    let search = crate::store::connections::ThreadSearch::new(query);
    store_read!(state, [], |db| {
        let (threads, total) = crate::store::connections::all_threads(
            db,
            before,
            limit.clamp(1, 1000) as i64,
            search.as_ref(),
        )?;
        let as_of = now();
        Ok(ThreadsPage {
            threads: threads
                .into_iter()
                .map(|(thread, client)| thread_summary(thread, &client, Some(as_of)))
                .collect(),
            total: total as usize,
        })
    })
}

pub fn list_threads(
    state: &AppState,
    client: &str,
    limit: usize,
    before: Option<(&str, &str)>,
    query: &str,
) -> Result<ThreadsPage> {
    let before = before
        .map(|(time, id)| Ok::<_, anyhow::Error>((cursor_time(time)?, id.to_owned())))
        .transpose()?;
    let search = crate::store::connections::ThreadSearch::new(query);
    store_read!(state, [client], |db| {
        let connection: Option<(i64, i64, String)> = db
            .query_row(
                "SELECT id,thread_count,display_name FROM connections WHERE id=?1",
                [client],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((id, mut total, name)) = connection else {
            return Ok(ThreadsPage {
                threads: vec![],
                total: 0,
            });
        };
        let filter = search
            .as_ref()
            .and_then(|search| search.title_filter(&name));
        if let Some(pattern) = filter {
            total = crate::store::connections::count_threads(db, id, pattern)?;
        }
        let before = before
            .map(|(at, id)| Ok::<_, anyhow::Error>((at, id.parse::<i64>()?)))
            .transpose()?;
        let threads = if limit == 0 {
            vec![]
        } else {
            crate::store::connections::threads(db, id, before, limit.min(50) as i64, filter)?
        };
        Ok(ThreadsPage {
            threads: threads
                .into_iter()
                .map(|t| thread_summary(t, client, None))
                .collect(),
            total: total as usize,
        })
    })
}
pub fn list_calls(
    state: &AppState,
    thread_id: &str,
    limit: usize,
    before: Option<&str>,
) -> Result<CallsPage> {
    let before = before
        .map(|s| {
            let (at, id) = s.split_once('|').context("Invalid call cursor")?;
            Ok::<_, anyhow::Error>((at.parse::<i64>()?, id.parse::<i64>()?))
        })
        .transpose()?;
    store_read!(state, [thread_id], |db| {
        let (thread, total): (i64, i64) = db.query_row(
            "SELECT id,call_count FROM threads WHERE public_id=?1",
            [thread_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let limit = limit.clamp(1, 200);
        let mut calls = crate::store::connections::calls(db, thread, before, limit as i64 + 1)?;
        let more = calls.len() > limit;
        calls.truncate(limit);
        let next_before = more
            .then(|| calls.last().map(|c| format!("{}|{}", c.started_at, c.id)))
            .flatten();
        Ok(CallsPage {
            entries: calls
                .into_iter()
                .map(|c| ThreadCallHeader {
                    id: c.id.to_string(),
                    thread_id: thread_id.into(),
                    source: c.source,
                    tool: c.tool,
                    description: c.description,
                    status: c.status,
                    started_at: timestamp(c.started_at),
                    finished_at: c.finished_at.map(timestamp),
                    duration_ms: c.duration_ms,
                    command: c.command,
                    cwd: c.cwd,
                    metadata: c.metadata,
                    error: c.error,
                })
                .collect(),
            total: total as usize,
            next_before,
        })
    })
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInfo {
    pub title: String,
    pub client: String,
}
pub fn thread_info(state: &AppState, id: &str) -> Result<Option<ThreadInfo>> {
    store_read!(state, [id], |db| {
        let sql = concat!(
            "SELECT t.title, c.display_name ",
            "FROM threads t ",
            "JOIN connections c ON c.id = t.connection_id ",
            "WHERE t.public_id = ?1",
        );
        let row = db
            .query_row(sql, [id], |r| {
                Ok(ThreadInfo {
                    title: r.get(0)?,
                    client: r.get(1)?,
                })
            })
            .optional()?;
        Ok(row)
    })
}
pub fn entry(state: &AppState, id: &str) -> Result<Option<ThreadCall>> {
    store_read!(state, [id], |db| {
        let sql = concat!(
            "SELECT c.id, t.public_id, c.source, c.tool, c.description, c.status, ",
            "c.started_at, c.finished_at, c.duration_ms, ",
            "p.args_json, p.result_json, c.command, c.cwd, c.metadata, c.error ",
            "FROM thread_calls c ",
            "JOIN threads t ON t.id = c.thread_id ",
            "LEFT JOIN payloads p ON p.id = c.payload_id ",
            "WHERE c.id = ?1",
        );
        let row = db
            .query_row(sql, [id], |r| {
                let id: i64 = r.get(0)?;
                let finished: Option<i64> = r.get(7)?;
                let args: Option<String> = r.get(9)?;
                Ok(ThreadCall {
                    id: id.to_string(),
                    thread_id: r.get(1)?,
                    source: r.get(2)?,
                    tool: r.get(3)?,
                    description: r.get(4)?,
                    status: r.get(5)?,
                    started_at: timestamp(r.get(6)?),
                    finished_at: finished.map(timestamp),
                    duration_ms: r.get(8)?,
                    args_json: args.unwrap_or_else(|| "null".into()),
                    result_json: r.get(10)?,
                    command: r.get(11)?,
                    cwd: r.get(12)?,
                    metadata: r.get(13)?,
                    error: r.get(14)?,
                })
            })
            .optional()?;
        Ok(row)
    })
}
/// Delete all recorded connection threads through the regular per-thread
/// cleanup path, including running jobs, payloads and change notifications.
pub fn delete_all_threads(state: &AppState) -> Result<usize> {
    let ids = store_read!(state, [], |db| {
        let mut statement = db.prepare("SELECT public_id FROM threads ORDER BY id")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })?;
    let mut deleted = 0;
    for id in ids {
        delete_thread(state, &id)
            .with_context(|| format!("Deleted {deleted} threads before failing on thread {id}"))?;
        deleted += 1;
    }
    Ok(deleted)
}

pub fn delete_thread(state: &AppState, id: &str) -> Result<()> {
    state.jobs.delete_thread(id);
    store_write!(state, [id], |db| {
        let (thread, rev): (i64, i64) =
            db.query_row("SELECT id,rev FROM threads WHERE public_id=?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
        db.execute("DELETE FROM threads WHERE id=?1", [thread])?;
        crate::store::changes::append(db, "thread", thread, rev + 1, true, now())?;
        Ok(())
    })
}
pub fn create_thread(state: &AppState, title: &str, client: &str) -> Result<String> {
    let title = title.trim();
    validate_thread_field(title, "title")?;
    validate_thread_field(client, "client")?;
    let id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
    let saved = id.clone();
    store_write!(state, [title, client], |db| {
        let client = client.trim();
        let insert_connection_sql = concat!(
            "INSERT INTO connections(client_key, display_name, created_at, last_activity_at) ",
            "VALUES (?1, ?1, ?2, ?2) ",
            "ON CONFLICT(client_key) DO NOTHING",
        );
        db.execute(insert_connection_sql, params![client, now()])?;
        let insert_thread_sql = concat!(
            "INSERT INTO threads(public_id, connection_id, title, started_at, last_activity_at, rev) ",
            "VALUES (?1, (SELECT id FROM connections WHERE client_key = ?2), ?3, ?4, ?4, 1)",
        );
        db.execute(insert_thread_sql, params![saved, client, title, now()])?;
        let thread = db.last_insert_rowid();
        crate::store::changes::append(db, "thread", thread, 1, false, now())?;
        Ok(())
    })?;
    Ok(id)
}
fn validate_thread_field(value: &str, field: &str) -> Result<()> {
    anyhow::ensure!(!value.trim().is_empty(), "Thread {field} is required");
    anyhow::ensure!(
        value.chars().count() <= 120,
        "Thread {field} must be 120 characters or fewer"
    );
    Ok(())
}
pub fn thread_exists(state: &AppState, id: &str) -> Result<bool> {
    store_read!(state, [id], |db| {
        Ok(db
            .prepare("SELECT 1 FROM threads WHERE public_id=?1")?
            .exists([id])?)
    })
}
fn thread_change(db: &rusqlite::Transaction<'_>, thread: i64) -> Result<()> {
    let rev = db.query_row("SELECT rev FROM threads WHERE id=?1", [thread], |r| {
        r.get(0)
    })?;
    crate::store::changes::append(db, "thread", thread, rev, false, now())?;
    Ok(())
}
pub fn insert_start(state: &AppState, thread_id: &str, pending: &PendingStart) -> Result<()> {
    let p = pending.clone();
    store_write!(state, [thread_id], |db| {
        let thread_row: i64 = db
            .query_row(
                "SELECT id FROM threads WHERE public_id=?1",
                [thread_id],
                |r| r.get(0),
            )
            .optional()?
            .context("Unknown thread_id.")?;
        db.execute("INSERT INTO payloads(args_json) VALUES (?1)", [p.args_json])?;
        let payload = db.last_insert_rowid();
        let insert_call_sql = concat!(
            "INSERT INTO thread_calls(id, thread_id, source, tool, description, status, ",
            "started_at, payload_id, command, cwd, metadata) ",
            "VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6, ?7, ?8, ?9, ?10)",
        );
        db.execute(
            insert_call_sql,
            params![
                p.id,
                thread_row,
                p.source,
                p.tool,
                p.description,
                p.started_at,
                payload,
                p.command,
                p.cwd,
                p.metadata
            ],
        )?;
        crate::store::activity::started(db, thread_row, &p.tool, p.started_at)?;
        thread_change(db, thread_row)?;
        Ok(())
    })
}
pub(crate) fn finish(
    state: &AppState,
    id: &str,
    result: Value,
    slots: &[crate::tools::AttachmentSlot],
) -> Result<PreparedResult> {
    finish_with_slots(state, id, result, slots)
}
pub(crate) fn finish_with_slots(
    state: &AppState,
    id: &str,
    result: Value,
    slots: &[crate::tools::AttachmentSlot],
) -> Result<PreparedResult> {
    let p = prepare_result(state, id, result, slots)?;
    finish_prepared(state, id, p)
}
pub(crate) fn finish_prepared(
    state: &AppState,
    id: &str,
    mut prepared: PreparedResult,
) -> Result<PreparedResult> {
    let blobs = state.store.blobs.clone();
    store_write!(state, [id], |db| {
        let (thread, payload, promoted): (i64, i64, Option<i64>) = db.query_row(
            "SELECT thread_id,payload_id,promoted_at FROM thread_calls WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        persist_result(db, &blobs, payload, &mut prepared)?;
        let error = result_error(&prepared.result);
        let status = if error.is_some() {
            "error"
        } else {
            "completed"
        };
        let update_sql = concat!(
            "UPDATE thread_calls ",
            "SET status = ?2, error = ?3, finished_at = ?4, ",
            "duration_ms = MAX(0, ?4 - started_at) ",
            "WHERE id = ?1",
        );
        let finished_at = now();
        db.execute(update_sql, params![id, status, error, finished_at])?;
        if promoted.is_none() {
            crate::store::activity::ended(db, thread, finished_at)?;
        }
        if let Some(old) = db
            .query_row(
                "SELECT payload_id FROM jobs WHERE public_id=?1 AND thread_id=?2",
                params![id, thread],
                |r| r.get::<_, Option<i64>>(0),
            )
            .optional()?
            .flatten()
        {
            let copy = crate::store::blobs::copy_payload(db, payload)?;
            db.execute(
                "UPDATE jobs SET payload_id=?2,state=?3,finished_at=?4 WHERE public_id=?1",
                params![id, copy, status, now()],
            )?;
            db.execute("DELETE FROM payloads WHERE id=?1", [old])?;
        }
        thread_change(db, thread)?;
        Ok(prepared)
    })
}
pub(crate) fn persist_result(
    db: &Connection,
    blobs: &crate::store::blobs::BlobStore,
    payload: i64,
    prepared: &mut PreparedResult,
) -> Result<()> {
    for (idx, a) in prepared.attachments.iter().enumerate() {
        let hash = blobs.put_in(db, &a.data, &a.mime, now())?;
        let insert_sql = concat!(
            "INSERT INTO result_attachments(",
            "payload_id, idx, name, mime_type, bytes, width, height, blob_hash",
            ") VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        );
        let byte_len = a.data.len() as i64;
        db.execute(
            insert_sql,
            params![payload, idx as i64, a.name, a.mime, byte_len, a.width, a.height, hash],
        )?;
        prepared.result["attachments"][idx]["hash"] = json!(hash);
        prepared.result["attachments"][idx]["url"] = json!(format!("/attachments/{hash}"));
        prepared.result["attachments"][idx]
            .as_object_mut()
            .context("attachment metadata")?
            .remove("path");
    }
    db.execute(
        "UPDATE payloads SET result_json=?2,model_text=?3 WHERE id=?1",
        params![
            payload,
            serde_json::to_string(&prepared.result)?,
            crate::agent::tools::render_for_model(&prepared.result)
        ],
    )?;
    Ok(())
}
pub(crate) fn prepare_result(
    state: &AppState,
    _id: &str,
    mut result: Value,
    slots: &[crate::tools::AttachmentSlot],
) -> Result<PreparedResult> {
    if serde_json::to_vec(&result)?.len() > MAX_TOOL_RESULT_BYTES
        && !truncate_canonical_text(&mut result, MAX_TOOL_RESULT_BYTES)?
    {
        // Structured results and binary attachments cannot be safely
        // truncated without changing their meaning or violating schemas.
        result = error_result(format!("Tool result exceeds {MAX_TOOL_RESULT_BYTES} bytes"));
    }
    let attachments = match snapshot_attachments(state, &result, slots) {
        Ok(a) => a,
        Err(error) => {
            result = error_result(error);
            vec![]
        }
    };
    Ok(PreparedResult {
        result,
        attachment_bytes: attachments.iter().map(|a| a.data.len() as u64).collect(),
        attachments,
    })
}
/// Trim only known human-readable fields in oversized canonical results.
/// Preserve the enclosing JSON shape, non-text fields and attachment metadata.
/// This is a final safety net; producers should still enforce their own limits.
fn truncate_canonical_text(result: &mut Value, max_bytes: usize) -> Result<bool> {
    if !canonical_result(result) {
        return Ok(false);
    }

    let content = &result["structuredContent"];
    let mut paths = ["stdout", "stderr", "result", "text", "content"]
        .into_iter()
        .filter(|name| content.get(name).and_then(Value::as_str).is_some())
        .map(|name| format!("/structuredContent/{name}"))
        .collect::<Vec<_>>();
    if let Some(files) = content.get("files").and_then(Value::as_array) {
        for (index, file) in files.iter().enumerate() {
            if file.get("content").and_then(Value::as_str).is_some() {
                paths.push(format!("/structuredContent/files/{index}/content"));
            }
        }
    }
    paths.sort_by_key(|path| {
        std::cmp::Reverse(
            result
                .pointer(path)
                .and_then(Value::as_str)
                .map_or(0, str::len),
        )
    });
    for path in paths {
        if serde_json::to_vec(result)?.len() <= max_bytes {
            return Ok(true);
        }
        let original = result
            .pointer(&path)
            .and_then(Value::as_str)
            .context("missing canonical text field")?
            .to_owned();
        // Do not introduce new fields into schema-validated Plugin results.
        // Mark known existing flags; the text marker handles other shapes.
        if path == "/structuredContent/stdout"
            && result["structuredContent"]["stdoutTruncated"].is_boolean()
        {
            result["structuredContent"]["stdoutTruncated"] = json!(true);
        } else if path == "/structuredContent/stderr"
            && result["structuredContent"]["stderrTruncated"].is_boolean()
        {
            result["structuredContent"]["stderrTruncated"] = json!(true);
        }
        if result["structuredContent"]["truncated"].is_boolean() {
            result["structuredContent"]["truncated"] = json!(true);
        }
        // No retained prefix can exceed the entire result budget. Do not
        // allocate one offset per character of an arbitrarily large tool
        // output; keep this search itself bounded.
        let mut upper = max_bytes.min(original.len());
        while !original.is_char_boundary(upper) {
            upper -= 1;
        }
        let mut boundaries = original[..upper]
            .char_indices()
            .map(|(i, _)| i)
            .collect::<Vec<_>>();
        boundaries.push(upper);

        let candidate = |kept: usize| {
            let prefix = &original[..boundaries[kept]];
            format!(
                "{prefix}\n[output truncated: {} bytes omitted]",
                original.len() - prefix.len()
            )
        };
        // Replace this field with the smallest marked value first. If the
        // remaining fields still exceed the budget, keep that marker and
        // proceed to the next field.
        let mut lo = 0;
        let mut hi = boundaries.len() - 1;
        *result.pointer_mut(&path).unwrap() = json!(candidate(0));
        if serde_json::to_vec(result)?.len() > max_bytes {
            continue;
        }
        while lo < hi {
            let mid = lo + (hi - lo + 1) / 2;
            *result.pointer_mut(&path).unwrap() = json!(candidate(mid));
            if serde_json::to_vec(result)?.len() <= max_bytes {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        *result.pointer_mut(&path).unwrap() = json!(candidate(lo));
        return Ok(true);
    }
    Ok(serde_json::to_vec(result)?.len() <= max_bytes)
}

fn snapshot_attachments(
    state: &AppState,
    result: &Value,
    slots: &[crate::tools::AttachmentSlot],
) -> Result<Vec<PreparedAttachment>> {
    anyhow::ensure!(
        canonical_result(result),
        "Tool producer returned an invalid canonical result"
    );
    let Some(attachments) = result["attachments"].as_array() else {
        if !slots.is_empty() {
            anyhow::bail!("Attachment slots without attachments");
        }
        return Ok(vec![]);
    };
    anyhow::ensure!(
        attachments.len() <= MAX_ATTACHMENTS,
        "Tool result exceeds attachment limit"
    );
    if slots.len() != attachments.len() {
        anyhow::bail!(
            "Attachment count {} does not match slots {}",
            attachments.len(),
            slots.len()
        );
    }
    let roots = roots::snapshot(state)?;
    let cache = state.config.storage.attachments_dir();
    let mut total = 0;
    let mut prepared = vec![];
    for (idx, a) in attachments.iter().enumerate() {
        let mime = a["mimeType"]
            .as_str()
            .context("Attachment MIME type is required")?;
        anyhow::ensure!(valid_mime_type(mime), "Invalid attachment MIME type");
        let slot = &slots[idx];
        let data = if let Some(data) = &slot.bytes {
            data.clone()
        } else {
            let path =
                fs::canonicalize(a["path"].as_str().context("Attachment path is required")?)?;
            let staging = slot.staging.as_ref().and_then(|p| fs::canonicalize(p).ok());
            anyhow::ensure!(
                roots.visible().iter().any(|r| path.starts_with(r))
                    || path.starts_with(&cache)
                    || staging.is_some_and(|s| path.starts_with(s)),
                "Attachment is outside enabled roots, attachment cache and invocation staging"
            );
            let file = fs::File::open(&path)?;
            anyhow::ensure!(
                file.metadata()?.is_file(),
                "Attachment must be a regular file"
            );
            let mut bytes = vec![];
            file.take(MAX_ATTACHMENT_BYTES + 1)
                .read_to_end(&mut bytes)?;
            bytes
        };
        total += data.len() as u64;
        anyhow::ensure!(
            data.len() as u64 <= MAX_ATTACHMENT_BYTES && total <= MAX_TOTAL_ATTACHMENT_BYTES,
            "Attachments exceed byte limit"
        );
        let name = a["name"]
            .as_str()
            .or_else(|| {
                a["path"]
                    .as_str()
                    .and_then(|p| Path::new(p).file_name()?.to_str())
            })
            .unwrap_or("attachment")
            .to_owned();
        prepared.push(PreparedAttachment {
            name,
            mime: mime.into(),
            data,
            width: a["width"].as_i64(),
            height: a["height"].as_i64(),
        });
    }
    Ok(prepared)
}
pub(crate) fn valid_mime_type(value: &str) -> bool {
    value.split_once('/').is_some_and(|(kind, sub)| {
        !kind.is_empty()
            && !sub.is_empty()
            && !sub.contains('/')
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-/".contains(&b))
    })
}
pub(crate) fn error_result(error: impl ToString) -> Value {
    json!({"error":{"message":error.to_string()}})
}
pub(crate) fn result_error(value: &Value) -> Option<&str> {
    value.get("error")?.get("message")?.as_str()
}
pub(crate) fn canonical_result(value: &Value) -> bool {
    value.as_object().is_some_and(|r| {
        r.get("structuredContent").is_some_and(Value::is_object)
            && r.get("attachments").is_none_or(Value::is_array)
            && r.keys()
                .all(|k| matches!(k.as_str(), "structuredContent" | "attachments"))
            || result_error(value).is_some()
                && r.len() == 1
                && value["error"].as_object().is_some_and(|e| e.len() == 1)
    })
}
pub fn attachment(state: &AppState, id: &str, index: usize) -> Result<(AttachmentRecord, Vec<u8>)> {
    let blobs = state.store.blobs.clone();
    store_read!(state, [id], |db| {
        let sql = concat!(
            "SELECT a.mime_type, a.blob_hash ",
            "FROM result_attachments a ",
            "JOIN thread_calls c ON c.payload_id = a.payload_id ",
            "WHERE c.id = ?1 AND a.idx = ?2",
        );
        let index = index as i64;
        let (mime, hash): (String, String) =
            db.query_row(sql, params![id, index], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let bytes = fs::read(blobs.path(&hash)?)?;
        let record = AttachmentRecord {
            mime_type: mime,
            bytes: bytes.len() as u64,
        };
        Ok((record, bytes))
    })
}
pub fn attachments(state: &AppState, id: &str) -> Result<Vec<AttachmentRecord>> {
    store_read!(state, [id], |db| {
        let sql = concat!(
            "SELECT a.mime_type, a.bytes ",
            "FROM result_attachments a ",
            "JOIN thread_calls c ON c.payload_id = a.payload_id ",
            "WHERE c.id = ?1 ",
            "ORDER BY a.idx",
        );
        let rows = db
            .prepare(sql)?
            .query_map([id], |r| {
                let mime_type = r.get(0)?;
                let bytes: i64 = r.get(1)?;
                Ok(AttachmentRecord {
                    mime_type,
                    bytes: bytes as u64,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}
pub fn interrupt_running(state: &AppState) -> Result<()> {
    store_write!(state, [], |db| {
        let calls = db
            .prepare("SELECT id,payload_id FROM thread_calls WHERE status='running'")?
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, payload) in calls {
            let result = error_result(format!(
                "Job {id} was interrupted because Squire restarted."
            ));
            db.execute(
                "UPDATE payloads SET result_json=?2,model_text=?3 WHERE id=?1",
                params![
                    payload,
                    serde_json::to_string(&result)?,
                    crate::agent::tools::render_for_model(&result)
                ],
            )?;
            let update_sql = concat!(
                "UPDATE thread_calls ",
                "SET status = 'interrupted', error = ?2, ",
                "finished_at = ?3, ",
                "duration_ms = MAX(0, ?3 - started_at) ",
                "WHERE id = ?1 ",
                "RETURNING thread_id",
            );
            let thread: i64 =
                db.query_row(update_sql, params![id, result_error(&result), now()], |r| {
                    r.get(0)
                })?;
            thread_change(db, thread)?;
        }
        // Interrupted calls have no trustworthy foreground end timestamp.
        db.execute(
            "UPDATE threads SET foreground_count=0,
                    last_foreground_started_at=NULL, last_foreground_end_at=NULL,
                    current_batch_has_ordinary=0, last_batch_had_ordinary=0
             WHERE foreground_count>0",
            [],
        )?;
        Ok(())
    })
}
pub(crate) fn mark_job(state: &AppState, id: &str) -> Result<()> {
    store_write!(state, [id], |db| {
        let select_sql = concat!(
            "SELECT thread_id, payload_id, COALESCE(action, tool), started_at ",
            "FROM thread_calls ",
            "WHERE id = ?1",
        );
        let (thread, payload, action, started): (i64, i64, String, i64) =
            db.query_row(select_sql, [id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?;
        let payload = crate::store::blobs::copy_payload(db, payload)?;
        let insert_sql = concat!(
            "INSERT INTO jobs(public_id, thread_id, action, state, started_at, payload_id) ",
            "VALUES (?1, ?2, ?3, 'running', ?4, ?5)",
        );
        db.execute(insert_sql, params![id, thread, action, started, payload])?;
        let promoted_at = now();
        db.execute(
            "UPDATE thread_calls SET promoted_at=?2 WHERE id=?1",
            params![id, promoted_at],
        )?;
        crate::store::activity::ended(db, thread, promoted_at)?;
        Ok(())
    })
}
pub(crate) fn mark_job_cancelled(state: &AppState, id: &str) -> Result<()> {
    store_write!(state, [id], |db| {
        db.execute("UPDATE jobs SET state='cancelled' WHERE public_id=?1", [id])?;
        Ok(())
    })
}
pub(crate) fn job_cancelled(state: &AppState, id: &str) -> Result<Option<bool>> {
    store_read!(state, [id], |db| {
        Ok(db
            .query_row(
                "SELECT state='cancelled' FROM jobs WHERE public_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?)
    })
}

pub(crate) fn recorded_job(state: &AppState, id: &str) -> Result<crate::tools::ProducedResult> {
    let blobs = state.store.blobs.clone();
    store_read!(state, [id], |db| {
        let sql = concat!(
            "SELECT j.payload_id, p.result_json ",
            "FROM jobs j ",
            "JOIN payloads p ON p.id = j.payload_id ",
            "WHERE j.public_id = ?1 AND j.thread_id IS NOT NULL",
        );
        let (payload, json): (i64, Option<String>) = db
            .query_row(sql, [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?
            .with_context(|| format!("No job {id}."))?;
        let hashes = db
            .prepare("SELECT blob_hash FROM result_attachments WHERE payload_id=?1 ORDER BY idx")?
            .query_map([payload], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(crate::tools::ProducedResult {
            result: serde_json::from_str(&json.context("Job has no recorded result")?)?,
            attachments: hashes
                .into_iter()
                .map(|hash| {
                    Ok(crate::tools::AttachmentSlot {
                        staging: None,
                        bytes: Some(std::fs::read(blobs.path(&hash)?)?),
                    })
                })
                .collect::<Result<_>>()?,
            recorded: false,
        })
    })
}
