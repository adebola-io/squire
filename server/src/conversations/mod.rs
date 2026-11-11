//! Conversation domain operations on the unified local store.
use crate::{
    providers::types::{ContentPart, Message, ModelRef, Role, Usage},
    state::AppState,
};
use anyhow::{bail, Context, Result};
use rusqlite::{params, types::Type, Connection, OptionalExtension, Row};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
pub const PROMPT_VERSION: i64 = 3;
pub const OUTCOME_UNKNOWN: &str = "Outcome unknown: Squire stopped while this was running.";

macro_rules! store_read {
    ($state:ident, [$($arg:ident),*], |$db:ident| $body:block) => {{
        $(let $arg = $arg.to_string();)*
        $state.store.read_blocking(move |$db| { $(let $arg = $arg.as_str();)* $body })
    }};
}
macro_rules! store_write {
    ($state:ident, [$($arg:ident),*], |$db:ident| $body:block) => {{
        $(let $arg = $arg.to_string();)*
        $state.store.write_blocking(move |$db| { $(let $arg = $arg.as_str();)* $body })
    }};
}
pub(crate) mod artifacts;
pub mod events;
pub mod http;
pub mod remember;

/// Errors callers need to tell apart (mapped to HTTP statuses).
#[derive(Debug, PartialEq, Eq)]
pub enum StoreError {
    NotFound,
    /// The Conversation already has an active execution.
    Busy,
    EditBlocked,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::NotFound => write!(f, "conversation_not_found"),
            StoreError::Busy => write!(f, "conversation_busy"),
            StoreError::EditBlocked => write!(
                f,
                "This message cannot be edited because it was compacted into an earlier \
                 epoch. Branch from here instead."
            ),
        }
    }
}

impl std::error::Error for StoreError {}

/// A stored value this build does not understand.
#[derive(Debug)]
struct CorruptValue {
    column: &'static str,
    value: String,
}

impl std::fmt::Display for CorruptValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Unrecognized stored {}: {:?}", self.column, self.value)
    }
}

impl std::error::Error for CorruptValue {}

fn corrupt(index: usize, column: &'static str, value: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        index,
        Type::Text,
        Box::new(CorruptValue {
            column,
            value: value.into(),
        }),
    )
}

fn decode_json<T: DeserializeOwned>(index: usize, text: &str) -> rusqlite::Result<T> {
    serde_json::from_str(text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(error))
    })
}

fn json_column<T: DeserializeOwned>(row: &Row, index: usize) -> rusqlite::Result<T> {
    decode_json(index, &row.get::<_, String>(index)?)
}

crate::text_enum! {
    pub enum ExecutionStatus {
        Idle = "idle",
        Running = "running",
        Stopped = "stopped",
        Error = "error",
        Interrupted = "interrupted",
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub rev: i64,
    pub active_epoch_start_seq: i64,
    pub last_seq: i64,
    pub title: String,
    pub title_source: String,
    pub created_at: String,
    pub updated_at: String,
    pub current_model: Option<ModelRef>,
    pub execution_status: ExecutionStatus,
    pub execution_started_at: Option<String>,
    pub execution_error: Option<String>,
    /// The latest sidebar-worthy Message's text on one line.
    pub preview: Option<String>,
    /// Search-only: the title with match markers, when the title matched.
    pub title_highlight: Option<String>,
    /// Search-only: the most recent matching message with match markers.
    pub match_excerpt: Option<String>,
    pub last_seen_seq: i64,
    pub unread: bool,
    pub branched_from_conversation: Option<String>,
    pub branched_from_message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: String,
    /// Client idempotency key for sent Messages; null for model output.
    pub client_message_id: Option<String>,
    pub epoch_id: Option<String>,
    pub seq: Option<i64>,
    pub role: Role,
    pub created_at: String,
    /// When work on this request began. Unlike created_at, resets on edits.
    pub response_started_at: Option<String>,
    pub model: Option<ModelRef>,
    /// Text and reasoning. Tool calls live only in `tool_calls`.
    pub parts: Vec<ContentPart>,
    pub usage: Option<Usage>,
    pub status: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCallRecord>,
    pub attachments: Vec<remember::MessageAttachment>,
    pub editable: bool,
    pub has_reasoning: bool,
    /// A user Message sent while Squire worked that joined the run in
    /// progress instead of starting one: it belongs to that run's turn.
    pub joined_run: bool,
}

crate::text_enum! {
    /// Lifecycle of one durable ToolCall.
    pub enum ToolCallStatus {
        Pending = "pending",
        Running = "running",
        Completed = "completed",
        Error = "error",
        Skipped = "skipped",
        Interrupted = "interrupted",
    }
}

/// The single durable record of one tool call, a child of the assistant
/// Message that requested it. Owns arguments, result, status and timing;
/// provider-facing tool-call and tool-result parts are synthesized from it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRecord {
    pub id: String,
    pub message_id: String,
    pub call_id: String,
    pub tool: String,
    pub label: String,
    pub plugin_id: Option<String>,
    pub action: Option<String>,
    pub args: Value,
    pub result: Option<Value>,
    pub status: ToolCallStatus,
    pub mutative: bool,
    pub error: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
}

/// A tool call requested by a completed assistant response.
#[derive(Clone)]
pub struct NewToolCall {
    pub call_id: String,
    pub tool: String,
    pub label: String,
    pub args: Value,
    pub mutative: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub conversation: Conversation,
    pub messages: Vec<StoredMessage>,
    /// User Messages waiting to join model context, in queue order.
    pub queued: Vec<StoredMessage>,
    pub jobs: Vec<artifacts::ConversationJob>,
    pub next_before: Option<i64>,
    pub revision: i64,
}

/// What the model sees for the active Epoch.
#[derive(Clone)]
pub struct ActiveContext {
    pub last_seq: i64,
    pub system_prompt: String,
    pub messages: Vec<Message>,
}

/// User Messages that just joined the transcript, with the native options
/// to use from now on: those sent with the latest of them.
pub struct Consumed {
    pub messages: Vec<StoredMessage>,
    pub native_options: Value,
}

/// A started turn: earlier queued Messages (if any) then the new one.
pub struct Turn {
    pub earlier: Vec<StoredMessage>,
    pub message: StoredMessage,
}

