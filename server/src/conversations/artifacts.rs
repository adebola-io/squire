//! Conversation-owned jobs and immutable blob results.
use super::*;
use crate::{connections, tools::ProducedResult};
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationJob {
    pub id: String,
    pub action: String,
    /// The label the transcript shows for the promoted call ("Build").
    pub label: String,
    pub plugin_id: Option<String>,
    pub state: String,
    pub started_at: String,
    pub finished_at: Option<String>,
}
/// Running Jobs, oldest first. A Job's public id is the promoted tool call's
/// own id, so the transcript row for that call is also where the Job's label
/// and Plugin come from; a Job whose call is gone falls back to its action.
pub fn list(db: &Connection, id: &str) -> Result<Vec<ConversationJob>> {
    let sql = concat!(
        "SELECT j.public_id, j.action, t.label, t.plugin_id, j.state, j.started_at, j.finished_at ",
        "FROM jobs j ",
        "LEFT JOIN tool_calls t ON t.id = CAST(j.public_id AS INTEGER) ",
        "WHERE j.conversation_id = ?1 AND j.state = 'running' ",
        "ORDER BY j.started_at",
    );
    let rows = db
        .prepare(sql)?
        .query_map([id], |r| {
            let action: String = r.get(1)?;
            let started: i64 = r.get(5)?;
            Ok(ConversationJob {
                id: r.get(0)?,
                label: r
                    .get::<_, Option<String>>(2)?
                    .unwrap_or_else(|| action.clone()),
                action,
                plugin_id: r.get(3)?,
                state: r.get(4)?,
                started_at: timestamp(started),
                finished_at: time_column(r, 6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}
/// Records the promoted Job against the Conversation, timed from `started_at`
/// — when the Action began, not when it was promoted, so a Job promoted after
/// the foreground wait is not younger than the work it stands for.
pub fn promote(
    state: &AppState,
    conversation: &str,
    id: &str,
    action: &str,
    started_at: i64,
) -> Result<()> {
    store_write!(state, [conversation, id, action], |db| {
        db.execute("INSERT INTO payloads(args_json) VALUES ('{}')", [])?;
        let payload = db.last_insert_rowid();
        let insert_sql = concat!(
            "INSERT INTO jobs(public_id, conversation_id, action, state, started_at, payload_id) ",
            "VALUES (?1, ?2, ?3, 'running', ?4, ?5)",
        );
        db.execute(
            insert_sql,
            params![id, conversation, action, started_at, payload],
        )?;
        touch(db, conversation)?;
        Ok(())
    })
}
pub fn finish(
    state: &AppState,
    conversation: &str,
    id: &str,
    produced: ProducedResult,
    cancelled: bool,
) -> Result<ProducedResult> {
    let prepared = connections::prepare_result(state, id, produced.result, &produced.attachments);
    crate::tools::recorder::clean_staging(&produced.attachments);
    let mut prepared = prepared?;
    let blobs = state.store.blobs.clone();
    store_write!(state, [conversation, id], |db| {
        let select_sql = concat!(
            "SELECT payload_id ",
            "FROM jobs ",
            "WHERE public_id = ?1 AND conversation_id = ?2 AND state = 'running'",
        );
        let payload: i64 = db.query_row(select_sql, params![id, conversation], |r| r.get(0))?;
        connections::persist_result(db, &blobs, payload, &mut prepared)?;
        let status = if cancelled {
            "cancelled"
        } else if connections::result_error(&prepared.result).is_some() {
            "error"
        } else {
            "completed"
        };
        db.execute(
            "UPDATE jobs SET state=?2,finished_at=?3 WHERE public_id=?1",
            params![id, status, now()],
        )?;
        touch(db, conversation)?;
        Ok(())
    })?;
    recorded(state, conversation, id)
}
pub fn recorded(state: &AppState, conversation: &str, id: &str) -> Result<ProducedResult> {
    let blobs = state.store.blobs.clone();
    store_read!(state, [conversation, id], |db| {
        let select_sql = concat!(
            "SELECT j.payload_id, p.result_json ",
            "FROM jobs j ",
            "JOIN payloads p ON p.id = j.payload_id ",
            "WHERE j.public_id = ?1 AND j.conversation_id = ?2",
        );
        let (payload, json): (i64, Option<String>) = db
            .query_row(select_sql, params![id, conversation], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?
            .ok_or(StoreError::NotFound)?;
        let result = serde_json::from_str(&json.context("Job has no recorded result")?)?;
        let hashes = db
            .prepare("SELECT blob_hash FROM result_attachments WHERE payload_id=?1 ORDER BY idx")?
            .query_map([payload], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let replay = hashes
            .into_iter()
            .map(|hash| {
                Ok(crate::tools::AttachmentSlot {
                    staging: None,
                    bytes: Some(std::fs::read(blobs.path(&hash)?)?),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(ProducedResult {
            result,
            attachments: replay,
            recorded: false,
        })
    })
}
pub fn state(state: &AppState, conversation: &str, id: &str) -> Result<String> {
    store_read!(state, [conversation, id], |db| {
        Ok(db
            .query_row(
                "SELECT state FROM jobs WHERE public_id=?1 AND conversation_id=?2",
                params![id, conversation],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(StoreError::NotFound)?)
    })
}
