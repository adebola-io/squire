//! On-demand conversation payload reads, scoped to their owning conversation.
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallPayload {
    pub args: Box<serde_json::value::RawValue>,
    pub result: Option<Box<serde_json::value::RawValue>>,
    pub model_text: Option<String>,
}

pub fn call_payload(
    db: &Connection,
    conversation_id: i64,
    call_id: i64,
) -> Result<Option<CallPayload>> {
    let row: Option<(String, Option<String>, Option<String>)> = db
        .query_row(
            "SELECT p.args_json,p.result_json,p.model_text
         FROM tool_calls t JOIN payloads p ON p.id = t.payload_id
         WHERE t.id = ?1 AND t.conversation_id = ?2",
            params![call_id, conversation_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    row.map(|(args, result, model_text)| {
        Ok(CallPayload {
            args: serde_json::from_str(&args)?,
            result: result.map(|json| serde_json::from_str(&json)).transpose()?,
            model_text,
        })
    })
    .transpose()
}

pub fn message_payload(
    db: &Connection,
    conversation_id: i64,
    message_id: i64,
) -> Result<Option<Box<serde_json::value::RawValue>>> {
    let json: Option<String> = db
        .query_row(
            "SELECT p.parts_json FROM message_payloads p
         JOIN messages m ON m.id = p.message_id
         WHERE m.id = ?1 AND m.conversation_id = ?2",
            params![message_id, conversation_id],
            |r| r.get(0),
        )
        .optional()?;
    json.map(|value| Ok(serde_json::from_str(&value)?))
        .transpose()
}
