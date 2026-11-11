//! Same-origin browser pixels and bounded human input. Node authorizes tab ownership
//! before upgrade; Rust owns a single latest-frame channel per browser tab.
use crate::{state::AppState, util::json_error};
use axum::{
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, watch};

const TAB_CLOSED_CODE: u16 = 4404;

/// These channels are created when tabs register and removed when they close.
/// A new subscriber immediately sees the last completed frame; no Node replay
/// and no UUID-keyed Rust viewer map are necessary.

pub(crate) type FrameChannels = Arc<Mutex<HashMap<String, TabFrames>>>;
pub(crate) struct TabFrames {
    pub scopes: HashSet<String>,
    pub latest: watch::Sender<Option<Arc<Vec<u8>>>>,
}
impl TabFrames {
    pub fn new() -> Self {
        let (latest, _) = watch::channel(None);
        Self {
            scopes: HashSet::new(),
            latest,
        }
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/browser/active-conversations", get(active_conversations))
        .route("/browser/:kind/:id/tabs", get(tabs))
        .route("/browser/:kind/:id/tabs/:tab/close", post(close_tab))
        .route("/browser/:kind/:id/tabs/:tab/thumbnail", get(thumbnail))
        .route("/browser/:kind/:id/tabs/:tab/stream", get(stream))
}

fn valid_scope_id(kind: &str, id: &str) -> bool {
    match kind {
        "conversation" => {
            !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_digit())
        }
        "thread" => id.len() == 12 && id.bytes().all(|b| b.is_ascii_hexdigit()),
        _ => false,
    }
}

async fn scope(state: &AppState, kind: &str, id: &str) -> Option<String> {
    if !valid_scope_id(kind, id) {
        return None;
    }
    let state = state.clone();
    let id = id.to_string();
    let kind = kind.to_string();
    tokio::task::spawn_blocking(move || {
        let exists = match kind.as_str() {
            "conversation" => crate::conversations::get(&state, &id)
                .ok()
                .flatten()
                .is_some(),
            "thread" => crate::connections::thread_exists(&state, &id).unwrap_or(false),
            _ => false,
        };
        exists.then(|| format!("{kind}:{id}"))
    })
    .await
    .ok()
    .flatten()
}

async fn active_conversations(State(state): State<AppState>) -> Response {
    Json(state.browser.viewer_presence()).into_response()
}

async fn tabs(State(state): State<AppState>, Path((kind, id)): Path<(String, String)>) -> Response {
    let Some(scope) = scope(&state, &kind, &id).await else {
        return unavailable();
    };
    match state
        .browser
        .viewer_request(json!({"action":"list", "scope":scope}))
        .await
    {
        Ok(value) => Json(value).into_response(),
        // No browser runtime means no live resources, not a launch request.
        Err(_) => Json(json!({"tabs":[]})).into_response(),
    }
}

async fn close_tab(
    State(state): State<AppState>,
    Path((kind, id, tab)): Path<(String, String, String)>,
) -> Response {
    let Some(scope) = scope(&state, &kind, &id).await else {
        return unavailable();
    };
    match state
        .browser
        .viewer_request(json!({"action":"close", "scope":scope, "tab":tab}))
        .await
    {
        Ok(value) => Json(value).into_response(),
        Err(_) => unavailable(),
    }
}

