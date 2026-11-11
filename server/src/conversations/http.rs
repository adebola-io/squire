//! Conversation routes for the local-only desktop API.
//!
//! Mutations are POSTs like the other desktop routes, so they keep the
//! existing origin and content-type checks in `require_desktop_request`.

use super::{events, StoreError};
use crate::{
    agent::{self, AgentError},
    providers::types::ModelRef,
    state::AppState,
    util::json_error,
};
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

const DEFAULT_PAGE_SIZE: usize = 50;
const MAX_PAGE_SIZE: usize = 200;
const MESSAGE_BODY_LIMIT: usize = 46 * 1024 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/conversations",
            get(list)
                .post(create)
                .layer(DefaultBodyLimit::max(MESSAGE_BODY_LIMIT)),
        )
        .route("/conversations/:id", get(snapshot))
        .route("/conversations/:id/rename", post(rename))
        .route("/conversations/:id/seen", post(seen))
        .route("/conversations/:id/messages/:mid/edit", post(edit_message))
        .route(
            "/conversations/:id/messages/:mid/branch",
            post(branch_message),
        )
        .route("/conversations/:id/tool-calls/:call", get(tool_payload))
        .route(
            "/conversations/:id/messages/:mid/payload",
            get(message_payload),
        )
        .route("/conversations/delete-all", post(delete_all))
        .route("/conversations/:id/delete", post(delete))
        .route(
            "/conversations/:id/messages",
            get(message_page)
                .post(send)
                .layer(DefaultBodyLimit::max(MESSAGE_BODY_LIMIT)),
        )
        .route("/conversations/:id/stop", post(stop))
        .route("/conversations/:id/queued/send-now", post(send_now))
        .route("/conversations/:id/queued/:mid/edit", post(edit_queued))
        .route("/conversations/:id/queued/:mid/delete", post(delete_queued))
        .route("/conversations/:id/jobs/:job/cancel", post(cancel_job))
        .route("/providers", get(providers).post(create_profile))
        .route("/providers/:id/update", post(update_profile))
        .route("/providers/:id/delete", post(delete_profile))
        .route("/providers/:id/models", get(models))
        .route("/models/:profile/:model", post(model_prefs))
}

fn error_response(error: anyhow::Error) -> Response {
    if let Some(store_error) = error.downcast_ref::<StoreError>() {
        let status = match store_error {
            StoreError::NotFound => StatusCode::NOT_FOUND,
            StoreError::Busy | StoreError::EditBlocked => StatusCode::CONFLICT,
        };
        return json_error(status, store_error);
    }
    if let Some(agent_error) = error.downcast_ref::<AgentError>() {
        let status = match agent_error {
            AgentError::ModelChangeWhileRunning => StatusCode::CONFLICT,
            _ => StatusCode::BAD_REQUEST,
        };
        return json_error(status, agent_error);
    }
    json_error(StatusCode::INTERNAL_SERVER_ERROR, format!("{error:#}"))
}

fn respond<T: serde::Serialize>(result: anyhow::Result<T>) -> Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => error_response(error),
    }
}

/// Responds with `result`, first publishing its event when it succeeded.
fn respond_and_publish<T: serde::Serialize>(
    result: anyhow::Result<T>,
    publish: impl FnOnce(),
) -> Response {
    if result.is_ok() {
        publish();
    }
    respond(result)
}

#[derive(Deserialize)]
struct ListQuery {
    limit: Option<usize>,
    /// The previous page's `nextCursor`.
    after: Option<String>,
    q: Option<String>,
}

async fn list(State(state): State<AppState>, Query(query): Query<ListQuery>) -> Response {
    let limit = query
        .limit
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .clamp(1, MAX_PAGE_SIZE);
    let after = match query.after.as_deref().filter(|text| !text.is_empty()) {
        Some(text) => match super::ListCursor::parse(text) {
            Some(cursor) => Some(cursor),
            None => return json_error(StatusCode::BAD_REQUEST, "Invalid list cursor"),
        },
        None => None,
    };
    respond(events::list_filtered(
        &state,
        limit,
        after.as_ref(),
        query.q.as_deref().unwrap_or(""),
    ))
}

