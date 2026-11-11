//! Durable conversation revisions and runtime-only live activity.
use super::{Conversation, ToolCallRecord};
use crate::{
    providers::types::{ModelRef, Usage},
    state::AppState,
};
use anyhow::Result;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};
#[derive(Default)]
pub struct LiveState {
    inner: Mutex<FeedState>,
}
#[derive(Default)]
struct FeedState {
    thinking: HashSet<String>,
    compacting: HashSet<String>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LiveActivity {
    Thinking,
    Compacting,
    Tool {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        tool: String,
        label: String,
        #[serde(rename = "pluginId")]
        plugin_id: Option<String>,
    },
}
fn live(state: &AppState, id: &str) -> Result<Option<LiveActivity>> {
    if let Some(call) = super::latest_running_call(state, id)? {
        let plugin_id = call.plugin_id;
        return Ok(Some(LiveActivity::Tool {
            tool_call_id: call.id,
            tool: call.tool,
            label: call.label,
            plugin_id,
        }));
    }
    let inner = state
        .conversation_live
        .inner
        .lock()
        .expect("conversation live state");
    if inner.compacting.contains(id) {
        return Ok(Some(LiveActivity::Compacting));
    }
    Ok(inner
        .thinking
        .contains(id)
        .then_some(LiveActivity::Thinking))
}
fn insert(fields: &mut Map<String, Value>, key: &str, value: impl Serialize) -> Result<()> {
    fields.insert(key.into(), serde_json::to_value(value)?);
    Ok(())
}
fn publish(
    state: &AppState,
    id: &str,
    kind: &str,
    update: impl FnOnce(&mut FeedState),
    build: impl FnOnce(&mut Map<String, Value>) -> Result<()>,
) {
    {
        update(
            &mut state
                .conversation_live
                .inner
                .lock()
                .expect("conversation live state"),
        );
    }
    let mut fields = Map::new();
    let result = (|| -> Result<()> {
        build(&mut fields)?;
        let entity = id.to_owned();
        // Report the current durable revision; the write that caused this
        // event already bumped it in its own transaction (plan 013: the
        // event is built from the write's values, no lock held while reading).
        let revision = state.store.read_blocking(move |db| {
            if let Some(conversation) = super::get_conversation(db, &entity)? {
                Ok(conversation.rev)
            } else {
                Ok(db.query_row(
                    "SELECT rev FROM changes WHERE entity_kind='conversation' AND entity_id=?1 ORDER BY seq DESC LIMIT 1",
                    [entity],
                    |r| r.get(0),
                )?)
            }
        })?;
        insert(&mut fields, "revision", revision)?;
        insert(&mut fields, "live", live(state, id)?)?;
        Ok(())
    })();
    if let Err(error) = result {
        tracing::error!("Conversation event failed: {error:#}");
        fields.clear();
        fields.insert("type".into(), json!("transcript.replaced"));
        fields.insert("conversationId".into(), json!(id));
        let _ = state
            .desktop_events
            .send(Arc::from(Value::Object(fields).to_string()));
        return;
    }
    fields.insert("type".into(), json!(kind));
    fields.insert("conversationId".into(), json!(id));
    let _ = state
        .desktop_events
        .send(Arc::from(Value::Object(fields).to_string()));
}
pub fn snapshot(state: &AppState, id: &str) -> Result<Option<Value>> {
    let Some(snapshot) = super::snapshot(state, id)? else {
        return Ok(None);
    };
    let mut value = serde_json::to_value(snapshot)?;
    value["live"] = serde_json::to_value(live(state, id)?)?;
    Ok(Some(value))
}
pub fn list_filtered(
    state: &AppState,
    limit: usize,
    after: Option<&super::ListCursor>,
    query: &str,
) -> Result<Value> {
    let conversations = super::remember::search(state, query, limit, after)?;
    let next_cursor = (conversations.len() == limit)
        .then(|| {
            conversations
                .last()
                .map(super::ListCursor::after)
                .map(|c| c.encode())
        })
        .flatten();
    let revisions: Map<String, Value> = conversations
        .iter()
        .map(|c| (c.id.clone(), json!(c.rev)))
        .collect();
    Ok(json!({"conversations":conversations,"revisions":revisions,"nextCursor":next_cursor}))
}
fn conversation_fields(
    state: &AppState,
    fields: &mut Map<String, Value>,
    conversation_id: &str,
) -> Result<Option<Conversation>> {
    let conversation = super::get(state, conversation_id)?;
    insert(fields, "conversation", &conversation)?;
    Ok(conversation)
}

/// The checkpoint or title changed, a job changed, or the Conversation was
/// created or deleted (`conversation` is then null).
pub fn conversation_updated(state: &AppState, conversation_id: &str) {
    publish(
        state,
        conversation_id,
        "conversation.updated",
        |_| {},
        |fields| {
            if conversation_fields(state, fields, conversation_id)?.is_some() {
                insert(fields, "jobs", super::jobs(state, conversation_id)?)?;
            }
            Ok(())
        },
    );
}

pub fn execution_started(state: &AppState, conversation_id: &str, model: &ModelRef) {
    publish(
        state,
        conversation_id,
        "execution.started",
        |feed| {
            feed.thinking.remove(conversation_id);
            feed.compacting.remove(conversation_id);
        },
        |fields| {
            insert(fields, "modelRef", model)?;
            conversation_fields(state, fields, conversation_id)?;
            Ok(())
        },
    );
}

/// Reasoning is transient: send only the delta, not a freshly read transcript snapshot.
pub fn reasoning_delta(state: &AppState, conversation_id: &str, delta: &str) {
    let _ = state.desktop_events.send(Arc::from(
        json!({ "type": "model.reasoning.delta", "conversationId": conversation_id, "delta": delta })
            .to_string(),
    ));
}

pub fn model_started(state: &AppState, conversation_id: &str, model: &ModelRef) {
    publish(
        state,
        conversation_id,
        "model.started",
        |feed| {
            feed.thinking.insert(conversation_id.to_string());
        },
        |fields| insert(fields, "modelRef", model),
    );
}

/// `status` is `completed` or `discarded`.
/// Completed model events expose cache reads/writes and generation latency.
/// The same usage counts remain durable on the assistant Message.
pub fn model_finished(
    state: &AppState,
    conversation_id: &str,
    status: &str,
    usage: Option<Usage>,
    duration_ms: Option<u64>,
    estimated_cost_usd: Option<f64>,
) {
    publish(
        state,
        conversation_id,
        "model.finished",
        |feed| {
            feed.thinking.remove(conversation_id);
        },
        |fields| {
            insert(fields, "status", status)?;
            if let Some(usage) = usage {
                insert(fields, "usage", usage)?;
            }
            if let Some(duration_ms) = duration_ms {
                insert(fields, "durationMs", duration_ms)?;
            }
            if let Some(cost) = estimated_cost_usd {
                insert(fields, "estimatedCostUsd", cost)?;
            }
            Ok(())
        },
    );
}

/// A queued Message was added, edited, removed or consumed.
pub fn queue_updated(state: &AppState, conversation_id: &str) {
    publish(
        state,
        conversation_id,
        "queue.updated",
        |_| {},
        |fields| {
            insert(fields, "queued", super::queued(state, conversation_id)?)?;
            conversation_fields(state, fields, conversation_id)?;
            Ok(())
        },
    );
}

/// A Message joined the transcript (with its ToolCalls), possibly from the
/// queue, so the queue comes along too.
pub fn message_appended(state: &AppState, conversation_id: &str, message_id: &str, role: &str) {
    publish(
        state,
        conversation_id,
        "message.appended",
        |_| {},
        |fields| {
            insert(fields, "role", role)?;
            insert(
                fields,
                "message",
                super::message(state, conversation_id, message_id)?,
            )?;
            insert(fields, "queued", super::queued(state, conversation_id)?)?;
            conversation_fields(state, fields, conversation_id)?;
            Ok(())
        },
    );
}

fn tool_call_event(state: &AppState, conversation_id: &str, kind: &str, call: &ToolCallRecord) {
    publish(
        state,
        conversation_id,
        kind,
        |_| {},
        |fields| {
            insert(
                fields,
                "toolCall",
                super::tool_call_header(state, &call.id)?,
            )
        },
    );
}

pub fn tool_started(state: &AppState, conversation_id: &str, call: &ToolCallRecord) {
    tool_call_event(state, conversation_id, "tool.started", call);
}

pub fn tool_finished(state: &AppState, conversation_id: &str, call: &ToolCallRecord) {
    tool_call_event(state, conversation_id, "tool.finished", call);
}

/// `status` is `completed`, `stopped` or `error`; `error` says why.
pub fn execution_finished(
    state: &AppState,
    conversation_id: &str,
    status: &str,
    stop_reason: Option<&str>,
    usage: Option<Usage>,
    error: Option<&str>,
) {
    publish(
        state,
        conversation_id,
        "execution.finished",
        |feed| {
            feed.thinking.remove(conversation_id);
        },
        |fields| {
            insert(fields, "status", status)?;
            insert(fields, "stopReason", stop_reason)?;
            insert(fields, "usage", usage)?;
            insert(fields, "error", error)?;
            conversation_fields(state, fields, conversation_id)?;
            Ok(())
        },
    );
}

/// A suffix was replaced. Clients refetch instead of merging stale messages.
pub fn transcript_replaced(state: &AppState, id: &str) {
    publish(
        state,
        id,
        "transcript.replaced",
        |_| {},
        |fields| {
            conversation_fields(state, fields, id)?;
            Ok(())
        },
    );
}

pub fn compaction_updated(state: &AppState, id: &str, status: &str, error: Option<&str>) {
    publish(
        state,
        id,
        "compaction.updated",
        |feed| {
            if status == "running" {
                feed.compacting.insert(id.into());
            } else {
                feed.compacting.remove(id);
            }
        },
        |fields| {
            insert(fields, "status", status)?;
            insert(fields, "error", error)?;
            conversation_fields(state, fields, id)?;
            Ok(())
        },
    );
    if status == "completed" {
        // A committed compaction closes an epoch, changing editability.
        transcript_replaced(state, id);
    }
}