async fn thumbnail(
    State(state): State<AppState>,
    Path((kind, id, tab)): Path<(String, String, String)>,
) -> Response {
    let Some(scope) = scope(&state, &kind, &id).await else {
        return unavailable();
    };
    let Some(frame) = state.browser.viewer_thumbnail(&scope, &tab) else {
        return unavailable();
    };
    (
        [
            (header::CONTENT_TYPE, "image/jpeg"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        frame[8..].to_vec(),
    )
        .into_response()
}

fn unavailable() -> Response {
    json_error(StatusCode::NOT_FOUND, "Browser tab unavailable")
}

async fn stream(
    State(state): State<AppState>,
    Path((kind, id, tab)): Path<(String, String, String)>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !headers.contains_key(header::ORIGIN) {
        return json_error(StatusCode::FORBIDDEN, "missing_origin");
    }
    let Some(scope) = scope(&state, &kind, &id).await else {
        return unavailable();
    };
    // Own the stop guard before asking Node to start. Every return path now
    // releases the same viewer ID, including timeouts and failed upgrades.
    let lease = ViewerLease::new(state.browser.clone());
    // Start authorizes the tab before upgrade. Unknown IDs never create Rust channels.
    match state
        .browser
        .viewer_request(json!({
            "action":"start", "scope":scope, "tab":tab, "viewer":lease.id
        }))
        .await
    {
        Ok(_) => {}
        Err(error) if error == "too_many_browser_viewers" => {
            return json_error(StatusCode::TOO_MANY_REQUESTS, "Too many browser viewers");
        }
        Err(_) => return unavailable(),
    }
    let Some(sub) = state.browser.viewer_subscription(&tab, lease) else {
        return unavailable();
    };
    ws.max_message_size(16 * 1024)
        .max_frame_size(16 * 1024)
        .on_upgrade(move |socket| run(socket, state, scope, tab, sub))
        .into_response()
}

/// Owns the Node viewer reference from before start until the socket ends.
pub(crate) struct ViewerLease {
    id: String,
    browser: Arc<crate::browser::BrowserService>,
}

impl ViewerLease {
    fn new(browser: Arc<crate::browser::BrowserService>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            browser,
        }
    }
    pub(crate) fn id(&self) -> &str {
        &self.id
    }
}

impl Drop for ViewerLease {
    fn drop(&mut self) {
        let browser = self.browser.clone();
        let id = self.id.clone();
        tokio::spawn(async move {
            let _ = browser
                .viewer_request(json!({"action":"stop", "viewer":id}))
                .await;
        });
    }
}

pub(crate) struct Subscription {
    pub frames: watch::Receiver<Option<Arc<Vec<u8>>>>,
    pub lease: ViewerLease,
}

async fn send(socket: &mut WebSocket, message: Message) -> bool {
    matches!(
        tokio::time::timeout(Duration::from_secs(2), socket.send(message)).await,
        Ok(Ok(()))
    )
}

async fn run(
    mut socket: WebSocket,
    state: AppState,
    scope: String,
    tab: String,
    mut sub: Subscription,
) {
    let (input_tx, mut input_rx) = mpsc::channel::<Value>(32);
    let (result_tx, mut result_rx) = mpsc::channel::<Value>(16);
    let browser = state.browser.clone();
    let viewer_id = sub.lease.id().to_owned();
    let input_scope = scope.clone();
    // Ordered input runs independently: a slow navigation cannot stall JPEGs.
    let worker = tokio::spawn(async move {
        while let Some(input) = input_rx.recv().await {
            let result = browser.viewer_request(json!({
                "action":"input", "scope":input_scope, "tab":tab, "viewer":viewer_id, "input":input
            })).await;
            let event = match result {
                Ok(value) => json!({"event":"input_result", "result":value}),
                Err(_) => {
                    json!({"event":"input_error", "message":"Action unavailable. The page or viewport may have changed."})
                }
            };
            if result_tx.send(event).await.is_err() {
                break;
            }
        }
    });

    // Start authorizes before subscription; watch retains the latest complete frame.
    let initial = sub.frames.borrow_and_update().clone();
    if let Some(frame) = initial {
        if !send(&mut socket, Message::Binary((*frame).clone())).await {
            worker.abort();
            return;
        }
    }
    let mut ping = tokio::time::interval(Duration::from_secs(15));
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_pong = Instant::now();
    let mut rate_start = Instant::now();
    let mut events = 0_u32;
    loop {
        tokio::select! {
            changed = sub.frames.changed() => {
                if changed.is_err() {
                    let _ = send(&mut socket, Message::Close(Some(CloseFrame {
                        code: TAB_CLOSED_CODE,
                        reason: "tab_closed".into(),
                    }))).await;
                    break;
                }
                let next = sub.frames.borrow_and_update().clone();
                let Some(frame) = next else {
                    let _ = send(&mut socket, Message::Close(Some(CloseFrame {
                        code: 1011,
                        reason: "browser_host_unavailable".into(),
                    }))).await;
                    break;
                };
                if !send(&mut socket, Message::Binary((*frame).clone())).await { break; }
            }
            event = result_rx.recv() => {
                let Some(event) = event else { break; };
                if !send(&mut socket, Message::Text(event.to_string())).await { break; }
            }
            message = socket.recv() => {
                let Some(Ok(message)) = message else { break; };
                match message {
                    Message::Pong(_) => { last_pong = Instant::now(); }
                    Message::Close(_) => break,
                    Message::Text(text) => {
                        if rate_start.elapsed() >= Duration::from_secs(1) {
                            rate_start = Instant::now();
                            events = 0;
                        }
                        events += 1;
                        // Busy touch devices can exceed the limit; drop excess
                        // input, never disconnect the live frame stream.
                        if events > 90 { continue; }
                        let Ok(input) = serde_json::from_str::<Value>(&text) else { continue; };
                        if !input["type"].is_string() { continue; }
                        let _ = input_tx.try_send(input);
                    }
                    _ => {}
                }
            }
            _ = ping.tick() => {
                if last_pong.elapsed() > Duration::from_secs(45) { break; }
                // Scope revocation remains enforced while connected.
                let (kind, id) = scope.split_once(':').expect("validated browser scope");
                if self::scope(&state, kind, id).await.is_none() { break; }
                if !send(&mut socket, Message::Ping(vec![])).await { break; }
            }
        }
    }
    worker.abort();
}