/// Start a conversation with its first Message. A conversation never exists without one.
async fn create(State(state): State<AppState>, Json(body): Json<SendBody>) -> Response {
    let attachments = match super::remember::decode_attachments(body.attachments) {
        Ok(attachments) => attachments,
        Err(error) => return error_response(error),
    };
    if body.text.trim().is_empty() && attachments.is_empty() {
        return error_response(AgentError::EmptyMessage.into());
    }
    // A retried first send returns the conversation the first attempt created instead of
    // starting another one.
    if let Some(client_message_id) = body.client_message_id.as_deref() {
        match super::conversation_by_client_id(&state, client_message_id) {
            Ok(Some(id)) => {
                return respond(super::get(&state, &id).and_then(|conversation| {
                    conversation.ok_or_else(|| StoreError::NotFound.into())
                }));
            }
            Ok(None) => {}
            Err(error) => return error_response(error),
        }
    }
    let conversation = match super::create(&state) {
        Ok(conversation) => conversation,
        Err(error) => return error_response(error),
    };
    // The send publishes the new conversation through its own events, so the create itself does
    // not need a separate event.
    match agent::send_with_switch(
        &state,
        &conversation.id,
        &body.text,
        body.model_ref,
        body.native_options,
        &attachments,
        body.client_message_id.as_deref(),
    )
    .await
    {
        Ok(_) => respond(
            super::get(&state, &conversation.id)
                .and_then(|conversation| conversation.ok_or_else(|| StoreError::NotFound.into())),
        ),
        Err(error) => {
            // Do not leave a chat behind when its first Message fails.
            let _ = super::delete(&state, &conversation.id);
            error_response(error)
        }
    }
}

async fn snapshot(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    respond(
        events::snapshot(&state, &id)
            .and_then(|snapshot| snapshot.ok_or_else(|| StoreError::NotFound.into())),
    )
}

#[derive(Deserialize)]
struct RenameBody {
    title: String,
}

async fn rename(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<RenameBody>,
) -> Response {
    respond_and_publish(super::rename(&state, &id, &body.title), || {
        events::conversation_updated(&state, &id)
    })
}

/// Stops an active execution, waits until it has really ended (a started
/// native tool call finishes first), then deletes. The client owns the undo
/// toast (plan 008): it delays this call rather than the server soft-deleting.
async fn delete(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let result = agent::delete_conversation(&state, &id).await;
    if matches!(result, Ok(true)) {
        events::conversation_updated(&state, &id);
    }
    respond(result.map(|deleted| json!({ "deleted": deleted })))
}

#[derive(Deserialize)]
struct DeleteAllBody {
    confirmation: String,
}

