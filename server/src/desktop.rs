use crate::{
    browser::{BrowserSetting, BrowserSettingsError},
    connections, local_open, marketplace, plugins, roots,
    settings::Settings,
    state::AppState,
    util::{html_escape, json_error},
};
use axum::{
    extract::ws::{Message, WebSocketUpgrade},
    extract::{DefaultBodyLimit, Multipart, Path, Query, Request, State},
    http::{header, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::{io::AsyncWriteExt, sync::broadcast::error::RecvError};

/// Where [`router`] is mounted.
pub(crate) const ROUTE_PREFIX: &str = "/desktop";
/// The OAuth redirect route registered with MCP authorization servers.
pub(crate) const MCP_OAUTH_CALLBACK_ROUTE: &str = "/plugins/mcp/oauth/callback";
const PLUGIN_UPLOAD_BODY_LIMIT_BYTES: usize = 256 * 1024 * 1024;
const MAX_PLUGIN_UPLOADS: usize = 45;
const MAX_PLUGIN_ZIP_COMPRESSED_BYTES: u64 = 128 * 1024 * 1024;
const MAX_PLUGIN_REQUEST_COMPRESSED_BYTES: u64 = 256 * 1024 * 1024;

/// Plugin listing for the desktop UI, without the raw input schemas it never
/// reads.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginListView<'a> {
    plugins: Vec<PluginView<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginView<'a> {
    id: &'a str,
    name: &'a str,
    version: Option<&'a str>,
    description: &'a str,
    theme_color: &'a str,
    runtime: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    marketplace: Option<&'a plugins::MarketplaceProvenance>,
    /// Whether the Plugin is an HTTP MCP server that can be (re)authorized.
    oauth: bool,
    enabled: bool,
    secrets: &'a [plugins::PluginSecretManifest],
    actions: Vec<PluginActionView<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginActionView<'a> {
    id: &'a str,
    name: &'a str,
    description: &'a str,
    args: Vec<&'a str>,
    mutative: bool,
    enabled: bool,
}

#[derive(Deserialize, Serialize)]
struct PathBody {
    path: String,
}

#[derive(Deserialize)]
struct PageQuery {
    limit: usize,
    before: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionPageQuery {
    limit: usize,
    before_last_activity_at: Option<String>,
    before_id: Option<String>,
    #[serde(default)]
    q: String,
}

#[derive(Deserialize)]
struct ConnectionSearchQuery {
    #[serde(default)]
    q: String,
}

#[derive(Deserialize)]
struct BrowseWorkspaceQuery {
    path: Option<String>,
}

#[derive(Deserialize)]
struct EnabledBody {
    enabled: bool,
}

#[derive(Deserialize)]
struct BulkDeleteBody {
    confirmation: String,
}

#[derive(Deserialize)]
struct SecretBody {
    value: String,
}

#[derive(Deserialize)]
pub(crate) struct McpOAuthCallbackQuery {
    code: Option<String>,
    state: Option<String>,
    iss: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

/** Settings hold no secrets, so the desktop sees them as stored. */
fn public_settings(settings: &Settings) -> serde_json::Value {
    serde_json::to_value(settings).expect("Settings must serialize")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettingsResponse {
    settings: serde_json::Value,
    restart_required: bool,
}

fn settings_response(state: &AppState, saved: &Settings) -> DesktopSettingsResponse {
    let settings = public_settings(saved);
    DesktopSettingsResponse {
        restart_required: settings != public_settings(&state.config.settings),
        settings,
    }
}

/// Merge only existing keys, rejecting unknown fields and nested replacements.
/// Writable roots are deliberately enumerated in `update_settings`.
fn merge_settings_patch(
    current: &mut serde_json::Value,
    patch: &serde_json::Value,
) -> Result<(), String> {
    let changes = patch
        .as_object()
        .ok_or("Settings changes must be an object")?;
    let target = current
        .as_object_mut()
        .ok_or("Settings must be an object")?;
    for (key, value) in changes {
        let existing = target
            .get_mut(key)
            .ok_or_else(|| format!("Unknown setting: {key}"))?;
        if existing.is_object() {
            merge_settings_patch(existing, value)?;
        } else {
            *existing = value.clone();
        }
    }
    Ok(())
}

async fn read_settings(State(state): State<AppState>) -> Response {
    match Settings::load(&state.config.storage) {
        Ok(saved) => Json(settings_response(&state, &saved)).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn update_settings(
    State(state): State<AppState>,
    Json(patch): Json<serde_json::Value>,
) -> Response {
    let Some(changes) = patch.as_object() else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Settings changes must be an object",
        );
    };
    for key in changes.keys() {
        if !matches!(key.as_str(), "ports" | "limits") {
            return json_error(
                StatusCode::BAD_REQUEST,
                format!("Setting is not editable: {key}"),
            );
        }
    }

    let _guard = state.settings_write_lock.lock().unwrap();
    let mut saved = match Settings::load(&state.config.storage) {
        Ok(saved) => saved,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    };
    let mut merged = serde_json::to_value(&saved).expect("Settings must serialize");
    if let Err(error) = merge_settings_patch(&mut merged, &patch) {
        return json_error(StatusCode::BAD_REQUEST, error);
    }
    saved = match serde_json::from_value(merged) {
        Ok(settings) => settings,
        Err(error) => return json_error(StatusCode::BAD_REQUEST, error),
    };
    if let Err(error) = saved.validate() {
        return json_error(StatusCode::BAD_REQUEST, error);
    }
    if let Err(error) = saved.save(&state.config.storage) {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, error);
    }
    Json(settings_response(&state, &saved)).into_response()
}

#[derive(Deserialize)]
struct BrowserSettingsQuery {
    /// Detect installed browsers again instead of using the cached list.
    #[serde(default)]
    refresh: bool,
}

async fn browser_settings(
    State(state): State<AppState>,
    Query(query): Query<BrowserSettingsQuery>,
) -> Response {
    browser_settings_response(
        state
            .browser
            .settings_action(
                BrowserSetting::Read,
                &serde_json::json!({ "refresh": query.refresh }),
            )
            .await,
    )
}

async fn change_browser_settings(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let action = match body.get("action").and_then(serde_json::Value::as_str) {
        Some("open") => BrowserSetting::Open,
        Some("select") => BrowserSetting::Select,
        Some("reset") => BrowserSetting::Reset,
        _ => {
            return browser_settings_response(Err(BrowserSettingsError {
                code: "invalid_argument".into(),
                message: "Unknown browser setting.".into(),
            }))
        }
    };
    browser_settings_response(state.browser.settings_action(action, &body).await)
}

fn browser_settings_response(result: Result<serde_json::Value, BrowserSettingsError>) -> Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => {
            let status = match error.code.as_str() {
                "confirmation_required" => StatusCode::CONFLICT,
                "browser_unavailable" | "window_unavailable" | "runtime_lost" => {
                    StatusCode::SERVICE_UNAVAILABLE
                }
                "browser_capacity_reached" => StatusCode::TOO_MANY_REQUESTS,
                "invalid_argument" => StatusCode::BAD_REQUEST,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            };
            (status, Json(error)).into_response()
        }
    }
}

async fn onboarding_status(State(state): State<AppState>) -> Response {
    match crate::first_run::onboarding_pending(&state) {
        Ok(pending) => Json(json!({ "pending": pending })).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn onboarding_complete(State(state): State<AppState>) -> Response {
    match crate::first_run::complete_onboarding(&state) {
        Ok(()) => Json(json!({ "pending": false })).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

pub fn router(state: AppState) -> Router<AppState> {
    Router::new()
        .route(
            "/onboarding",
            get(onboarding_status).post(onboarding_complete),
        )
        .route("/settings", get(read_settings).post(update_settings))
        .route(
            "/browser",
            get(browser_settings).post(change_browser_settings),
        )
        .merge(crate::browser_viewer::router())
        .route("/events", get(events))
        .route("/workspaces", get(workspaces))
        .route("/workspaces/add", post(add_workspace))
        .route("/workspaces/toggle", post(toggle_workspace))
        .route("/workspaces/remove", post(remove_workspace))
        .route("/workspaces/reveal", post(reveal_workspace))
        .route("/workspaces/browse", get(browse_workspace))
        .route("/files/open", post(open_local_path))
        .route("/plugins", get(plugins))
        .route("/plugins/marketplace", get(cached_marketplace))
        .route("/plugins/marketplace/refresh", post(refresh_marketplace))
        .route("/plugins/marketplace/icons/:id", get(marketplace_icon))
        .route(
            "/plugins/marketplace/install",
            post(install_marketplace_wasm),
        )
        .route("/plugins/marketplace/update", post(update_marketplace_wasm))
        .route(
            "/plugins/marketplace/mcp/connect",
            post(connect_marketplace_mcp),
        )
        .route(
            "/plugins/marketplace/mcp/candidates/:id/install",
            post(install_marketplace_mcp),
        )
        .route(
            "/plugins/marketplace/operations",
            get(marketplace_operations),
        )
        .route(
            "/plugins/marketplace/operations/:id/cancel",
            post(cancel_marketplace_operation),
        )
        .route("/plugins/delete-all", post(delete_all_plugins))
        .route("/plugins/mcp/connect", post(connect_mcp))
        .route("/plugins/:id/mcp/authorize", post(authorize_mcp_plugin))
        .route(
            "/plugins/mcp/candidates/:id/install",
            post(install_mcp_candidate),
        )
        .route(
            "/plugins/mcp/candidates/:id/cancel",
            post(cancel_mcp_candidate),
        )
        .route(
            "/plugins/mcp/candidates/:id/status",
            get(mcp_candidate_status),
        )
        // Package previews are read in the browser from the zip itself, so the
        // archive is uploaded once, at install.
        .route(
            "/plugins/import",
            post(import_plugins).layer(DefaultBodyLimit::max(PLUGIN_UPLOAD_BODY_LIMIT_BYTES)),
        )
        .route("/plugins/:id/set-enabled", post(set_plugin_enabled))
        .route(
            "/plugins/:id/actions/:name/set-enabled",
            post(set_plugin_action_enabled),
        )
        .route("/plugins/:id/delete", post(delete_plugin))
        .route("/plugins/:id/state/clear", post(clear_plugin_state))
        .route("/plugins/:id/icon", get(plugin_icon))
        .route("/plugins/:id/secrets", get(plugin_secrets))
        .route("/plugins/:id/secrets/:name", post(set_plugin_secret))
        .route(
            "/plugins/:id/secrets/:name/delete",
            post(delete_plugin_secret),
        )
        .route(
            "/plugins/:id/secrets/delete-all",
            post(delete_all_plugin_secrets),
        )
        .route("/account", get(account_status))
        .route("/account/connect", post(account_connect))
        .route("/account/verify", post(account_verify))
        .route("/account/profile", get(account_profile))
        .route("/account/disconnect", post(account_disconnect))
        .route("/remote", get(remote_status))
        .route("/remote/apps", get(remote_apps))
        .route("/remote/set-enabled", post(remote_set_enabled))
        .route("/chatgpt/status", get(chatgpt_status))
        .route("/chatgpt/start", post(chatgpt_start))
        .route("/chatgpt/signout", post(chatgpt_signout))
        .route("/connections", get(connection_clients))
        .route("/connections/threads", get(connection_all_threads))
        .route("/connections/:client/threads", get(connection_threads))
        .route("/threads/:id", get(thread_info))
        .route("/threads/:id/calls", get(thread_calls))
        .route("/thread-calls/:id", get(thread_call))
        .route("/threads/delete-all", post(delete_all_threads))
        .route("/threads/:id/delete", post(thread_delete))
        .merge(crate::conversations::http::router())
        .route(MCP_OAUTH_CALLBACK_ROUTE, get(mcp_oauth_callback))
        .fallback(desktop_not_found)
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_desktop_request,
        ))
}

async fn desktop_not_found() -> Response {
    json_error(StatusCode::NOT_FOUND, "not_found")
}

async fn account_status(State(state): State<AppState>) -> Response {
    match state.account.status().await {
        Ok(status) => Json(status).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn account_connect(State(state): State<AppState>) -> Response {
    match state.account.connect().await {
        Ok(status) => Json(status).into_response(),
        // The full chain says why ("connection refused", a TLS failure).
        Err(error) => json_error(StatusCode::BAD_REQUEST, format!("{error:#}")),
    }
}

/// A refused hosted call: revocation is a state change the client should
/// re-read, not a gateway failure to retry.
fn account_error(error: anyhow::Error) -> Response {
    if error.downcast_ref::<crate::account::Revoked>().is_some() {
        return json_error(StatusCode::CONFLICT, error);
    }
    json_error(StatusCode::BAD_GATEWAY, format!("{error:#}"))
}

async fn account_verify(State(state): State<AppState>) -> Response {
    match state.account.access_token().await {
        Ok(_) => Json(json!({ "authorized": true })).into_response(),
        Err(error) => account_error(error),
    }
}

/// Who the installation is connected as. The access token stays in Rust.
async fn account_profile(State(state): State<AppState>) -> Response {
    match state.account.profile().await {
        Ok(profile) => Json(profile).into_response(),
        Err(error) => account_error(error),
    }
}

async fn account_disconnect(State(state): State<AppState>) -> Response {
    match state.account.disconnect().await {
        Ok(outcome) => Json(outcome).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn remote_status(State(state): State<AppState>) -> Response {
    match state.remote.status().await {
        Ok(status) => Json(status).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn remote_apps(State(state): State<AppState>) -> Response {
    match state.remote.apps().await {
        Ok(apps) => Json(apps).into_response(),
        Err(error) => {
            let status = if error.downcast_ref::<crate::account::Revoked>().is_some() {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_GATEWAY
            };
            json_error(status, format!("{error:#}"))
        }
    }
}

async fn remote_set_enabled(
    State(state): State<AppState>,
    Json(body): Json<EnabledBody>,
) -> Response {
    match state.remote.set_enabled(&state, body.enabled).await {
        Ok(status) => Json(status).into_response(),
        Err(error) => {
            let status = if error.downcast_ref::<crate::account::Revoked>().is_some() {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_REQUEST
            };
            json_error(status, format!("{error:#}"))
        }
    }
}

async fn chatgpt_status(State(state): State<AppState>) -> Response {
    match state.agent.chatgpt() {
        Ok(auth) => Json(auth.status()).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn chatgpt_start(State(state): State<AppState>) -> Response {
    let auth = match state.agent.chatgpt() {
        Ok(auth) => auth,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    };
    match auth.start() {
        Ok(()) => Json(json!({"started": true})).into_response(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error),
    }
}

async fn chatgpt_signout(State(state): State<AppState>) -> Response {
    match state.agent.chatgpt() {
        Ok(auth) => match auth.sign_out().await {
            Ok(()) => Json(json!({"signedOut": true})).into_response(),
            Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
        },
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn events(State(state): State<AppState>, ws: WebSocketUpgrade) -> axum::response::Response {
    ws.on_upgrade(move |mut socket| async move {
        let mut events = state.desktop_events.subscribe();
        loop {
            let batch = match events.recv().await {
                Ok(event) => vec![event],
                // A slow client missed events; tell it to refresh everything
                // instead of dropping the connection.
                Err(RecvError::Lagged(_)) => AppState::resync_events().to_vec(),
                Err(RecvError::Closed) => break,
            };
            for event in batch {
                if socket.send(Message::Text(event.to_string())).await.is_err() {
                    return;
                }
            }
        }
    })
}

async fn workspaces(State(state): State<AppState>) -> axum::response::Response {
    json_result(roots::list(&state))
}

async fn add_workspace(
    State(state): State<AppState>,
    Json(body): Json<PathBody>,
) -> axum::response::Response {
    json_result(roots::add(&state, &body.path))
}

async fn browse_workspace(Query(query): Query<BrowseWorkspaceQuery>) -> axum::response::Response {
    json_result(roots::browse(query.path.as_deref()))
}

async fn toggle_workspace(
    State(state): State<AppState>,
    Json(body): Json<PathBody>,
) -> axum::response::Response {
    let result = roots::list(&state).and_then(|roots| {
        let enabled = roots
            .into_iter()
            .find(|root| root.path == body.path)
            .map(|root| root.enabled)
            .ok_or_else(|| anyhow::anyhow!("Root not found"))?;
        roots::set_enabled(&state, &body.path, !enabled)
    });
    json_result(result)
}

async fn remove_workspace(
    State(state): State<AppState>,
    Json(body): Json<PathBody>,
) -> axum::response::Response {
    json_result(roots::remove(&state, &body.path))
}

async fn reveal_workspace(Json(body): Json<PathBody>) -> axum::response::Response {
    match local_open::reveal(std::path::Path::new(&body.path)) {
        Ok(()) => Json(json!(true)).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

/// Opens a path an answer links to, inside the enabled roots only.
async fn open_local_path(
    State(state): State<AppState>,
    Json(body): Json<PathBody>,
) -> axum::response::Response {
    match local_open::open(&state, &body.path) {
        Ok(result) => Json(result).into_response(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error),
    }
}

async fn cached_marketplace(State(state): State<AppState>) -> Response {
    json_result(marketplace::desktop_snapshot(&state))
}

async fn refresh_marketplace(State(state): State<AppState>) -> Response {
    marketplace::refresh(&state).await;
    json_result(marketplace::desktop_snapshot(&state))
}

async fn marketplace_icon(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<PluginIconQuery>,
) -> Response {
    let scheme = query
        .variant
        .as_deref()
        .and_then(plugins::IconScheme::parse);
    match marketplace::icon(&state, &id, scheme).await {
        Ok((mime, bytes)) => (
            [
                (header::CONTENT_TYPE, mime),
                (header::CACHE_CONTROL, "private, max-age=60"),
            ],
            bytes,
        )
            .into_response(),
        Err(error) => {
            tracing::warn!(%error, %id, "Marketplace icon unavailable");
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarketplaceInstallRequest {
    id: String,
    version: String,
    artifact_sha256: String,
}

async fn install_marketplace_wasm(
    State(state): State<AppState>,
    Json(request): Json<MarketplaceInstallRequest>,
) -> Response {
    queue_marketplace_wasm(state, request, false)
}

async fn update_marketplace_wasm(
    State(state): State<AppState>,
    Json(request): Json<MarketplaceInstallRequest>,
) -> Response {
    queue_marketplace_wasm(state, request, true)
}

fn queue_marketplace_wasm(
    state: AppState,
    request: MarketplaceInstallRequest,
    update: bool,
) -> Response {
    let intent = match marketplace::wasm_install_intent(
        &state,
        &request.id,
        &request.version,
        &request.artifact_sha256,
        update,
    ) {
        Ok(intent) => intent,
        Err(error) => return json_error(StatusCode::BAD_REQUEST, error),
    };
    let queued_state = state.clone();
    json_result(
        state
            .marketplace_operations
            .enqueue(request.id, move |context| {
                marketplace::change_wasm(queued_state, intent, context)
            }),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarketplaceMcpConnectRequest {
    id: String,
    #[serde(default)]
    credentials: std::collections::HashMap<String, String>,
    #[serde(default)]
    executable_path: Option<String>,
    #[serde(default)]
    oauth: plugins::DirectMcpOAuthOptions,
}

async fn connect_marketplace_mcp(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<MarketplaceMcpConnectRequest>,
) -> Response {
    let redirect_uri = match mcp_oauth_callback_url(&headers, &state) {
        Ok(uri) => uri,
        Err(error) => return json_error(StatusCode::BAD_REQUEST, error),
    };
    json_result(
        marketplace::connect_mcp(
            &state,
            &request.id,
            request.credentials,
            request.oauth,
            request.executable_path,
            redirect_uri,
        )
        .await,
    )
}

async fn install_marketplace_mcp(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    let candidate = match plugins::claim_marketplace_mcp_candidate(&state, &id) {
        Ok(candidate) => candidate,
        Err(error) => return json_error(StatusCode::BAD_REQUEST, error),
    };
    let queued_state = state.clone();
    json_result(
        state
            .marketplace_operations
            .enqueue(candidate.manifest().id.clone(), move |context| {
                marketplace::install_mcp(queued_state, candidate, context)
            }),
    )
}

async fn marketplace_operations(
    State(state): State<AppState>,
) -> Json<Vec<crate::marketplace_operations::Operation>> {
    Json(state.marketplace_operations.list())
}

async fn cancel_marketplace_operation(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    match state.marketplace_operations.cancel(&id) {
        Some(operation) => Json(operation).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn import_plugins(
    State(state): State<AppState>,
    multipart: Multipart,
) -> axum::response::Response {
    match plugin_uploads(&state, multipart).await {
        Ok((uploads, credentials)) => {
            json_result(plugins::import_plugin_zips(&state, uploads, credentials).await)
        }
        Err(error) => json_error(StatusCode::BAD_REQUEST, error),
    }
}

async fn connect_mcp(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<plugins::DirectMcpConnectRequest>,
) -> axum::response::Response {
    let redirect_uri = match mcp_oauth_callback_url(&headers, &state) {
        Ok(uri) => uri,
        Err(error) => return json_error(StatusCode::BAD_REQUEST, error),
    };
    json_result(plugins::connect_mcp_candidate(&state, request, redirect_uri).await)
}

async fn authorize_mcp_plugin(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> axum::response::Response {
    let redirect_uri = match mcp_oauth_callback_url(&headers, &state) {
        Ok(uri) => uri,
        Err(error) => return json_error(StatusCode::BAD_REQUEST, error),
    };
    plugin_result(plugins::authorize_mcp_plugin(&state, &id, redirect_uri).await)
}

async fn install_mcp_candidate(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(request): Json<plugins::DirectMcpInstallRequest>,
) -> axum::response::Response {
    updated_plugin_result(plugins::install_mcp_candidate(&state, &id, request).await)
}

async fn cancel_mcp_candidate(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    Json(plugins::cancel_mcp_candidate(&state, &id)).into_response()
}

async fn mcp_candidate_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    json_result(plugins::mcp_candidate_status(&state, &id))
}

async fn mcp_oauth_callback(
    State(state): State<AppState>,
    Query(query): Query<McpOAuthCallbackQuery>,
) -> axum::response::Response {
    let candidate = match query.state.as_deref() {
        Some(csrf_state) => plugins::mcp_oauth_candidate_for_state(&state, csrf_state),
        None => Err(anyhow::anyhow!("MCP OAuth callback is missing state")),
    };
    let result: anyhow::Result<()> = async {
        let candidate = candidate?;
        if let Some(error) = query.error {
            let message = format!(
                "MCP OAuth failed: {}{}",
                error,
                query
                    .error_description
                    .as_deref()
                    .map(|description| format!(": {description}"))
                    .unwrap_or_default()
            );
            match query.state.as_deref() {
                Some(csrf_state) => {
                    plugins::fail_mcp_oauth(&state, &candidate, csrf_state, message.clone())
                        .and_then(|()| Err(anyhow::anyhow!(message)))
                }
                None => Err(anyhow::anyhow!("MCP OAuth callback is missing state")),
            }
        } else {
            match (query.code.as_deref(), query.state.as_deref()) {
                (Some(code), Some(csrf_state)) => {
                    plugins::complete_mcp_oauth(
                        &state,
                        &candidate,
                        code,
                        csrf_state,
                        query.iss.as_deref(),
                    )
                    .await
                }
                _ => Err(anyhow::anyhow!(
                    "MCP OAuth callback is missing code or state"
                )),
            }
        }
    }
    .await;
    let (title, detail, close_script) = match result {
        Ok(()) => (
            "MCP authorization complete",
            "You can return to Squire.".to_string(),
            "<script>setTimeout(()=>window.close(),800)</script>",
        ),
        Err(error) => ("MCP authorization failed", format!("{error:#}"), ""),
    };
    let html = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{title}</title><body><h1>{title}</h1><p>{}</p>{close_script}</body>",
        html_escape(&detail)
    );
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response()
}

async fn plugins(State(state): State<AppState>) -> axum::response::Response {
    let catalog = match plugins::catalog(&state) {
        Ok(catalog) => catalog,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    };
    let view = PluginListView {
        plugins: catalog.index.plugins.iter().map(plugin_view).collect(),
    };
    Json(view).into_response()
}

fn plugin_view(plugin: &plugins::IndexedPlugin) -> PluginView<'_> {
    let (runtime, oauth) = match &plugin.runtime {
        plugins::IndexedRuntime::Wasm => ("wasm", false),
        plugins::IndexedRuntime::Mcp(runtime) => (
            "mcp",
            matches!(runtime.mcp, plugins::McpConfig::StreamableHttp { .. }),
        ),
    };
    PluginView {
        id: &plugin.id,
        name: &plugin.name,
        version: plugin.version.as_deref(),
        description: &plugin.description,
        theme_color: &plugin.theme_color,
        runtime,
        marketplace: plugin.marketplace.as_ref(),
        oauth,
        enabled: plugin.enabled,
        secrets: &plugin.secrets,
        actions: plugin
            .actions
            .iter()
            .map(|action| PluginActionView {
                id: &action.id,
                name: &action.name,
                description: &action.description,
                args: plugins::action_arg_names(action),
                mutative: action.mutative,
                enabled: action.enabled,
            })
            .collect(),
    }
}

/// Answers a Plugin mutation with the same view the listing uses.
fn updated_plugin_result(
    result: anyhow::Result<plugins::IndexedPlugin>,
) -> axum::response::Response {
    match result {
        Ok(plugin) => Json(plugin_view(&plugin)).into_response(),
        Err(error) => plugin_error(error),
    }
}

async fn set_plugin_enabled(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<EnabledBody>,
) -> axum::response::Response {
    updated_plugin_result(
        blocking_operation(move || plugins::set_plugin_enabled(&state, &id, body.enabled)).await,
    )
}

async fn set_plugin_action_enabled(
    State(state): State<AppState>,
    Path((id, name)): Path<(String, String)>,
    Json(body): Json<EnabledBody>,
) -> axum::response::Response {
    updated_plugin_result(
        blocking_operation(move || plugins::set_action_enabled(&state, &id, &name, body.enabled))
            .await,
    )
}

async fn delete_all_plugins(
    State(state): State<AppState>,
    Json(body): Json<BulkDeleteBody>,
) -> Response {
    if body.confirmation != "DELETE" {
        return json_error(StatusCode::BAD_REQUEST, "Type DELETE to confirm");
    }
    plugin_result(
        blocking_operation(move || {
            plugins::delete_all_plugins(&state).map(|deleted| json!({ "deleted": deleted }))
        })
        .await,
    )
}

async fn delete_plugin(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    plugin_result(
        blocking_operation(move || plugins::delete_plugin(&state, &id).map(|()| json!(true))).await,
    )
}

async fn clear_plugin_state(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    plugin_result(
        blocking_operation(move || plugins::clear_plugin_state(&state, &id).map(|()| json!(true)))
            .await,
    )
}

#[derive(Deserialize)]
struct PluginIconQuery {
    /// `light` or `dark`; anything else (or absent) serves the primary icon.
    variant: Option<String>,
}

async fn plugin_icon(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<PluginIconQuery>,
) -> axum::response::Response {
    let scheme = query
        .variant
        .as_deref()
        .and_then(plugins::IconScheme::parse);
    match plugins::plugin_icon_asset(&state, &id, scheme) {
        Ok((bytes, mime_type)) => (
            [
                ("content-type", mime_type),
                (
                    "content-security-policy",
                    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
                ),
                ("x-content-type-options", "nosniff"),
            ],
            bytes,
        )
            .into_response(),
        Err(error) => plugin_error(error),
    }
}

async fn plugin_secrets(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    plugin_result(plugins::list_plugin_secrets(&state, &id))
}

async fn set_plugin_secret(
    State(state): State<AppState>,
    Path((id, name)): Path<(String, String)>,
    Json(body): Json<SecretBody>,
) -> axum::response::Response {
    plugin_result(plugins::set_plugin_secret(&state, &id, &name, &body.value))
}

async fn delete_plugin_secret(
    State(state): State<AppState>,
    Path((id, name)): Path<(String, String)>,
) -> axum::response::Response {
    plugin_result(plugins::delete_plugin_secret(&state, &id, &name))
}

async fn delete_all_plugin_secrets(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    plugin_result(plugins::delete_all_plugin_secrets(&state, &id))
}

/// Secret values entered for each upload, keyed by upload file name.
type PluginCredentials =
    std::collections::HashMap<String, std::collections::HashMap<String, String>>;

async fn plugin_uploads(
    state: &AppState,
    mut multipart: Multipart,
) -> anyhow::Result<(Vec<plugins::PluginZipUpload>, PluginCredentials)> {
    let mut uploads: Vec<plugins::PluginZipUpload> = Vec::new();
    let mut credentials = PluginCredentials::new();
    let mut request_bytes = 0u64;
    let plugins_dir = state.config.storage.plugins_dir();
    let import_dir = plugins_dir.join(".imports");
    crate::util::create_private_dir(&import_dir)?;
    if !dunce::canonicalize(&import_dir)?.starts_with(dunce::canonicalize(&plugins_dir)?) {
        anyhow::bail!("Plugin import directory escapes Plugin storage");
    }
    while let Some(field) = multipart.next_field().await? {
        if field.name() == Some("credentials") && field.file_name().is_none() {
            credentials = serde_json::from_str(&field.text().await?)
                .map_err(|error| anyhow::anyhow!("invalid Plugin credentials payload: {error}"))?;
            continue;
        }
        if uploads.len() == MAX_PLUGIN_UPLOADS {
            anyhow::bail!(
                "a Plugin import request may contain at most {MAX_PLUGIN_UPLOADS} uploads"
            );
        }
        let file_name = field
            .file_name()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or("plugin.zip")
            .to_string();
        // Credentials are keyed by file name, so names must be unique.
        if uploads.iter().any(|upload| upload.file_name == file_name) {
            anyhow::bail!("duplicate Plugin upload `{file_name}`");
        }
        let named_file = tempfile::Builder::new()
            .prefix("upload-")
            .suffix(".zip")
            .tempfile_in(&import_dir)?;
        let mut file = tokio::fs::File::from_std(named_file.reopen()?);
        let mut field = field;
        let mut compressed_bytes = 0u64;
        while let Some(chunk) = field.chunk().await? {
            let bytes = chunk.len() as u64;
            compressed_bytes += bytes;
            request_bytes += bytes;
            if compressed_bytes > MAX_PLUGIN_ZIP_COMPRESSED_BYTES {
                anyhow::bail!(
                    "Plugin zip exceeds {MAX_PLUGIN_ZIP_COMPRESSED_BYTES} compressed bytes"
                );
            }
            if request_bytes > MAX_PLUGIN_REQUEST_COMPRESSED_BYTES {
                anyhow::bail!(
                    "Plugin import request exceeds {MAX_PLUGIN_REQUEST_COMPRESSED_BYTES} compressed bytes"
                );
            }
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        drop(file);
        let (_, path) = named_file.keep()?;
        uploads.push(plugins::PluginZipUpload {
            file_name,
            path,
            compressed_bytes,
        });
    }
    if uploads.is_empty() {
        anyhow::bail!("at least one Plugin zip is required");
    }
    Ok((uploads, credentials))
}

async fn connection_clients(
    State(state): State<AppState>,
    Query(query): Query<ConnectionSearchQuery>,
) -> axum::response::Response {
    json_result(connections::list_connection_clients(&state, &query.q))
}

async fn connection_all_threads(
    State(state): State<AppState>,
    Query(query): Query<ConnectionPageQuery>,
) -> axum::response::Response {
    let before = match (
        query.before_last_activity_at.as_deref(),
        query.before_id.as_deref(),
    ) {
        (Some(time), Some(id)) => Some((time, id)),
        (None, None) => None,
        _ => return json_error(StatusCode::BAD_REQUEST, "Both cursor fields are required"),
    };
    json_result(connections::list_all_threads(
        &state,
        query.limit,
        before,
        &query.q,
    ))
}

async fn connection_threads(
    State(state): State<AppState>,
    Path(client): Path<String>,
    Query(query): Query<ConnectionPageQuery>,
) -> axum::response::Response {
    let before = match (
        query.before_last_activity_at.as_deref(),
        query.before_id.as_deref(),
    ) {
        (Some(time), Some(id)) => Some((time, id)),
        (None, None) => None,
        _ => return json_error(StatusCode::BAD_REQUEST, "Both cursor fields are required"),
    };
    json_result(connections::list_threads(
        &state,
        &client,
        query.limit,
        before,
        &query.q,
    ))
}

async fn thread_info(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    match connections::thread_info(&state, &id) {
        Ok(Some(session)) => Json(session).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "Missing connection thread"),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn thread_calls(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<PageQuery>,
) -> axum::response::Response {
    json_result(connections::list_calls(
        &state,
        &id,
        query.limit,
        query.before.as_deref(),
    ))
}

async fn thread_call(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    match connections::entry(&state, &id) {
        Ok(Some(entry)) => Json(entry).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "Missing activity entry"),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn delete_all_threads(
    State(state): State<AppState>,
    Json(body): Json<BulkDeleteBody>,
) -> Response {
    if body.confirmation != "DELETE" {
        return json_error(StatusCode::BAD_REQUEST, "Type DELETE to confirm");
    }
    json_result(
        blocking_operation(move || {
            connections::delete_all_threads(&state).map(|deleted| json!({ "deleted": deleted }))
        })
        .await,
    )
}

async fn thread_delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    json_result(
        blocking_operation(move || connections::delete_thread(&state, &id).map(|()| json!(true)))
            .await,
    )
}

// Mutations can wait for a cancelled WASM invocation to release plugin files.
// Keep those waits off the runtime workers that drive invocation completion.
async fn blocking_operation<T: Send + 'static>(
    operation: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> anyhow::Result<T> {
    tokio::task::spawn_blocking(operation).await?
}

fn json_result<T: Serialize>(result: anyhow::Result<T>) -> axum::response::Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, format!("{error:#}")),
    }
}

fn plugin_result<T: Serialize>(result: anyhow::Result<T>) -> axum::response::Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => plugin_error(error),
    }
}

fn plugin_error(error: anyhow::Error) -> axum::response::Response {
    let message = format!("{error:#}");
    let status = if message.starts_with("Plugin `")
        || message.starts_with("Action `")
        || message.starts_with("Secret `")
        || message.starts_with("Service `")
    {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    json_error(status, message)
}

async fn require_desktop_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> axum::response::Response {
    if let Some(rejection) = reject_foreign(&headers, &state.config) {
        return rejection;
    }
    if request.method() == axum::http::Method::POST && !valid_content_type(&headers) {
        return json_error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "invalid_content_type");
    }
    next.run(request).await
}

/// Constructs an OAuth callback on the origin that initiated the connection.
/// The desktop request guard has already validated both Host and Origin against
/// the user's allowed hosts. Browser Origin preserves the scheme and port of
/// an HTTPS reverse proxy; requests without Origin use their validated Host.
fn mcp_oauth_callback_url(headers: &HeaderMap, state: &AppState) -> anyhow::Result<String> {
    use anyhow::{ensure, Context};

    let config = &state.config;
    let origin = if let Some(value) = headers.get(header::ORIGIN) {
        let value = value.to_str().context("Invalid MCP OAuth request origin")?;
        let url = url::Url::parse(value).context("Invalid MCP OAuth request origin")?;
        ensure!(
            url.origin().ascii_serialization() == value,
            "MCP OAuth request origin must be an origin URL"
        );
        url
    } else {
        let authority = headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .context("MCP OAuth request is missing Host")?;
        let (host, _) = split_host_port(authority).context("Invalid MCP OAuth Host")?;
        let scheme = if matches!(host, "127.0.0.1" | "localhost" | "::1") {
            "http"
        } else {
            "https"
        };
        url::Url::parse(&format!("{scheme}://{authority}"))?
    };
    let host = origin
        .host_str()
        .context("MCP OAuth origin is missing a host")?;
    let loopback = matches!(host, "127.0.0.1" | "localhost" | "::1");
    ensure!(
        origin.scheme() == "https" || (origin.scheme() == "http" && loopback),
        "MCP OAuth callbacks require HTTPS outside localhost"
    );
    ensure!(
        (loopback && valid_origin(headers, config.web_port, &config.allowed_hosts))
            || allowed_host(&config.allowed_hosts, host),
        "MCP OAuth callback host is not allowed"
    );
    Ok(format!(
        "{}{}{}",
        origin.origin().ascii_serialization(),
        ROUTE_PREFIX,
        MCP_OAUTH_CALLBACK_ROUTE,
    ))
}

/// The local listener has no login, so every request must come through a
/// loopback Host (no DNS rebinding) or one the person listed in
/// `allowedHosts`, and, when a browser names an origin, from the Squire UI
/// itself rather than another site.
pub(crate) fn reject_foreign(
    headers: &HeaderMap,
    config: &crate::config::Config,
) -> Option<Response> {
    let (port, allowed) = (config.web_port, config.allowed_hosts.as_slice());
    if !valid_host(headers, port, allowed) {
        return Some(json_error(StatusCode::FORBIDDEN, "invalid_host"));
    }
    if !valid_origin(headers, port, allowed) {
        return Some(json_error(StatusCode::FORBIDDEN, "invalid_origin"));
    }
    None
}

/// A host listed in `allowedHosts`: the person's own proxy in front of this
/// machine. Any port, because the proxy chooses the port it serves on.
fn allowed_host(allowed: &[String], host: &str) -> bool {
    allowed.iter().any(|name| name.eq_ignore_ascii_case(host))
}

// A second Vite listener is supported only in debug builds for disposable local profiles.
fn dev_web_port() -> Option<u16> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var("SQUIRE_DEV_WEB_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value != 0)
}

fn valid_host(headers: &HeaderMap, port: u16, allowed: &[String]) -> bool {
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .and_then(split_host_port)
        .is_some_and(|(host, candidate_port)| {
            // Vite serves the local dev UI on 4295 and proxies desktop requests.
            let loopback = matches!(host, "127.0.0.1" | "localhost" | "::1")
                && candidate_port.is_some_and(|value| {
                    value == port || value == 4295 || dev_web_port() == Some(value)
                });
            loopback || allowed_host(allowed, host)
        })
}

fn split_host_port(authority: &str) -> Option<(&str, Option<u16>)> {
    if let Some(authority) = authority.strip_prefix('[') {
        let closing_bracket = authority.find(']')?;
        let host = &authority[..closing_bracket];
        let suffix = &authority[closing_bracket + 1..];
        return if suffix.is_empty() {
            Some((host, None))
        } else {
            Some((host, Some(suffix.strip_prefix(':')?.parse().ok()?)))
        };
    }
    match authority.rsplit_once(':') {
        Some((host, port)) => Some((host, Some(port.parse().ok()?))),
        None if !authority.is_empty() => Some((authority, None)),
        None => None,
    }
}

fn valid_content_type(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value.starts_with("application/json") || value.starts_with("multipart/form-data")
        })
        .unwrap_or(false)
}

fn valid_origin(headers: &HeaderMap, port: u16, allowed: &[String]) -> bool {
    headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(|origin| {
            origin == format!("http://127.0.0.1:{port}")
                || origin == format!("http://localhost:{port}")
                || origin == "http://127.0.0.1:4295"
                || origin == "http://localhost:4295"
                || dev_web_port().is_some_and(|dev_port| {
                    origin == format!("http://127.0.0.1:{dev_port}")
                        || origin == format!("http://localhost:{dev_port}")
                })
                || url::Url::parse(origin).is_ok_and(|url| {
                    matches!(url.scheme(), "http" | "https")
                        && url
                            .host_str()
                            .is_some_and(|host| allowed_host(allowed, host))
                })
        })
        .unwrap_or(true)
}