pub(crate) fn is_inline_image(mime: &str) -> bool {
    matches!(
        mime,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    )
}
pub(crate) fn is_text_like(mime: &str) -> bool {
    mime.starts_with("text/") || matches!(mime, "application/json" | "application/xml")
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn timestamp(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .expect("valid stored timestamp")
        .to_rfc3339()
}
fn time_column(row: &Row, col: usize) -> rusqlite::Result<Option<String>> {
    Ok(row.get::<_, Option<i64>>(col)?.map(timestamp))
}
fn id_column(row: &Row, col: usize) -> rusqlite::Result<String> {
    Ok(row.get::<_, i64>(col)?.to_string())
}
fn model_column(row: &Row, profile: usize, model: usize) -> rusqlite::Result<Option<ModelRef>> {
    match (
        row.get::<_, Option<String>>(profile)?,
        row.get::<_, Option<String>>(model)?,
    ) {
        (Some(profile_id), Some(model_id)) => Ok(Some(ModelRef {
            profile_id,
            model_id,
        })),
        (None, None) => Ok(None),
        _ => Err(corrupt(profile, "model reference", "half-set")),
    }
}
fn profile_id(db: &Connection, model: &ModelRef) -> Result<i64> {
    Ok(db.query_row(
        "SELECT id FROM provider_profiles WHERE public_id=?1",
        [&model.profile_id],
        |r| r.get(0),
    )?)
}
fn plain_text(parts: &[ContentPart]) -> String {
    parts
        .iter()
        .filter_map(|p| match p {
            ContentPart::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}
// Recognize complete HTML tags anywhere in assistant output, including after
// Markdown prose. Literal less-than signs and unfinished tags remain text.
fn html_tag_end(input: &str) -> Option<usize> {
    let bytes = input.as_bytes();
    if bytes.starts_with(b"<!--") {
        return input.find("-->").map(|end| end + 3);
    }
    let mut index = 1;
    if bytes.get(index) == Some(&b'/') {
        index += 1;
    }
    if !bytes.get(index)?.is_ascii_alphabetic() {
        return None;
    }
    while bytes
        .get(index)
        .is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'-')
    {
        index += 1;
    }
    if !matches!(
        bytes.get(index)?,
        b'>' | b'/' | b' ' | b'\n' | b'\r' | b'\t'
    ) {
        return None;
    }
    let mut quote = None;
    for (offset, &byte) in bytes.iter().enumerate().skip(index) {
        if let Some(delimiter) = quote {
            if byte == delimiter {
                quote = None;
            }
        } else if byte == b'"' || byte == b'\'' {
            quote = Some(byte);
        } else if byte == b'>' {
            return Some(offset + 1);
        }
    }
    None
}

fn assistant_preview_text(text: &str) -> String {
    let mut visible = String::new();
    let mut cursor = 0;
    while let Some(offset) = text[cursor..].find('<') {
        let start = cursor + offset;
        visible.push_str(&text[cursor..start]);
        if let Some(length) = html_tag_end(&text[start..]) {
            visible.push(' ');
            cursor = start + length;
        } else {
            visible.push('<');
            cursor = start + 1;
        }
    }
    visible.push_str(&text[cursor..]);
    visible
}

fn preview(text: &str, role: &str) -> Option<String> {
    let visible = if role == "assistant" {
        assistant_preview_text(text)
    } else {
        text.to_owned()
    };
    let line = visible.split_whitespace().collect::<Vec<_>>().join(" ");
    (!line.is_empty()).then(|| line.chars().take(100).collect())
}

/// Rebuild stored previews once, as part of the database migration.
/// Reusing refresh_preview preserves queued-message priority and role-aware
/// formatting without retaining message bodies in memory.
pub(crate) fn repair_stored_previews(db: &Connection) -> rusqlite::Result<()> {
    let ids = {
        let mut stmt = db.prepare("SELECT id FROM conversations WHERE preview IS NOT NULL")?;
        let rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for id in ids {
        refresh_preview(db, &id.to_string())?;
    }
    Ok(())
}

fn text_parts(text: &str) -> Result<String> {
    Ok(serde_json::to_string(&vec![ContentPart::Text {
        text: text.into(),
    }])?)
}
fn options_json(options: &Value) -> Result<Option<String>> {
    Ok((!options.is_null())
        .then(|| serde_json::to_string(options))
        .transpose()?)
}
fn expect_one(changed: usize, what: &str) -> Result<()> {
    anyhow::ensure!(changed == 1, "Expected one {what}, updated {changed}");
    Ok(())
}
/// Called inside the transaction that changed the object.
fn touch(db: &rusqlite::Transaction<'_>, id: &str) -> Result<i64> {
    let rev = db.query_row(
        "UPDATE conversations SET rev=rev+1 WHERE id=?1 RETURNING rev",
        [id],
        |r| r.get(0),
    )?;
    crate::store::changes::append(db, "conversation", id.parse()?, rev, false, now())?;
    Ok(rev)
}
const CONVERSATION_COLUMNS: &str = concat!(
    "c.id, c.title, c.title_source, c.created_at, c.updated_at, ",
    "p.public_id, c.model_id, c.exec_status, c.exec_started_at, c.exec_error, ",
    "c.preview, c.last_seen_seq, c.unread, c.parent_conversation_id, ",
    "(SELECT pm.id FROM messages pm ",
    "WHERE pm.conversation_id = c.parent_conversation_id AND pm.seq = c.parent_seq), ",
    "c.rev, c.active_epoch_start_seq, c.last_seq",
);
fn conversation_from_row(r: &Row) -> rusqlite::Result<Conversation> {
    let status: String = r.get(7)?;
    Ok(Conversation {
        id: id_column(r, 0)?,
        title: r.get(1)?,
        title_source: r.get(2)?,
        created_at: timestamp(r.get(3)?),
        updated_at: timestamp(r.get(4)?),
        current_model: model_column(r, 5, 6)?,
        execution_status: ExecutionStatus::parse(&status)
            .ok_or_else(|| corrupt(7, "exec_status", status))?,
        execution_started_at: time_column(r, 8)?,
        execution_error: r.get(9)?,
        preview: r.get(10)?,
        last_seen_seq: r.get(11)?,
        unread: r.get(12)?,
        branched_from_conversation: r.get::<_, Option<i64>>(13)?.map(|n| n.to_string()),
        branched_from_message: r.get::<_, Option<i64>>(14)?.map(|n| n.to_string()),
        rev: r.get(15)?,
        active_epoch_start_seq: r.get(16)?,
        last_seq: r.get(17)?,
        title_highlight: None,
        match_excerpt: None,
    })
}
fn get_conversation(db: &Connection, id: &str) -> Result<Option<Conversation>> {
    let sql = format!(
        "SELECT {CONVERSATION_COLUMNS} \
         FROM conversations c \
         LEFT JOIN provider_profiles p ON p.id = c.model_profile_id \
         WHERE c.id = ?1"
    );
    let row = db.query_row(&sql, [id], conversation_from_row).optional()?;
    Ok(row)
}
fn next_seq(db: &Connection, id: &str) -> Result<i64> {
    Ok(db.query_row(
        "SELECT last_seq+1 FROM conversations WHERE id=?1",
        [id],
        |r| r.get(0),
    )?)
}
fn active_epoch(db: &Connection, id: &str) -> Result<String> {
    let sql = concat!(
        "SELECT e.id ",
        "FROM epochs e ",
        "JOIN conversations c ON c.id = e.conversation_id ",
        "AND c.active_epoch_start_seq = e.start_seq ",
        "WHERE c.id = ?1",
    );
    let epoch = db.query_row(sql, [id], |r| id_column(r, 0))?;
    Ok(epoch)
}
const MESSAGE_COLUMNS: &str = concat!(
    "m.id, ",
    "(SELECT e.id FROM epochs e ",
    "WHERE e.conversation_id = m.conversation_id AND e.start_seq <= m.seq ",
    "ORDER BY e.start_seq DESC LIMIT 1), ",
    "m.seq, m.role, m.created_at, p.public_id, m.model_id, m.text, ",
    "m.response_started_at, m.has_reasoning, ",
    "mc.input_tokens, mc.output_tokens, mc.cache_read_tokens, mc.cache_write_tokens, ",
    "m.joined_run, m.client_message_id",
);
fn message_from_row(r: &Row) -> rusqlite::Result<StoredMessage> {
    let role: String = r.get(3)?;
    let text: String = r.get(7)?;
    Ok(StoredMessage {
        id: id_column(r, 0)?,
        client_message_id: r.get(15)?,
        epoch_id: r.get::<_, Option<i64>>(1)?.map(|n| n.to_string()),
        seq: r.get(2)?,
        role: Role::parse(&role).ok_or_else(|| corrupt(3, "role", role))?,
        created_at: timestamp(r.get(4)?),
        response_started_at: time_column(r, 8)?,
        model: model_column(r, 5, 6)?,
        parts: if text.is_empty() {
            vec![]
        } else {
            vec![ContentPart::Text { text }]
        },
        usage: r
            .get::<_, Option<u64>>(10)?
            .map(|input| {
                Ok::<_, rusqlite::Error>(Usage {
                    input,
                    output: r.get::<_, Option<u64>>(11)?.unwrap_or(0),
                    cached_read: r.get::<_, Option<u64>>(12)?.unwrap_or(0),
                    cached_write: r.get::<_, Option<u64>>(13)?.unwrap_or(0),
                })
            })
            .transpose()?,
        status: "complete".into(),
        tool_calls: vec![],
        attachments: vec![],
        editable: false,
        has_reasoning: r.get(9)?,
        joined_run: r.get(14)?,
    })
}
const TOOL_CALL_COLUMNS: &str = concat!(
    "t.id, t.message_id, t.call_id, t.tool, t.label, t.status, ",
    "t.mutative, t.error, t.started_at, t.finished_at, t.duration_ms, t.plugin_id, t.action",
);
fn tool_call_from_row(r: &Row) -> rusqlite::Result<ToolCallRecord> {
    let status: String = r.get(5)?;
    Ok(ToolCallRecord {
        id: id_column(r, 0)?,
        message_id: id_column(r, 1)?,
        call_id: r.get(2)?,
        tool: r.get(3)?,
        label: r.get(4)?,
        status: ToolCallStatus::parse(&status).ok_or_else(|| corrupt(5, "tool status", status))?,
        mutative: r.get(6)?,
        error: r.get(7)?,
        started_at: time_column(r, 8)?,
        finished_at: time_column(r, 9)?,
        duration_ms: r.get(10)?,
        plugin_id: r.get(11)?,
        action: r.get(12)?,
        args: Value::Null,
        result: None,
    })
}
fn calls_for_message(db: &Connection, mid: &str, payload: bool) -> Result<Vec<ToolCallRecord>> {
    let mut calls = db
        .prepare(&format!(
            "SELECT {TOOL_CALL_COLUMNS} FROM tool_calls t WHERE t.message_id=?1 ORDER BY t.ordinal"
        ))?
        .query_map([mid], tool_call_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if payload {
        for call in &mut calls {
            hydrate_call(db, call)?;
        }
    }
    Ok(calls)
}
fn hydrate_call(db: &Connection, call: &mut ToolCallRecord) -> Result<()> {
    let sql = concat!(
        "SELECT p.args_json, p.result_json ",
        "FROM payloads p ",
        "JOIN tool_calls t ON t.payload_id = p.id ",
        "WHERE t.id = ?1",
    );
    let (args, result): (String, Option<String>) =
        db.query_row(sql, [&call.id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    call.args = serde_json::from_str(&args)?;
    call.result = result.map(|s| serde_json::from_str(&s)).transpose()?;
    Ok(())
}
fn get_message(db: &Connection, id: &str) -> Result<StoredMessage> {
    let sql = format!(
        "SELECT {MESSAGE_COLUMNS} \
         FROM messages m \
         LEFT JOIN provider_profiles p ON p.id = m.model_profile_id \
         LEFT JOIN model_calls mc ON mc.id = m.model_call_id \
         WHERE m.id = ?1"
    );
    let mut message = db.query_row(&sql, [id], message_from_row)?;
    message.attachments = remember::attachments(db, id, false)?;
    message.tool_calls = calls_for_message(db, id, false)?;
    Ok(message)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    pub messages: Vec<StoredMessage>,
    pub next_before: Option<i64>,
}
fn message_page_sql(extra: &str) -> String {
    format!(
        "SELECT {MESSAGE_COLUMNS} \
         FROM messages m \
         LEFT JOIN provider_profiles p ON p.id = m.model_profile_id \
         LEFT JOIN model_calls mc ON mc.id = m.model_call_id \
         WHERE {extra}"
    )
}

/// Turns per transcript page: the newest ones on open, then this many more
/// each time the reader asks for earlier messages. Enough that a chat opens
/// on a good stretch of recent context before "Show earlier messages".
const PAGE_TURNS: usize = 5;

/// Where the `turns`-th newest turn before `upper` begins: the first of the
/// user Messages that open it (a drained queue opens a turn with several).
/// `None` when there are no more turns than that, so the page reaches the
/// start of the transcript.
///
/// A page is whole turns, never a count of Messages: one agent run can be
/// dozens of assistant steps, and a Message count would cut a turn off from
/// the prompt it answers. A user Message that joined a run in progress is
/// part of that run's turn, not the start of another, so it never opens one.
fn turn_floor(db: &Connection, id: &str, upper: i64, turns: usize) -> Result<Option<i64>> {
    let mut stmt = db.prepare_cached(
        "SELECT seq, role, joined_run FROM messages \
         WHERE conversation_id = ?1 AND visibility = 'visible' AND seq < ?2 \
         ORDER BY seq DESC",
    )?;
    let mut rows = stmt.query(params![id, upper])?;
    let mut found = 0;
    // The earliest user Message of the run being read, newest first.
    let mut opening: Option<i64> = None;
    while let Some(row) = rows.next()? {
        let seq: i64 = row.get(0)?;
        let role: String = row.get(1)?;
        let joined: bool = row.get(2)?;
        if role == "user" && !joined {
            opening = Some(seq);
            continue;
        }
        if role == "user" {
            // Inside the run it joined: read on to where that run began.
            continue;
        }
        // An older non-user Message closes the run: `opening` starts a turn,
        // and there is more transcript before it.
        if let Some(start) = opening.take() {
            found += 1;
            if found == turns {
                return Ok(Some(start));
            }
        }
    }
    Ok(None)
}

fn page_in(db: &Connection, id: &str, before: Option<i64>, turns: usize) -> Result<MessagePage> {
    let sql = message_page_sql(
        "m.conversation_id = ?1 AND m.visibility = 'visible' \
         AND m.seq >= ?2 AND m.seq < ?3 \
         ORDER BY m.seq",
    );
    let upper = before.unwrap_or(i64::MAX);
    let floor = turn_floor(db, id, upper, turns)?;
    let mut messages = db
        .prepare_cached(&sql)?
        .query_map(
            params![id, floor.unwrap_or(i64::MIN), upper],
            message_from_row,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // A floor is only returned when older Messages exist before it.
    let next_before = floor;
    if !messages.is_empty() {
        let ids: Vec<i64> = messages
            .iter()
            .map(|m| m.id.parse())
            .collect::<std::result::Result<_, _>>()?;
        let placeholders = vec!["?"; ids.len()].join(",");
        let calls_sql = format!(
            "SELECT {TOOL_CALL_COLUMNS} \
             FROM tool_calls t \
             WHERE t.message_id IN ({placeholders}) \
             ORDER BY t.message_id, t.ordinal"
        );
        let calls = db
            .prepare(&calls_sql)?
            .query_map(rusqlite::params_from_iter(&ids), tool_call_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let attachment_sql = format!(
            "SELECT message_id, idx, mime_type, name, bytes, width, height, blob_hash \
             FROM message_attachments \
             WHERE message_id IN ({placeholders}) \
             ORDER BY message_id, idx"
        );
        let attachments = db
            .prepare(&attachment_sql)?
            .query_map(rusqlite::params_from_iter(&ids), |r| {
                let mid: i64 = r.get(0)?;
                let index: i64 = r.get(1)?;
                let bytes: i64 = r.get(4)?;
                let attachment = remember::MessageAttachment {
                    index: index as usize,
                    mime_type: r.get(2)?,
                    name: r.get(3)?,
                    bytes: bytes as usize,
                    width: r.get(5)?,
                    height: r.get(6)?,
                    hash: r.get(7)?,
                };
                Ok((mid.to_string(), attachment))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let positions: std::collections::HashMap<String, usize> = messages
            .iter()
            .enumerate()
            .map(|(i, m)| (m.id.clone(), i))
            .collect();
        for call in calls {
            if let Some(i) = positions.get(&call.message_id) {
                messages[*i].tool_calls.push(call);
            }
        }
        for (mid, a) in attachments {
            if let Some(i) = positions.get(&mid) {
                messages[*i].attachments.push(a);
            }
        }
    }
    remember::editability(db, id, &mut messages)?;
    Ok(MessagePage {
        messages,
        next_before,
    })
}
pub fn page(state: &AppState, id: &str, before: Option<i64>) -> Result<MessagePage> {
    store_read!(state, [id], |db| {
        let tx = db.unchecked_transaction()?;
        let page = page_in(&tx, id, before, PAGE_TURNS)?;
        tx.commit()?;
        Ok(page)
    })
}
pub fn snapshot(state: &AppState, id: &str) -> Result<Option<Snapshot>> {
    store_read!(state, [id], |db| {
        let tx = db.unchecked_transaction()?;
        let Some(conversation) = get_conversation(&tx, id)? else {
            return Ok(None);
        };
        let page = page_in(&tx, id, None, PAGE_TURNS)?;
        let revision = conversation.rev;
        let snapshot = Snapshot {
            conversation,
            messages: page.messages,
            next_before: page.next_before,
            queued: queued_messages(&tx, id)?,
            jobs: artifacts::list(&tx, id)?,
            revision,
        };
        tx.commit()?;
        Ok(Some(snapshot))
    })
}
pub fn get(state: &AppState, id: &str) -> Result<Option<Conversation>> {
    store_read!(state, [id], |db| { get_conversation(db, id) })
}
pub fn create(state: &AppState) -> Result<Conversation> {
    store_write!(state, [], |db| {
        db.execute(
            "INSERT INTO conversations(title,created_at,updated_at) VALUES ('New Chat',?1,?1)",
            [now()],
        )?;
        let id = db.last_insert_rowid().to_string();
        db.execute(
            "INSERT INTO epochs(conversation_id,ordinal,start_seq,created_at) VALUES (?1,1,1,?2)",
            params![id, now()],
        )?;
        touch(db, &id)?;
        get_conversation(db, &id)?.context("created conversation")
    })
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListCursor {
    pub updated_at: String,
    pub id: String,
}
impl ListCursor {
    pub fn after(c: &Conversation) -> Self {
        Self {
            updated_at: c.updated_at.clone(),
            id: c.id.clone(),
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        let (updated_at, id) = s.rsplit_once('|')?;
        chrono::DateTime::parse_from_rfc3339(updated_at).ok()?;
        id.parse::<i64>().ok()?;
        Some(Self {
            updated_at: updated_at.into(),
            id: id.into(),
        })
    }
    pub fn encode(&self) -> String {
        format!("{}|{}", self.updated_at, self.id)
    }
}
pub fn list(
    state: &AppState,
    limit: usize,
    after: Option<&ListCursor>,
) -> Result<Vec<Conversation>> {
    remember::search(state, "", limit, after)
}
/// Snapshot all chat IDs before destructive iteration (no page limit).
pub fn all_ids(state: &AppState) -> Result<Vec<String>> {
    state.store.read_blocking(|db| {
        let mut stmt = db.prepare("SELECT id FROM conversations ORDER BY id")?;
        let ids = stmt.query_map([], |row| Ok(row.get::<_, i64>(0)?.to_string()))?;
        Ok(ids.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

pub fn message(state: &AppState, id: &str, mid: &str) -> Result<Option<StoredMessage>> {
    store_read!(state, [id, mid], |db| {
        if !db
            .prepare("SELECT 1 FROM messages WHERE id=?1 AND conversation_id=?2")?
            .exists(params![mid, id])?
        {
            return Ok(None);
        }
        let mut m = get_message(db, mid)?;
        remember::editability(db, id, std::slice::from_mut(&mut m))?;
        Ok(Some(m))
    })
}

/// The Conversation owning the Message or queued Message with this client key, if any.
pub fn conversation_by_client_id(
    state: &AppState,
    client_message_id: &str,
) -> Result<Option<String>> {
    store_read!(state, [client_message_id], |db| {
        let stored: Option<i64> = db
            .query_row(
                "SELECT conversation_id FROM messages \
                 WHERE client_message_id=?1 AND visibility='visible' LIMIT 1",
                [client_message_id],
                |row| row.get(0),
            )
            .optional()?;
        if stored.is_some() {
            return Ok(stored.map(|id| id.to_string()));
        }
        let queued: Option<i64> = db
            .query_row(
                "SELECT conversation_id FROM queued_messages \
                 WHERE client_message_id=?1 LIMIT 1",
                [client_message_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(queued.map(|id| id.to_string()))
    })
}

/// The stored or queued Message carrying a client idempotency key, if any.
pub fn find_by_client_id(
    state: &AppState,
    id: &str,
    client_message_id: &str,
) -> Result<Option<StoredMessage>> {
    store_read!(state, [id, client_message_id], |db| {
        let sql = message_page_sql(
            "m.conversation_id=?1 AND m.client_message_id=?2 AND m.visibility='visible' \
             ORDER BY m.seq DESC LIMIT 1",
        );
        let stored = db
            .prepare_cached(&sql)?
            .query_row(params![id, client_message_id], message_from_row)
            .optional()?;
        if stored.is_some() {
            return Ok(stored);
        }
        Ok(queued_messages(db, id)?
            .into_iter()
            .find(|message| message.client_message_id.as_deref() == Some(client_message_id)))
    })
}
pub fn tool_call(state: &AppState, id: &str) -> Result<Option<ToolCallRecord>> {
    store_read!(state, [id], |db| {
        let mut call = db
            .query_row(
                &format!("SELECT {TOOL_CALL_COLUMNS} FROM tool_calls t WHERE t.id=?1"),
                [id],
                tool_call_from_row,
            )
            .optional()?;
        if let Some(call) = &mut call {
            hydrate_call(db, call)?;
        }
        Ok(call)
    })
}
pub fn tool_call_header(state: &AppState, id: &str) -> Result<Option<ToolCallRecord>> {
    store_read!(state, [id], |db| {
        Ok(db
            .query_row(
                &format!("SELECT {TOOL_CALL_COLUMNS} FROM tool_calls t WHERE t.id=?1"),
                [id],
                tool_call_from_row,
            )
            .optional()?)
    })
}
pub fn latest_running_call(state: &AppState, id: &str) -> Result<Option<ToolCallRecord>> {
    store_read!(state, [id], |db| {
        let sql = format!(
            "SELECT {TOOL_CALL_COLUMNS} \
             FROM tool_calls t \
             WHERE t.conversation_id = ?1 AND t.status = 'running' \
             ORDER BY t.started_at DESC LIMIT 1"
        );
        let row = db.query_row(&sql, [id], tool_call_from_row).optional()?;
        Ok(row)
    })
}
pub fn queued(state: &AppState, id: &str) -> Result<Vec<StoredMessage>> {
    store_read!(state, [id], |db| { queued_messages(db, id) })
}
pub fn jobs(state: &AppState, id: &str) -> Result<Vec<artifacts::ConversationJob>> {
    store_read!(state, [id], |db| { artifacts::list(db, id) })
}
pub fn rename(state: &AppState, id: &str, title: &str) -> Result<Conversation> {
    store_write!(state, [id, title], |db| {
        expect_one(
            db.execute(
                "UPDATE conversations SET title=?2,title_source='user',updated_at=?3 WHERE id=?1",
                params![id, title, now()],
            )?,
            "conversation",
        )?;
        touch(db, id)?;
        get_conversation(db, id)?.ok_or_else(|| StoreError::NotFound.into())
    })
}
/// The first visible user message and the title seen when generation began.
#[derive(Clone)]
pub(crate) struct TitleSnapshot {
    pub title: String,
    pub first_message_id: i64,
    pub first_message: String,
    pub first_message_length: i64,
}

/// Only untitled chat conversations are eligible for initial title generation.
pub(crate) fn title_snapshot(
    state: &AppState,
    id: &str,
    max_chars: usize,
) -> Result<Option<TitleSnapshot>> {
    store_read!(state, [id], |db| {
        Ok(db
            .query_row(
                "SELECT c.title, m.id, substr(m.text,1,?2), length(m.text) \
                 FROM conversations c JOIN messages m ON m.id = ( \
                   SELECT first_user.id FROM messages first_user \
                   WHERE first_user.conversation_id=c.id AND first_user.role='user' \
                   AND first_user.source='user' AND first_user.visibility='visible' \
                   AND trim(first_user.text) != '' ORDER BY first_user.seq ASC LIMIT 1 \
                 ) WHERE c.id=?1 AND c.kind='chat' AND c.title_source='none'",
                params![id, max_chars as i64],
                |r| {
                    Ok(TitleSnapshot {
                        title: r.get(0)?,
                        first_message_id: r.get(1)?,
                        first_message: r.get(2)?,
                        first_message_length: r.get(3)?,
                    })
                },
            )
            .optional()?)
    })
}

/// First generated title wins. In-flight results cannot overwrite a manual
/// rename or a first message that was edited while generation was running.
pub(crate) fn set_auto_title(
    state: &AppState,
    id: &str,
    snapshot: &TitleSnapshot,
    title: &str,
) -> Result<bool> {
    let snapshot = snapshot.clone();
    store_write!(state, [id, title], |db| {
        let changed = db.execute(
            "UPDATE conversations SET title=?2,title_source='auto' \
             WHERE id=?1 AND title_source='none' AND title=?3 \
             AND EXISTS (SELECT 1 FROM messages m WHERE m.id=?4 \
             AND m.conversation_id=?1 AND m.role='user' AND m.source='user' \
             AND m.visibility='visible' AND substr(m.text,1,?5)=?6 \
             AND length(m.text)=?7)",
            params![
                id,
                title,
                snapshot.title,
                snapshot.first_message_id,
                snapshot.first_message.chars().count() as i64,
                snapshot.first_message,
                snapshot.first_message_length
            ],
        )? == 1;
        if changed {
            touch(db, id)?;
        }
        Ok(changed)
    })
}
pub fn delete(state: &AppState, id: &str) -> Result<bool> {
    store_write!(state, [id], |db| {
        let Some(c) = get_conversation(db, id)? else {
            return Ok(false);
        };
        db.execute("DELETE FROM conversations WHERE id=?1", [id])?;
        crate::store::changes::append(db, "conversation", id.parse()?, c.rev + 1, true, now())?;
        Ok(true)
    })
}
#[allow(clippy::too_many_arguments)]
fn insert_message(
    db: &Connection,
    id: &str,
    role: &str,
    text: &str,
    parts: &str,
    options: Option<&str>,
    profile: Option<i64>,
    model: Option<&str>,
) -> Result<String> {
    let seq = next_seq(db, id)?;
    let now = now();
    let has_reasoning = serde_json::from_str::<Vec<ContentPart>>(parts)?
        .iter()
        .any(|p| matches!(p, ContentPart::Reasoning { text: Some(text), .. } if !text.is_empty()));
    let source = if role == "user" { "user" } else { "model" };
    let response_started = if role == "user" { Some(now) } else { None };
    let insert_sql = concat!(
        "INSERT INTO messages(conversation_id, seq, role, source, created_at, ",
        "response_started_at, model_profile_id, model_id, text, has_reasoning) ",
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    );
    db.execute(
        insert_sql,
        params![
            id,
            seq,
            role,
            source,
            now,
            response_started,
            profile,
            model,
            text,
            has_reasoning
        ],
    )?;
    let mid = db.last_insert_rowid().to_string();
    db.execute(
        "INSERT INTO message_payloads(message_id,parts_json,native_options_json) VALUES (?1,?2,?3)",
        params![mid, parts, options],
    )?;
    // `updated_at` is the sidebar's sort key and moves only when a turn
    // finishes, so appending never reorders the history while work is running.
    let update_sql = concat!(
        "UPDATE conversations ",
        "SET last_seq = ?2, ",
        "last_assistant_seq = CASE WHEN ?3 = 'assistant' THEN ?2 ELSE last_assistant_seq END, ",
        "preview = COALESCE(?4, preview) ",
        "WHERE id = ?1",
    );
    let summary = preview(text, role);
    db.execute(update_sql, params![id, seq, role, summary])?;
    Ok(mid)
}
pub fn begin_turn(
    state: &AppState,
    id: &str,
    text: &str,
    model: &ModelRef,
    options: &Value,
    prompt: impl FnOnce() -> Result<String>,
) -> Result<Turn> {
    begin_turn_with_compaction(state, id, text, model, options, &[], None, None, prompt)
}
#[allow(clippy::too_many_arguments)]
pub fn begin_turn_with_compaction(
    state: &AppState,
    id: &str,
    text: &str,
    model: &ModelRef,
    options: &Value,
    attachments: &[remember::NewAttachment],
    compaction: Option<&remember::PreparedCompaction>,
    client_message_id: Option<&str>,
    prompt: impl FnOnce() -> Result<String>,
) -> Result<Turn> {
    let prompt = prompt()?;
    let model = model.clone();
    let options = options.clone();
    let attachments = attachments.to_vec();
    let compaction = compaction.cloned();
    let client_message_id = client_message_id.map(str::to_owned);
    let blobs = state.store.blobs.clone();
    store_write!(state, [id, text], |db| {
        let c = get_conversation(db, id)?.ok_or(StoreError::NotFound)?;
        if c.execution_status == ExecutionStatus::Running {
            return Err(StoreError::Busy.into());
        }
        let hash = format!("{:x}", Sha256::digest(prompt.as_bytes()));
        db.execute(
            "INSERT OR IGNORE INTO prompts(hash,version,text) VALUES (?1,?2,?3)",
            params![hash, PROMPT_VERSION, prompt],
        )?;
        let prompt_sql = concat!(
            "UPDATE conversations ",
            "SET prompt_id = COALESCE(prompt_id, ",
            "(SELECT id FROM prompts WHERE hash = ?2)) ",
            "WHERE id = ?1",
        );
        db.execute(prompt_sql, params![id, hash])?;
        if let Some(c) = compaction {
            remember::commit_compaction(db, id, &c)?;
        }
        // Left over from before this run: they open its turn with the new one.
        let earlier = consume_in(db, id, false)?.messages;
        let profile = profile_id(db, &model)?;
        let mid = insert_message(
            db,
            id,
            "user",
            text,
            &text_parts(text)?,
            options_json(&options)?.as_deref(),
            None,
            None,
        )?;
        if let Some(client_message_id) = client_message_id.as_deref() {
            db.execute(
                "UPDATE messages SET client_message_id=?2 WHERE id=?1",
                params![mid, client_message_id],
            )?;
        }
        remember::insert_attachments(db, &blobs, &mid, false, &attachments)?;
        let model_sql = concat!(
            "UPDATE conversations ",
            "SET model_profile_id = ?2, model_id = ?3, ",
            "exec_status = 'running', exec_started_at = ?4, exec_error = NULL ",
            "WHERE id = ?1",
        );
        db.execute(model_sql, params![id, profile, model.model_id, now()])?;
        touch(db, id)?;
        Ok(Turn {
            earlier,
            message: get_message(db, &mid)?,
        })
    })
}
fn queued_messages(db: &Connection, id: &str) -> Result<Vec<StoredMessage>> {
    let sql = concat!(
        "SELECT id, created_at, text, client_message_id ",
        "FROM queued_messages ",
        "WHERE conversation_id = ?1 ",
        "ORDER BY position",
    );
    let mut queued = db
        .prepare(sql)?
        .query_map([id], |r| {
            let qid: i64 = r.get(0)?;
            let created: i64 = r.get(1)?;
            let text: String = r.get(2)?;
            Ok(StoredMessage {
                id: format!("q{qid}"),
                client_message_id: r.get(3)?,
                epoch_id: None,
                seq: None,
                role: Role::User,
                created_at: timestamp(created),
                response_started_at: None,
                model: None,
                parts: vec![ContentPart::Text { text }],
                usage: None,
                status: "queued".into(),
                tool_calls: vec![],
                attachments: vec![],
                editable: false,
                has_reasoning: false,
                joined_run: false,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for m in &mut queued {
        m.attachments = remember::attachments(db, m.id.trim_start_matches('q'), true)?;
    }
    Ok(queued)
}
pub fn enqueue(state: &AppState, id: &str, text: &str, options: &Value) -> Result<StoredMessage> {
    enqueue_with_attachments(state, id, text, options, &[], None)
}
pub fn enqueue_with_attachments(
    state: &AppState,
    id: &str,
    text: &str,
    options: &Value,
    attachments: &[remember::NewAttachment],
    client_message_id: Option<&str>,
) -> Result<StoredMessage> {
    let options = options_json(options)?;
    let attachments = attachments.to_vec();
    let client_message_id = client_message_id.map(str::to_owned);
    let blobs = state.store.blobs.clone();
    store_write!(state, [id, text], |db| {
        get_conversation(db, id)?.ok_or(StoreError::NotFound)?;
        let insert_sql = concat!(
            "INSERT INTO queued_messages(",
            "conversation_id, position, created_at, text, native_options_json",
            ") VALUES (?1, ",
            "(SELECT COALESCE(MAX(position), 0) + 1 FROM queued_messages WHERE conversation_id = ?1), ",
            "?2, ?3, ?4)",
        );
        db.execute(insert_sql, params![id, now(), text, options])?;
        let qid = db.last_insert_rowid().to_string();
        if let Some(client_message_id) = client_message_id.as_deref() {
            db.execute(
                "UPDATE queued_messages SET client_message_id=?2 WHERE id=?1",
                params![qid, client_message_id],
            )?;
        }
        remember::insert_attachments(db, &blobs, &qid, true, &attachments)?;
        let update_sql = concat!(
            "UPDATE conversations ",
            "SET queued_count = queued_count + 1, preview = COALESCE(?2, preview) ",
            "WHERE id = ?1",
        );
        let summary = preview(text, "user");
        db.execute(update_sql, params![id, summary])?;
        touch(db, id)?;
        queued_messages(db, id)?.pop().context("queued message")
    })
}
pub fn edit_queued(state: &AppState, id: &str, mid: &str, text: &str) -> Result<StoredMessage> {
    store_write!(state, [id, mid, text], |db| {
        let changed = db.execute(
            "UPDATE queued_messages SET text=?3 WHERE id=?2 AND conversation_id=?1",
            params![id, mid.trim_start_matches('q'), text],
        )?;
        if changed != 1 {
            return Err(StoreError::NotFound.into());
        }
        refresh_preview(db, id)?;
        touch(db, id)?;
        queued_messages(db, id)?
            .into_iter()
            .find(|m| m.id == mid)
            .ok_or_else(|| StoreError::NotFound.into())
    })
}
fn refresh_preview(db: &Connection, id: &str) -> rusqlite::Result<()> {
    let queued_sql = concat!(
        "SELECT text FROM queued_messages ",
        "WHERE conversation_id = ?1 AND TRIM(text) != '' ",
        "ORDER BY position DESC LIMIT 1",
    );
    let queued: Option<String> = db.query_row(queued_sql, [id], |r| r.get(0)).optional()?;
    let visible_sql = concat!(
        "SELECT text, role FROM messages ",
        "WHERE conversation_id = ?1 AND visibility = 'visible' AND TRIM(text) != '' ",
        "ORDER BY seq DESC LIMIT 1",
    );
    let selected: Option<(String, String)> = if let Some(text) = queued {
        Some((text, "user".into()))
    } else {
        db.query_row(visible_sql, [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?
    };
    let update_sql = concat!(
        "UPDATE conversations ",
        "SET preview = ?2, ",
        "queued_count = (SELECT COUNT(*) FROM queued_messages WHERE conversation_id = ?1) ",
        "WHERE id = ?1",
    );
    let summary = selected.and_then(|(text, role)| preview(&text, &role));
    db.execute(update_sql, params![id, summary])?;
    Ok(())
}
pub fn delete_queued(state: &AppState, id: &str, mid: &str) -> Result<()> {
    store_write!(state, [id, mid], |db| {
        let changed = db.execute(
            "DELETE FROM queued_messages WHERE id=?2 AND conversation_id=?1",
            params![id, mid.trim_start_matches('q')],
        )?;
        if changed != 1 {
            return Err(StoreError::NotFound.into());
        }
        refresh_preview(db, id)?;
        touch(db, id)?;
        Ok(())
    })
}
pub fn has_queued(state: &AppState, id: &str) -> Result<bool> {
    store_read!(state, [id], |db| {
        Ok(db.query_row(
            "SELECT queued_count>0 FROM conversations WHERE id=?1",
            [id],
            |r| r.get(0),
        )?)
    })
}
/// Moves the queue into the transcript. `joined` marks Messages taken in by
/// a run already in progress; a queue that starts a run of its own opens
/// that run's turn instead.
fn consume_in(db: &Connection, id: &str, joined: bool) -> Result<Consumed> {
    let queued = queued_messages(db, id)?;
    let mut messages = vec![];
    let mut native_options = Value::Null;
    for q in queued {
        let qid = q.id.trim_start_matches('q');
        let options: Option<String> = db.query_row(
            "SELECT native_options_json FROM queued_messages WHERE id=?1",
            [qid],
            |r| r.get(0),
        )?;
        native_options = options
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?
            .unwrap_or(Value::Null);
        let text = plain_text(&q.parts);
        let mid = insert_message(
            db,
            id,
            "user",
            &text,
            &text_parts(&text)?,
            options.as_deref(),
            None,
            None,
        )?;
        if joined {
            db.execute("UPDATE messages SET joined_run=1 WHERE id=?1", [&mid])?;
        }
        db.execute(
            "UPDATE messages SET client_message_id=(SELECT client_message_id \
             FROM queued_messages WHERE id=?1) WHERE id=?2",
            params![qid, mid],
        )?;
        db.execute(
            "UPDATE message_attachments SET message_id=?2,queued_id=NULL WHERE queued_id=?1",
            params![qid, mid],
        )?;
        db.execute("DELETE FROM queued_messages WHERE id=?1", [qid])?;
        messages.push(get_message(db, &mid)?);
    }
    refresh_preview(db, id)?;
    Ok(Consumed {
        messages,
        native_options,
    })
}
/// The queue joining the run in progress, at a tool boundary.
pub fn consume_queue(state: &AppState, id: &str) -> Result<Consumed> {
    store_write!(state, [id], |db| {
        let c = consume_in(db, id, true)?;
        if !c.messages.is_empty() {
            touch(db, id)?;
        }
        Ok(c)
    })
}
pub fn begin_from_queue(state: &AppState, id: &str) -> Result<Option<Consumed>> {
    store_write!(state, [id], |db| {
        let c = get_conversation(db, id)?.ok_or(StoreError::NotFound)?;
        if c.execution_status == ExecutionStatus::Running {
            return Err(StoreError::Busy.into());
        }
        let consumed = consume_in(db, id, false)?;
        if consumed.messages.is_empty() {
            return Ok(None);
        }
        let update_sql = concat!(
            "UPDATE conversations ",
            "SET exec_status = 'running', exec_started_at = ?2, exec_error = NULL ",
            "WHERE id = ?1",
        );
        db.execute(update_sql, params![id, now()])?;
        touch(db, id)?;
        Ok(Some(consumed))
    })
}
pub fn append_assistant(
    state: &AppState,
    id: &str,
    model: &ModelRef,
    parts: &[ContentPart],
    usage: Option<Usage>,
    calls: &[NewToolCall],
    call: i64,
) -> Result<StoredMessage> {
    anyhow::ensure!(
        !parts.iter().any(|p| matches!(
            p,
            ContentPart::ToolCall { .. } | ContentPart::ToolResult { .. }
        )),
        "Tool calls must be separate records"
    );
    let parts = parts.to_vec();
    let calls = calls.to_vec();
    let model = model.clone();
    store_write!(state, [id], |db| {
        let profile = profile_id(db, &model)?;
        let mid = insert_message(
            db,
            id,
            "assistant",
            &plain_text(&parts),
            &serde_json::to_string(&parts)?,
            None,
            Some(profile),
            Some(&model.model_id),
        )?;
        db.execute(
            "UPDATE messages SET model_call_id=?2,tool_call_count=?3 WHERE id=?1",
            params![mid, call, calls.len() as i64],
        )?;
        for (ordinal, c) in calls.iter().enumerate() {
            db.execute(
                "INSERT INTO payloads(args_json) VALUES (?1)",
                [serde_json::to_string(&c.args)?],
            )?;
            let payload = db.last_insert_rowid();
            let action = c.args.get("action").and_then(Value::as_str);
            let plugin = action.and_then(|s| s.split_once('.')).map(|s| s.0);
            let insert_sql = concat!(
                "INSERT INTO tool_calls(conversation_id, message_id, ordinal, call_id, tool, ",
                "label, mutative, status, payload_id, plugin_id, action) ",
                "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9, ?10)",
            );
            let ordinal = ordinal as i64;
            db.execute(
                insert_sql,
                params![
                    id, mid, ordinal, c.call_id, c.tool, c.label, c.mutative, payload, plugin,
                    action
                ],
            )?;
        }
        touch(db, id)?;
        let mut m = get_message(db, &mid)?;
        m.tool_calls = calls_for_message(db, &mid, true)?;
        m.usage = usage;
        Ok(m)
    })
}
#[allow(clippy::too_many_arguments)]
fn record_model_call_in(
    db: &Connection,
    id: &str,
    model: &ModelRef,
    purpose: &str,
    status: &str,
    usage: Option<Usage>,
    error: Option<&str>,
    started: i64,
) -> Result<i64> {
    let profile = profile_id(db, model)?;
    let finished = now();
    let input = usage.map(|u| u.input as i64);
    let output = usage.map(|u| u.output as i64);
    let cached_read = usage.map(|u| u.cached_read as i64);
    let cached_write = usage.map(|u| u.cached_write as i64);
    let insert_sql = concat!(
        "INSERT INTO model_calls(conversation_id, purpose, profile_id, model_id, status, ",
        "started_at, finished_at, input_tokens, output_tokens, ",
        "cache_read_tokens, cache_write_tokens, reasoning_tokens, error) ",
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
    );
    db.execute(
        insert_sql,
        params![
            id,
            purpose,
            profile,
            model.model_id,
            status,
            started,
            finished,
            input,
            output,
            cached_read,
            cached_write,
            Option::<i64>::None,
            error
        ],
    )?;
    Ok(db.last_insert_rowid())
}
#[allow(clippy::too_many_arguments)]
pub fn record_model_call(
    state: &AppState,
    id: &str,
    model: &ModelRef,
    purpose: &str,
    status: &str,
    usage: Option<Usage>,
    error: Option<&str>,
    started: i64,
) -> Result<i64> {
    let cost = if model.profile_id == "chatgpt" {
        None
    } else {
        usage
            .and_then(|usage| state.agent.metadata(model).ok()?.estimated_cost_usd(usage))
            .map(|usd| (usd * 1_000_000.0).round() as i64)
    };
    let model = model.clone();
    let error = error.map(str::to_owned);
    store_write!(state, [id, purpose, status], |db| {
        let call = record_model_call_in(
            db,
            id,
            &model,
            purpose,
            status,
            usage,
            error.as_deref(),
            started,
        )?;
        db.execute(
            "UPDATE model_calls SET cost_micros=?2 WHERE id=?1",
            params![call, cost],
        )?;
        Ok(call)
    })
}
pub fn largest_request(state: &AppState, model: &ModelRef) -> Result<u64> {
    let model = model.clone();
    state.store.read_blocking(move |db| {
        let profile: Option<i64> = db
            .query_row(
                "SELECT id FROM provider_profiles WHERE public_id = ?1",
                [&model.profile_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(profile) = profile else {
            // Unknown profiles (tests, deleted profiles) have served nothing.
            return Ok(0);
        };
        let sql = concat!(
            "SELECT COALESCE(MAX(input_tokens + output_tokens), 0) ",
            "FROM model_calls ",
            "WHERE profile_id = ?1 AND model_id = ?2",
        );
        let total: i64 = db.query_row(sql, params![profile, model.model_id], |r| r.get(0))?;
        Ok(total.max(0) as u64)
    })
}
pub fn start_tool_call(state: &AppState, call: &str) -> Result<()> {
    store_write!(state, [call], |db| {
        let sql = concat!(
            "UPDATE tool_calls ",
            "SET status = 'running', started_at = ?2 ",
            "WHERE id = ?1 AND status = 'pending' ",
            "RETURNING conversation_id",
        );
        let id: String = db.query_row(sql, params![call, now()], |r| id_column(r, 0))?;
        touch(db, &id)?;
        Ok(())
    })
}
pub fn finish_tool_call(
    state: &AppState,
    call: &str,
    status: ToolCallStatus,
    result: Option<&Value>,
    error: Option<&str>,
    duration: Option<i64>,
) -> Result<()> {
    let result = result.cloned();
    let error = error.map(str::to_owned);
    store_write!(state, [call], |db| {
        let sql = concat!(
            "UPDATE tool_calls ",
            "SET status = ?2, error = ?3, finished_at = ?4, duration_ms = ?5 ",
            "WHERE id = ?1 AND status IN ('pending', 'running') ",
            "RETURNING conversation_id, payload_id",
        );
        let status_text = status.as_str();
        let finished = now();
        let (id, payload): (String, i64) = db.query_row(
            sql,
            params![call, status_text, error, finished, duration],
            |r| Ok((id_column(r, 0)?, r.get(1)?)),
        )?;
        db.execute(
            "UPDATE payloads SET result_json=?2,model_text=?3 WHERE id=?1",
            params![
                payload,
                result.as_ref().map(serde_json::to_string).transpose()?,
                result.as_ref().map(crate::agent::tools::render_for_model)
            ],
        )?;
        touch(db, &id)?;
        Ok(())
    })
}
pub fn set_execution(
    state: &AppState,
    id: &str,
    status: ExecutionStatus,
    error: Option<&str>,
) -> Result<()> {
    let error = error.map(str::to_owned);
    store_write!(state, [id], |db| {
        // Reaching `idle` means the turn ended on a final answer, so that is
        // where the sidebar's sort key moves. It never moves while running.
        let affected = if status == ExecutionStatus::Idle {
            db.execute(
                "UPDATE conversations SET exec_status=?2,exec_error=?3,updated_at=?4 WHERE id=?1",
                params![id, status.as_str(), error, now()],
            )?
        } else {
            db.execute(
                "UPDATE conversations SET exec_status=?2,exec_error=?3 WHERE id=?1",
                params![id, status.as_str(), error],
            )?
        };
        expect_one(affected, "conversation")?;
        touch(db, id)?;
        Ok(())
    })
}
pub fn interrupt_running(state: &AppState) -> Result<()> {
    store_write!(state, [], |db| {
        let ids = db
            .prepare("SELECT id FROM conversations WHERE exec_status='running'")?
            .query_map([], |r| id_column(r, 0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let interrupted_sql = concat!(
            "UPDATE conversations ",
            "SET exec_status = 'interrupted', exec_error = ?1 ",
            "WHERE exec_status = 'running'",
        );
        db.execute(interrupted_sql, [OUTCOME_UNKNOWN])?;
        let tool_sql = concat!(
            "UPDATE tool_calls ",
            "SET status = 'interrupted', error = ?1, finished_at = ?2 ",
            "WHERE status = 'running'",
        );
        db.execute(tool_sql, params![OUTCOME_UNKNOWN, now()])?;
        let skipped_sql = concat!(
            "UPDATE tool_calls ",
            "SET status = 'skipped', ",
            "error = 'Not run: Squire stopped before this call started.', ",
            "finished_at = ?1 ",
            "WHERE status = 'pending'",
        );
        db.execute(skipped_sql, [now()])?;
        db.execute(
            "UPDATE jobs SET state='interrupted',finished_at=?1 WHERE state='running'",
            [now()],
        )?;
        for id in ids {
            touch(db, &id)?;
        }
        Ok(())
    })
}

pub fn active_context(state: &AppState, id: &str) -> Result<ActiveContext> {
    active_context_for_model(state, id, None, false)
}
pub fn active_context_for_model(
    state: &AppState,
    id: &str,
    model: Option<&ModelRef>,
    vision: bool,
) -> Result<ActiveContext> {
    context_since(state, id, model, vision, 0, UnfinishedCalls::Reject)
}

/// The active context for sizing only, such as whether a message sent while
/// Squire works will still fit. A tool call still running counts, without
/// the result it does not have yet, so sending mid-call queues the message
/// instead of failing.
pub(crate) fn estimate_context(
    state: &AppState,
    id: &str,
    model: Option<&ModelRef>,
    vision: bool,
) -> Result<ActiveContext> {
    context_since(state, id, model, vision, 0, UnfinishedCalls::Omit)
}

/// What context building does with a tool call that has no outcome yet.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnfinishedCalls {
    /// A model request must answer every call it shows: fail.
    Reject,
    /// A size estimate: keep the call, leave out the result it lacks.
    Omit,
}

pub(crate) fn context_since(
    state: &AppState,
    id: &str,
    model: Option<&ModelRef>,
    vision: bool,
    after: i64,
    unfinished: UnfinishedCalls,
) -> Result<ActiveContext> {
    let model = model.cloned();
    let blobs = state.store.blobs.clone();
    store_read!(state, [id], |db| {
        let tx = db.unchecked_transaction()?;
        let context_sql = concat!(
            "SELECT p.text, c.active_epoch_start_seq, c.last_seq ",
            "FROM conversations c ",
            "JOIN prompts p ON p.id = c.prompt_id ",
            "WHERE c.id = ?1",
        );
        let (system_prompt, start, last_seq): (String, i64, i64) =
            tx.query_row(context_sql, [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        let summary: Option<String> = tx.query_row(
            "SELECT summary FROM epochs WHERE conversation_id=?1 AND start_seq=?2",
            params![id, start],
            |r| r.get(0),
        )?;
        let stored_sql = message_page_sql("m.conversation_id = ?1 AND m.seq >= ?2 ORDER BY m.seq");
        let floor = start.max(after + 1);
        let stored = tx
            .prepare(&stored_sql)?
            .query_map(params![id, floor], message_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut messages = vec![];
        if let Some(summary) = summary.filter(|_| after == 0) {
            messages.push(Message::text(Role::System, summary));
        }
        for mut m in stored {
            m.parts = tx.query_row(
                "SELECT parts_json FROM message_payloads WHERE message_id=?1",
                [&m.id],
                |r| json_column(r, 0),
            )?;
            m.attachments = remember::attachments(&tx, &m.id, false)?;
            if model
                .as_ref()
                .is_some_and(|target| m.model.as_ref().is_some_and(|source| source != target))
            {
                m.parts.retain(|p| {
                    !matches!(p,ContentPart::Reasoning{opaque,..} if !opaque.is_null())
                        && !matches!(p, ContentPart::ProviderState { .. })
                });
            }
            m.parts.extend(remember::context_parts(&blobs, &m, vision)?);
            let calls = calls_for_message(&tx, &m.id, true)?;
            let mut images = vec![];
            for c in &calls {
                m.parts.push(ContentPart::ToolCall {
                    id: c.call_id.clone(),
                    name: c.tool.clone(),
                    args: c.args.clone(),
                });
            }
            for c in calls {
                let (content, is_error) = match c.status {
                    ToolCallStatus::Completed => {
                        let text_sql = concat!(
                            "SELECT p.model_text ",
                            "FROM payloads p ",
                            "JOIN tool_calls t ON t.payload_id = p.id ",
                            "WHERE t.id = ?1",
                        );
                        let content: Option<String> =
                            tx.query_row(text_sql, [&c.id], |r| r.get(0))?;
                        (content.context("completed call has no model text")?, false)
                    }
                    ToolCallStatus::Pending | ToolCallStatus::Running => {
                        if unfinished == UnfinishedCalls::Reject {
                            bail!("Tool call {} has no outcome yet", c.id)
                        }
                        continue;
                    }
                    _ => (c.error.context("call has no error text")?, true),
                };
                let mut content = content;
                if c.status == ToolCallStatus::Completed {
                    let blob_sql = concat!(
                        "SELECT a.name, a.mime_type, a.bytes, a.blob_hash ",
                        "FROM result_attachments a ",
                        "JOIN tool_calls t ON t.payload_id = a.payload_id ",
                        "WHERE t.id = ?1 ",
                        "ORDER BY a.idx",
                    );
                    let attachments = tx
                        .prepare(blob_sql)?
                        .query_map([&c.id], |r| {
                            Ok((
                                r.get::<_, String>(0)?,
                                r.get::<_, String>(1)?,
                                r.get::<_, i64>(2)?,
                                r.get::<_, String>(3)?,
                            ))
                        })?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    for (name, mime, bytes, hash) in attachments {
                        // A cache miss can write a derived file from this read
                        // transaction; the blob archive and DB are unchanged.
                        let path_note =
                            blobs.materialized_path_note(&hash, &name, &mime, bytes as u64);
                        content.push_str(&format!(
                            "\n[result attachment: {name}, {mime}, {bytes} bytes, id {hash}{path_note}]"
                        ));
                        if vision && is_inline_image(&mime) {
                            use base64::Engine;
                            match blobs.path(&hash).and_then(|path| Ok(std::fs::read(path)?)) {
                                Ok(data) => images.push(Message {
                                    role: Role::User,
                                    parts: vec![ContentPart::Image {
                                        url: format!(
                                            "data:{mime};base64,{}",
                                            base64::engine::general_purpose::STANDARD.encode(data)
                                        ),
                                    }],
                                }),
                                Err(error) => {
                                    tracing::warn!(%error, %hash, "Could not re-inject result image");
                                }
                            }
                        }
                    }
                }
                m.parts.push(ContentPart::ToolResult {
                    call_id: c.call_id,
                    content,
                    is_error,
                });
            }
            messages.push(Message {
                role: m.role,
                parts: m.parts,
            });
            messages.extend(images);
        }
        tx.commit()?;
        Ok(ActiveContext {
            system_prompt,
            messages,
            last_seq,
        })
    })
}
pub(crate) fn finish_prepared_tool_call(
    state: &AppState,
    call: &str,
    mut prepared: crate::connections::PreparedResult,
    duration: i64,
) -> Result<crate::connections::PreparedResult> {
    let blobs = state.store.blobs.clone();
    store_write!(state, [call], |db| {
        let select_sql = concat!(
            "SELECT conversation_id, payload_id ",
            "FROM tool_calls ",
            "WHERE id = ?1 AND status IN ('pending', 'running')",
        );
        let (id, payload): (String, i64) =
            db.query_row(select_sql, [call], |r| Ok((id_column(r, 0)?, r.get(1)?)))?;
        crate::connections::persist_result(db, &blobs, payload, &mut prepared)?;
        let error = crate::connections::result_error(&prepared.result);
        let status = if error.is_some() {
            "error"
        } else {
            "completed"
        };
        let update_sql = concat!(
            "UPDATE tool_calls ",
            "SET status = ?2, error = ?3, finished_at = ?4, ",
            "duration_ms = ?5, attachment_count = ?6 ",
            "WHERE id = ?1",
        );
        let attachment_count = prepared.attachments.len() as i64;
        db.execute(
            update_sql,
            params![call, status, error, now(), duration, attachment_count],
        )?;
        touch(db, &id)?;
        Ok(prepared)
    })
}

pub(crate) fn context_messages(state: &AppState, id: &str) -> Result<Vec<StoredMessage>> {
    store_read!(state, [id], |db| {
        let sql = message_page_sql(
            "m.conversation_id = ?1 AND m.seq >= \
             (SELECT active_epoch_start_seq FROM conversations WHERE id = ?1) \
             ORDER BY m.seq",
        );
        let rows = db
            .prepare(&sql)?
            .query_map([id], message_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}