/// Use the single-conversation path for cancellation, job cleanup, cascading
/// records and revision events. Do not bypass it with a raw table truncate.
async fn delete_all(State(state): State<AppState>, Json(body): Json<DeleteAllBody>) -> Response {
    if body.confirmation != "DELETE" {
        return json_error(StatusCode::BAD_REQUEST, "Type DELETE to confirm");
    }
    let ids = match super::all_ids(&state) {
        Ok(ids) => ids,
        Err(error) => return error_response(error),
    };
    let mut deleted = 0;
    for id in ids {
        match agent::delete_conversation(&state, &id).await {
            Ok(true) => {
                deleted += 1;
                events::conversation_updated(&state, &id);
            }
            Ok(false) => (),
            Err(error) => {
                return json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!(
                        "Deleted {deleted} chats before failing to delete chat {id}: {error:#}"
                    ),
                );
            }
        }
    }
    respond(Ok(json!({ "deleted": deleted })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendBody {
    text: String,
    model_ref: Option<ModelRef>,
    #[serde(default)]
    native_options: Value,
    #[serde(default)]
    attachments: Vec<super::remember::AttachmentInput>,
    #[serde(default)]
    client_message_id: Option<String>,
}

async fn send(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<SendBody>,
) -> Response {
    let attachments = match super::remember::decode_attachments(body.attachments) {
        Ok(attachments) => attachments,
        Err(error) => return json_error(StatusCode::BAD_REQUEST, error),
    };
    respond(
        agent::send_with_switch(
            &state,
            &id,
            &body.text,
            body.model_ref,
            body.native_options,
            &attachments,
            body.client_message_id.as_deref(),
        )
        .await,
    )
}

async fn stop(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    Json(json!({ "stopped": state.agent.stop(&id) })).into_response()
}

async fn send_now(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    respond(agent::send_now(&state, &id).map(|()| json!({ "ok": true })))
}

#[derive(Deserialize)]
struct QueuedBody {
    text: String,
}

async fn edit_queued(
    State(state): State<AppState>,
    Path((id, message_id)): Path<(String, String)>,
    Json(body): Json<QueuedBody>,
) -> Response {
    let text = body.text.trim();
    if text.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, AgentError::EmptyMessage);
    }
    respond_and_publish(super::edit_queued(&state, &id, &message_id, text), || {
        events::queue_updated(&state, &id)
    })
}

async fn delete_queued(
    State(state): State<AppState>,
    Path((id, message_id)): Path<(String, String)>,
) -> Response {
    let result =
        super::delete_queued(&state, &id, &message_id).map(|()| json!({ "deleted": true }));
    respond_and_publish(result, || events::queue_updated(&state, &id))
}

async fn providers(State(state): State<AppState>) -> Response {
    Json(json!({
        "profiles": state.agent.profiles(),
        "defaultModel": state.agent.default_model(),
    }))
    .into_response()
}

async fn cancel_job(
    State(state): State<AppState>,
    Path((conversation, job)): Path<(String, String)>,
) -> Response {
    respond(
        crate::jobs::cancel(
            &state,
            &job,
            &crate::jobs::JobOwner::Conversation(conversation),
        )
        .await
        .map(|result| result.result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeenBody {
    through_seq: Option<i64>,
}

async fn seen(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<SeenBody>,
) -> Response {
    respond_and_publish(super::remember::seen(&state, &id, body.through_seq), || {
        events::conversation_updated(&state, &id)
    })
}

async fn edit_message(
    State(state): State<AppState>,
    Path((id, mid)): Path<(String, String)>,
    Json(body): Json<QueuedBody>,
) -> Response {
    respond(agent::edit_message(&state, &id, &mid, &body.text))
}

async fn branch_message(
    State(state): State<AppState>,
    Path((id, mid)): Path<(String, String)>,
) -> Response {
    respond(agent::branch_with_compaction(&state, &id, &mid))
}

#[derive(Deserialize)]
struct MessageQuery {
    before: Option<i64>,
}
async fn message_page(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<MessageQuery>,
) -> Response {
    respond(super::page(&state, &id, query.before))
}
async fn tool_payload(
    State(state): State<AppState>,
    Path((id, call)): Path<(i64, i64)>,
) -> Response {
    respond(
        state
            .store
            .read(move |db| {
                crate::store::conversations::call_payload(db, id, call)?
                    .ok_or_else(|| StoreError::NotFound.into())
            })
            .await,
    )
}
async fn message_payload(
    State(state): State<AppState>,
    Path((id, mid)): Path<(i64, i64)>,
) -> Response {
    respond(
        state
            .store
            .read(move |db| {
                crate::store::conversations::message_payload(db, id, mid)?
                    .ok_or_else(|| StoreError::NotFound.into())
            })
            .await,
    )
}
fn provider_response<T: serde::Serialize>(result: anyhow::Result<T>) -> Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, format!("{error:#}")),
    }
}

async fn create_profile(
    State(state): State<AppState>,
    Json(body): Json<crate::providers::store::ProfileInput>,
) -> Response {
    provider_response(state.agent.save_profile(None, body))
}

