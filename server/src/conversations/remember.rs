//! History mutations and blob references, committed with durable revisions.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageAttachment {
    pub index: usize,
    pub mime_type: String,
    pub name: String,
    pub bytes: usize,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentInput {
    pub name: String,
    pub mime_type: String,
    pub data: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

#[derive(Clone)]
pub struct NewAttachment {
    pub name: String,
    pub mime_type: String,
    pub data: Vec<u8>,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

pub fn decode_attachments(inputs: Vec<AttachmentInput>) -> Result<Vec<NewAttachment>> {
    anyhow::ensure!(inputs.len() <= 16, "At most 16 attachments are allowed");
    let mut total = 0;
    inputs
        .into_iter()
        .map(|input| {
            anyhow::ensure!(
                !input.name.trim().is_empty()
                    && input.name.len() <= 255
                    && !input.name.chars().any(char::is_control),
                "Invalid attachment name"
            );
            anyhow::ensure!(
                crate::connections::valid_mime_type(&input.mime_type),
                "Invalid attachment MIME type"
            );
            anyhow::ensure!(input.data.len() <= 22_369_624, "Attachment exceeds 16 MiB");
            let data = STANDARD
                .decode(input.data)
                .context("Invalid attachment base64")?;
            total += data.len();
            anyhow::ensure!(
                data.len() <= 16 * 1024 * 1024 && total <= 32 * 1024 * 1024,
                "Attachments exceed byte limit"
            );
            let dimensions = match (input.width, input.height) {
                (Some(w), Some(h))
                    if input.mime_type.starts_with("image/")
                        && (1..=100_000).contains(&w)
                        && (1..=100_000).contains(&h) =>
                {
                    (Some(w), Some(h))
                }
                (None, None) => (None, None),
                _ => anyhow::bail!("Invalid image dimensions"),
            };
            Ok(NewAttachment {
                name: input.name,
                mime_type: input.mime_type,
                data,
                width: dimensions.0,
                height: dimensions.1,
            })
        })
        .collect()
}

pub(super) fn insert_attachments(
    db: &Connection,
    blobs: &crate::store::blobs::BlobStore,
    message: &str,
    queued: bool,
    attachments: &[NewAttachment],
) -> Result<()> {
    anyhow::ensure!(attachments.len() <= 16, "Too many attachments");
    let mut total = 0;
    for (index, a) in attachments.iter().enumerate() {
        total += a.data.len();
        anyhow::ensure!(
            a.data.len() <= 16 * 1024 * 1024 && total <= 32 * 1024 * 1024,
            "Attachments exceed byte limit"
        );
        let hash = blobs.put_in(db, &a.data, &a.mime_type, now())?;
        let message_ref = if queued { None } else { Some(message) };
        let queued_ref = if queued { Some(message) } else { None };
        let index = index as i64;
        let byte_len = a.data.len() as i64;
        let insert_sql = concat!(
            "INSERT INTO message_attachments(",
            "message_id, queued_id, idx, name, mime_type, bytes, width, height, blob_hash",
            ") VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        );
        db.execute(
            insert_sql,
            params![
                message_ref,
                queued_ref,
                index,
                a.name,
                a.mime_type,
                byte_len,
                a.width,
                a.height,
                hash
            ],
        )?;
    }
    if !queued {
        db.execute(
            "UPDATE messages SET attachment_count=?2 WHERE id=?1",
            params![message, attachments.len() as i64],
        )?;
    }
    Ok(())
}
pub(super) fn attachments(
    db: &Connection,
    id: &str,
    queued: bool,
) -> Result<Vec<MessageAttachment>> {
    let key = if queued { "queued_id" } else { "message_id" };
    let sql = format!(
        "SELECT idx, mime_type, name, bytes, width, height, blob_hash \
         FROM message_attachments \
         WHERE {key} = ?1 \
         ORDER BY idx"
    );
    let rows = db
        .prepare(&sql)?
        .query_map([id], |r| {
            let index: i64 = r.get(0)?;
            let bytes: i64 = r.get(3)?;
            Ok(MessageAttachment {
                index: index as usize,
                mime_type: r.get(1)?,
                name: r.get(2)?,
                bytes: bytes as usize,
                width: r.get(4)?,
                height: r.get(5)?,
                hash: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}
pub fn attachment(
    state: &AppState,
    id: &str,
    mid: &str,
    index: usize,
) -> Result<(String, Vec<u8>)> {
    let blobs = state.store.blobs.clone();
    store_read!(state, [id, mid], |db| {
        let sql = concat!(
            "SELECT a.mime_type, a.blob_hash ",
            "FROM message_attachments a ",
            "JOIN messages m ON m.id = a.message_id ",
            "WHERE m.conversation_id = ?1 AND m.id = ?2 AND a.idx = ?3",
        );
        let index = index as i64;
        let (mime, hash): (String, String) = db
            .query_row(sql, params![id, mid, index], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?
            .ok_or(StoreError::NotFound)?;
        Ok((mime, std::fs::read(blobs.path(&hash)?)?))
    })
}
pub(super) fn context_parts(
    blobs: &crate::store::blobs::BlobStore,
    message: &StoredMessage,
    vision: bool,
) -> Result<Vec<ContentPart>> {
    let mut parts = vec![];
    for a in &message.attachments {
        // Repairing a missing cache copy here is intentional: older messages
        // and manually deleted copies acquire usable paths without DB writes.
        let path_note =
            blobs.materialized_path_note(&a.hash, &a.name, &a.mime_type, a.bytes as u64);
        let kind = if is_inline_image(&a.mime_type) {
            "image"
        } else {
            "file"
        };
        let caption = format!(
            "[attached {kind}: {}, {}, {} bytes, id {}{}]",
            a.name, a.mime_type, a.bytes, a.hash, path_note
        );
        let data = if (is_inline_image(&a.mime_type) && vision) || is_text_like(&a.mime_type) {
            match blobs
                .path(&a.hash)
                .and_then(|path| Ok(std::fs::read(path)?))
            {
                Ok(data) => Some(data),
                Err(error) => {
                    tracing::warn!(%error, hash = %a.hash, "Could not read attachment blob");
                    None
                }
            }
        } else {
            None
        };
        if is_inline_image(&a.mime_type) && vision {
            parts.push(ContentPart::Text { text: caption });
            if let Some(data) = data {
                parts.push(ContentPart::Image {
                    url: format!("data:{};base64,{}", a.mime_type, STANDARD.encode(data)),
                });
            }
        } else {
            let text = if is_text_like(&a.mime_type) {
                data.as_deref()
                    .and_then(|data| std::str::from_utf8(data).ok())
                    .map(|s| {
                        let mut chars = s.chars();
                        let mut excerpt: String = chars.by_ref().take(100_000).collect();
                        if chars.next().is_some() {
                            excerpt.push_str("\n[attachment truncated after 100,000 characters]");
                        }
                        excerpt
                    })
            } else {
                None
            };
            parts.push(ContentPart::Text {
                text: match text {
                    Some(text) => format!("{caption}\n{text}"),
                    None => format!("{}; contents not inlined", caption),
                },
            });
        }
    }
    Ok(parts)
}
pub fn seen(state: &AppState, id: &str, through: Option<i64>) -> Result<Conversation> {
    store_write!(state, [id], |db| {
        let latest = next_seq(db, id)? - 1;
        let seq = through.unwrap_or(latest).clamp(0, latest);
        expect_one(
            db.execute(
                "UPDATE conversations SET last_seen_seq=MAX(last_seen_seq,?2) WHERE id=?1",
                params![id, seq],
            )?,
            "conversation",
        )?;
        touch(db, id)?;
        get_conversation(db, id)?.ok_or_else(|| StoreError::NotFound.into())
    })
}
pub fn search(
    state: &AppState,
    query: &str,
    limit: usize,
    after: Option<&ListCursor>,
) -> Result<Vec<Conversation>> {
    let (at, id) = after
        .map(|c| {
            Ok::<_, anyhow::Error>((
                chrono::DateTime::parse_from_rfc3339(&c.updated_at)?.timestamp_millis(),
                c.id.parse::<i64>()?,
            ))
        })
        .transpose()?
        .unwrap_or((i64::MAX, i64::MAX));
    let terms = query
        .split_whitespace()
        .take(32)
        .map(|w| format!("\"{}\"*", w.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ");
    state.store.read_blocking(move |db| {
        let filter = if terms.is_empty() {
            String::new()
        } else {
            concat!(
                " AND c.id IN (",
                "SELECT rowid FROM conversations_fts WHERE conversations_fts MATCH ?4 ",
                "UNION ",
                "SELECT m.conversation_id FROM messages_fts ",
                "JOIN messages m ON m.id = messages_fts.rowid ",
                "WHERE messages_fts MATCH ?4",
                ")",
            )
            .to_string()
        };
        let sql = format!(
            "SELECT {CONVERSATION_COLUMNS} \
             FROM conversations c \
             LEFT JOIN provider_profiles p ON p.id = c.model_profile_id \
             WHERE c.kind = 'chat' AND (c.updated_at, c.id) < (?1, ?2){filter} \
             ORDER BY c.updated_at DESC, c.id DESC LIMIT ?3"
        );
        let mut stmt = db.prepare(&sql)?;
        let page_size = limit.clamp(1, 200) as i64;
        let mut rows = if terms.is_empty() {
            stmt.query(params![at, id, page_size])?
        } else {
            stmt.query(params![at, id, page_size, terms])?
        };
        let mut result = vec![];
        while let Some(row) = rows.next()? {
            result.push(conversation_from_row(row)?);
        }
        if !terms.is_empty() {
            for c in &mut result {
                let title_sql = concat!(
                    "SELECT highlight(conversations_fts, 0, char(1), char(2)) ",
                    "FROM conversations_fts ",
                    "WHERE rowid = ?1 AND conversations_fts MATCH ?2",
                );
                c.title_highlight = db
                    .query_row(title_sql, params![c.id, terms], |r| r.get(0))
                    .optional()?;
                let excerpt_sql = concat!(
                    "SELECT snippet(messages_fts, 0, char(1), char(2), '…', 24) ",
                    "FROM messages_fts ",
                    "JOIN messages m ON m.id = messages_fts.rowid ",
                    "WHERE m.conversation_id = ?1 AND messages_fts MATCH ?2 ",
                    "ORDER BY m.seq DESC LIMIT 1",
                );
                c.match_excerpt = db
                    .query_row(excerpt_sql, params![c.id, terms], |r| r.get(0))
                    .optional()?;
            }
        }
        Ok(result)
    })
}
pub(super) fn editability(db: &Connection, id: &str, messages: &mut [StoredMessage]) -> Result<()> {
    // Any complete user message in the active epoch can be edited, even after actions that
    // changed files or data: editing rewrites the transcript, not what those actions did.
    let start: i64 = db.query_row(
        "SELECT active_epoch_start_seq FROM conversations WHERE id=?1",
        [id],
        |r| r.get(0),
    )?;
    for m in messages {
        m.editable =
            m.role == Role::User && m.status == "complete" && m.seq.is_some_and(|s| s >= start);
    }
    Ok(())
}
pub fn edit(state: &AppState, id: &str, mid: &str, text: &str) -> Result<StoredMessage> {
    store_write!(state, [id, mid, text], |db| {
        let c = get_conversation(db, id)?.ok_or(StoreError::NotFound)?;
        if c.execution_status == ExecutionStatus::Running {
            return Err(StoreError::Busy.into());
        }
        let mut m = get_message(db, mid)?;
        let owned = db
            .prepare("SELECT 1 FROM messages WHERE id=?1 AND conversation_id=?2")?
            .exists(params![mid, id])?;
        if !owned {
            return Err(StoreError::NotFound.into());
        }
        editability(db, id, std::slice::from_mut(&mut m))?;
        if !m.editable {
            return Err(StoreError::EditBlocked.into());
        }
        db.execute(
            "DELETE FROM messages WHERE conversation_id=?1 AND seq>?2",
            params![id, m.seq],
        )?;
        db.execute(
            "UPDATE messages SET text=?2,response_started_at=?3 WHERE id=?1",
            params![mid, text, now()],
        )?;
        db.execute(
            "UPDATE message_payloads SET parts_json=?2 WHERE message_id=?1",
            params![mid, text_parts(text)?],
        )?;
        let latest_sql = concat!(
            "SELECT seq FROM messages ",
            "WHERE conversation_id = ?1 AND role = 'assistant' ",
            "ORDER BY seq DESC LIMIT 1",
        );
        let _ = latest_sql;
        let update_sql = concat!(
            "UPDATE conversations ",
            "SET last_seq = ?2, ",
            "last_assistant_seq = COALESCE(",
            "(SELECT seq FROM messages ",
            "WHERE conversation_id = ?1 AND role = 'assistant' ",
            "ORDER BY seq DESC LIMIT 1), 0), ",
            "last_seen_seq = MIN(last_seen_seq, ?2), ",
            "exec_status = 'running', exec_error = NULL, ",
            "exec_started_at = ?3, updated_at = ?3 ",
            "WHERE id = ?1",
        );
        let seq = m.seq;
        let stamped = now();
        db.execute(update_sql, params![id, seq, stamped])?;
        refresh_preview(db, id)?;
        touch(db, id)?;
        get_message(db, mid)
    })
}
pub fn branch(state: &AppState, id: &str, mid: &str) -> Result<Conversation> {
    store_write!(state, [id, mid], |db| {
        let c = get_conversation(db, id)?.ok_or(StoreError::NotFound)?;
        if c.execution_status == ExecutionStatus::Running {
            return Err(StoreError::Busy.into());
        }
        let cut: i64 = db
            .query_row(
                "SELECT seq FROM messages WHERE id=?1 AND conversation_id=?2",
                params![mid, id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(StoreError::NotFound)?;
        let branch_sql = concat!(
            "INSERT INTO conversations(",
            "title, title_source, created_at, updated_at, prompt_id, ",
            "model_profile_id, model_id, parent_conversation_id, parent_seq, ",
            "last_seq, last_assistant_seq, last_seen_seq",
            ") SELECT title, title_source, ?2, ?2, prompt_id, ",
            "model_profile_id, model_id, id, ?3, ?3, 0, ?3 ",
            "FROM conversations WHERE id = ?1",
        );
        let stamped = now();
        db.execute(branch_sql, params![id, stamped, cut])?;
        let branch = db.last_insert_rowid().to_string();
        db.execute(
            "INSERT INTO epochs(conversation_id,ordinal,start_seq,created_at) VALUES (?1,1,1,?2)",
            params![branch, now()],
        )?;
        let old_messages = db
            .prepare("SELECT id FROM messages WHERE conversation_id=?1 AND seq<=?2 ORDER BY seq")?
            .query_map(params![id, cut], |r| id_column(r, 0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for old in old_messages {
            let message_sql = concat!(
                "INSERT INTO messages(",
                "conversation_id, seq, role, source, visibility, created_at, ",
                "response_started_at, model_profile_id, model_id, model_call_id, text, ",
                "reasoning_ms, has_reasoning, attachment_count, tool_call_count",
                ") SELECT ?2, seq, role, source, visibility, created_at, ",
                "response_started_at, model_profile_id, model_id, model_call_id, text, ",
                "reasoning_ms, has_reasoning, attachment_count, tool_call_count ",
                "FROM messages WHERE id = ?1",
            );
            db.execute(message_sql, params![old, branch])?;
            let new = db.last_insert_rowid();
            let payload_sql = concat!(
                "INSERT INTO message_payloads ",
                "SELECT ?2, parts_json, native_options_json ",
                "FROM message_payloads WHERE message_id = ?1",
            );
            db.execute(payload_sql, params![old, new])?;
            let attachment_sql = concat!(
                "INSERT INTO message_attachments(",
                "message_id, idx, name, mime_type, bytes, width, height, blob_hash",
                ") SELECT ?2, idx, name, mime_type, bytes, width, height, blob_hash ",
                "FROM message_attachments WHERE message_id = ?1",
            );
            db.execute(attachment_sql, params![old, new])?;
            let calls = db
                .prepare(
                    "SELECT id,payload_id FROM tool_calls WHERE message_id=?1 ORDER BY ordinal",
                )?
                .query_map([&old], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for (call, payload) in calls {
                let new_payload = crate::store::blobs::copy_payload(db, payload)?;
                let call_sql = concat!(
                    "INSERT INTO tool_calls(",
                    "conversation_id, message_id, ordinal, call_id, tool, plugin_id, action, ",
                    "label, mutative, status, error, started_at, finished_at, ",
                    "duration_ms, attachment_count, payload_id",
                    ") SELECT ?2, ?3, ordinal, call_id, tool, plugin_id, action, ",
                    "label, mutative, status, error, started_at, finished_at, ",
                    "duration_ms, attachment_count, ?4 ",
                    "FROM tool_calls WHERE id = ?1",
                );
                db.execute(call_sql, params![call, branch, new, new_payload])?;
            }
        }
        let assistant_sql = concat!(
            "UPDATE conversations ",
            "SET last_assistant_seq = COALESCE(",
            "(SELECT seq FROM messages ",
            "WHERE conversation_id = ?1 AND role = 'assistant' ",
            "ORDER BY seq DESC LIMIT 1), 0) ",
            "WHERE id = ?1",
        );
        db.execute(assistant_sql, [&branch])?;
        refresh_preview(db, &branch)?;
        touch(db, &branch)?;
        get_conversation(db, &branch)?.context("created branch")
    })
}
#[derive(Clone)]
pub struct PreparedCompaction {
    pub epoch_id: String,
    pub expected_seq: i64,
    pub cut_seq: i64,
    pub summary: String,
    pub model: ModelRef,
    pub model_call_id: i64,
}
pub(crate) fn finish_branch_compaction(
    state: &AppState,
    id: &str,
    prepared: &PreparedCompaction,
) -> Result<()> {
    let prepared = prepared.clone();
    store_write!(state, [id], |db| {
        commit_compaction(db, id, &prepared)?;
        db.execute("UPDATE conversations SET exec_status='idle',exec_error=NULL,exec_started_at=NULL WHERE id=?1",[id])?;
        touch(db, id)?;
        Ok(())
    })
}
pub(super) fn commit_compaction(db: &Connection, id: &str, p: &PreparedCompaction) -> Result<()> {
    anyhow::ensure!(
        active_epoch(db, id)? == p.epoch_id && next_seq(db, id)? - 1 == p.expected_seq,
        "Conversation changed while model switch was pending"
    );
    let ordinal: i64 = db.query_row(
        "SELECT ordinal FROM epochs WHERE id=?1",
        [&p.epoch_id],
        |r| r.get(0),
    )?;
    db.execute(
        "UPDATE epochs SET closed_at=?2 WHERE id=?1",
        params![p.epoch_id, now()],
    )?;
    let epoch_sql = concat!(
        "INSERT INTO epochs(",
        "conversation_id, ordinal, start_seq, created_at, summary, summary_model_call_id",
        ") VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    );
    let next_ordinal = ordinal + 1;
    let next_start = p.cut_seq + 1;
    db.execute(
        epoch_sql,
        params![
            id,
            next_ordinal,
            next_start,
            now(),
            p.summary,
            p.model_call_id
        ],
    )?;
    db.execute(
        "UPDATE conversations SET active_epoch_start_seq=?2 WHERE id=?1",
        params![id, p.cut_seq + 1],
    )?;
    Ok(())
}