async fn update_profile(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<crate::providers::store::ProfileInput>,
) -> Response {
    provider_response(state.agent.save_profile(Some(&id), body))
}

async fn delete_profile(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    provider_response(
        state
            .agent
            .delete_profile(&id)
            .map(|()| json!({"deleted": true})),
    )
}

#[derive(Deserialize)]
struct ModelsQuery {
    /// Matches the model ID, its display name or its catalog name.
    q: Option<String>,
    /// Page size. Without it the whole list comes back (the chat model
    /// picker pages it locally).
    limit: Option<usize>,
    /// Keyset cursor: the last model ID of the previous page.
    after: Option<String>,
    /// A model ID to include even when it is off this page or filtered out,
    /// so a model opened from the URL always has its record.
    include: Option<String>,
    /// Ask the provider again instead of reusing its recent list.
    refresh: Option<bool>,
}

const MAX_MODEL_PAGE: usize = 200;

async fn models(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<ModelsQuery>,
) -> Response {
    let discovered = state
        .agent
        .discover_models(&id, query.refresh.unwrap_or(false))
        .await;
    provider_response(discovered.map(|all| models_page(all, &query)))
}

/// One page of a profile's models, sorted by ID. `total` counts every match;
/// `common` says which capabilities every listed model shares, so rows only
/// need to mark the ones that differ.
fn models_page(all: Vec<crate::providers::store::ModelInfo>, query: &ModelsQuery) -> Value {
    let common = json!({
        "tools": !all.is_empty() && all.iter().all(|model| model.metadata.tools),
        "vision": !all.is_empty() && all.iter().all(|model| model.metadata.vision),
    });
    let term = query.q.as_deref().unwrap_or("").trim().to_lowercase();
    let include = query.include.as_deref().unwrap_or("");
    let mut included = None;
    let mut matches = Vec::new();
    for model in all {
        let haystack = format!(
            "{} {} {}",
            model.id,
            model.prefs.alias.as_deref().unwrap_or(""),
            model.metadata.name.as_deref().unwrap_or("")
        )
        .to_lowercase();
        if term.is_empty() || haystack.contains(&term) {
            matches.push(model);
        } else if !include.is_empty() && model.id == include {
            included = Some(model);
        }
    }
    let total = matches.len();
    let Some(limit) = query.limit else {
        return json!({"models": matches, "total": total, "nextCursor": null, "common": common});
    };
    let limit = limit.clamp(1, MAX_MODEL_PAGE);
    let start = query
        .after
        .as_deref()
        .map(|after| matches.partition_point(|model| model.id.as_str() <= after))
        .unwrap_or(0);
    // `matches` keeps the earlier pages, `page` this one, `later` the rest.
    let mut page = matches.split_off(start.min(matches.len()));
    let mut later = page.split_off(limit.min(page.len()));
    let next_cursor = if later.is_empty() {
        None
    } else {
        page.last().map(|model| model.id.clone())
    };
    if !include.is_empty() && !page.iter().any(|model| model.id == include) {
        // It may also sit on another page; the client keys rows by ID, so
        // seeing it twice never draws it twice.
        let take = |models: &mut Vec<crate::providers::store::ModelInfo>| {
            let position = models.iter().position(|model| model.id == include)?;
            Some(models.swap_remove(position))
        };
        if let Some(model) = included
            .or_else(|| take(&mut matches))
            .or_else(|| take(&mut later))
        {
            page.push(model);
        }
    }
    json!({"models": page, "total": total, "nextCursor": next_cursor, "common": common})
}

async fn model_prefs(
    State(state): State<AppState>,
    Path((profile_id, model_id)): Path<(String, String)>,
    Json(body): Json<crate::providers::store::ModelPrefs>,
) -> Response {
    provider_response(
        state
            .agent
            .save_model_prefs(
                &ModelRef {
                    profile_id,
                    model_id,
                },
                &body,
            )
            .map(|()| json!({"ok": true})),
    )
}
