use crate::{attachments, desktop, state::AppState};
use anyhow::Result;
use axum::{
    body::Body,
    extract::Request,
    http::{header, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use rust_embed::RustEmbed;
use serde_json::json;
use std::{borrow::Cow, net::SocketAddr, sync::mpsc};
use tokio::{net::TcpListener, sync::watch};

/// Web UI assets embedded into the binary at compile time from
/// `packages/web/dist` (built by `pnpm run build-web`).
/// This is what makes the release binary standalone: no repo checkout needed.
/// In debug builds rust-embed reads from disk, so no override dir is needed.
#[derive(RustEmbed)]
#[folder = "../packages/web/dist/"]
struct FrontendAssets;

/// The address people open, for `port`.
pub fn ui_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

/// Tells the person where Squire is and that the window keeps it alive,
/// then opens the UI unless `open_browser` is off.
fn announce(port: u16, open_browser: bool, allowed_hosts: &[String]) {
    let url = ui_url(port);
    println!();
    println!("  Squire is running at {url}");
    if open_browser && crate::local_open::open_url(&url) {
        println!("  Opened it in your browser.");
    } else {
        println!("  Open that address in your browser to use Squire.");
    }
    if !allowed_hosts.is_empty() {
        println!(
            "  It also answers requests for {} (allowedHosts in settings.json).",
            allowed_hosts.join(", ")
        );
        println!("  Squire has no login there, so that proxy must limit who can reach it.");
    }
    println!();
    // A service (systemd, launchd) has no window to keep open; that advice is for terminals.
    if !std::io::IsTerminal::is_terminal(&std::io::stdout()) {
        return;
    }
    #[cfg(target_os = "android")]
    {
        println!("  Keep this Termux session open while you use Squire. Closing it stops");
        println!("  Squire, and apps connected to this device, like Claude, go offline.");
        println!("  Press Ctrl+C to stop. To keep Squire running in the background,");
        println!("  stop it and run: squire service install");
    }
    #[cfg(not(target_os = "android"))]
    {
        println!("  Keep this window open while you use Squire. Closing it stops Squire,");
        println!("  and apps connected to this computer, like Claude, go offline.");
        println!("  Press Ctrl+C to stop. To keep Squire running without a window,");
        println!("  stop it and run: squire service install");
    }
    println!();
}

pub async fn serve(state: AppState, open_browser: bool) -> Result<()> {
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let (started_tx, _started_rx) = mpsc::channel();
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler");
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
        }
        // Ctrl+Break is how the Windows service's supervisor asks Squire to stop:
        // it starts Squire in its own process group, where Ctrl+C is ignored.
        #[cfg(windows)]
        {
            let mut ctrl_break = tokio::signal::windows::ctrl_break().expect("Ctrl+Break handler");
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = ctrl_break.recv() => {} }
        }
        #[cfg(not(any(unix, windows)))]
        let _ = tokio::signal::ctrl_c().await;
        let _ = shutdown_tx.send(true);
    });
    serve_with_shutdown(state, shutdown_rx, started_tx, open_browser).await
}

pub async fn serve_with_shutdown(
    state: AppState,
    shutdown_rx: watch::Receiver<bool>,
    started_tx: mpsc::Sender<Result<(), String>>,
    open_browser: bool,
) -> Result<()> {
    // Squire's only listener is the passwordless local web UI on loopback.
    // External agents reach this computer only through hosted Remote Access,
    // over the outbound connection in `remote`; nothing here is tunnelled.
    let local = local_router(state.clone());
    let local_addr = SocketAddr::from(([127, 0, 0, 1], state.config.web_port));
    let local_listener = match TcpListener::bind(local_addr).await {
        Ok(listener) => listener,
        Err(error) => {
            let _ = started_tx.send(Err(error.to_string()));
            return Err(error.into());
        }
    };
    let _ = started_tx.send(Ok(()));
    // The terminal gets the plain-language notice below; the log keeps the address.
    tracing::info!(target: "squire_server::startup", "Squire UI: {}", ui_url(state.config.web_port));
    announce(
        state.config.web_port,
        open_browser,
        &state.config.allowed_hosts,
    );
    let local_shutdown = shutdown_rx.clone();
    // Work stops as soon as shutdown is requested, so requests waiting on it
    // end rather than holding the listeners open while they drain.
    let stop_work = async {
        wait_for_shutdown(shutdown_rx).await;
        state.marketplace_operations.shutdown().await;
        let jobs = state.jobs.clone();
        let _ = tokio::task::spawn_blocking(move || jobs.shutdown()).await;
        state.browser.shutdown().await;
        state.wasm.processes().shutdown();
        Ok::<_, std::io::Error>(())
    };
    tokio::try_join!(
        axum::serve(local_listener, local)
            .with_graceful_shutdown(wait_for_shutdown(local_shutdown)),
        stop_work,
    )?;
    state
        .store
        .maintain(
            state
                .config
                .settings
                .limits
                .connection_payload_retention_days
                .get(),
        )
        .await?;
    Ok(())
}

async fn wait_for_shutdown(mut shutdown_rx: watch::Receiver<bool>) {
    while !*shutdown_rx.borrow() && shutdown_rx.changed().await.is_ok() {}
}

/// The passwordless admin UI. It is same-origin, so it gets no CORS layer.
fn local_router(state: AppState) -> Router {
    Router::new()
        .nest(desktop::ROUTE_PREFIX, desktop::router(state.clone()))
        .route("/attachments/:hash", get(attachments::local_attachment))
        .fallback(frontend_fallback)
        .with_state(state)
}

async fn frontend_fallback(request: Request) -> Response {
    if request.method() != Method::GET {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not_found" }))).into_response();
    }
    let path = request.uri().path();
    // Nested routers only match their prefix. Guard here so an unknown API
    // path never serves `index.html`.
    if path.starts_with("/desktop") || path.starts_with("/attachments") {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not_found" }))).into_response();
    }
    // Asset names may contain spaces (`Pink Sunset.webp`); the request carries them
    // percent-encoded, and the embedded files are keyed by the plain name.
    let Ok(decoded) = urlencoding::decode(path) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not_found" }))).into_response();
    };
    let key = decoded.trim_start_matches('/');
    if key.split(['/', '\\']).any(|segment| segment == "..") {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not_found" }))).into_response();
    }
    let key = if key.is_empty() { "index.html" } else { key };

    // Hashed/bundled assets and favicon must 404 when missing (no SPA fallback),
    // matching the old ServeDir/ServeFile behaviour.
    let spa_fallback = !(key.starts_with("assets/") || key == "favicon.svg");

    if let Some(response) = frontend_asset(key).await {
        return response;
    }
    if spa_fallback {
        if let Some(response) = frontend_asset("index.html").await {
            return response;
        }
    }
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "frontend_missing" })),
    )
        .into_response()
}

async fn frontend_asset(key: &str) -> Option<Response> {
    // rust-embed reads from disk in debug builds, so no override dir is needed.
    FrontendAssets::get(key).map(|file| {
        let body = match file.data {
            Cow::Borrowed(bytes) => Body::from(bytes),
            Cow::Owned(bytes) => Body::from(bytes),
        };
        asset_response(key, body)
    })
}

fn asset_response(key: &str, body: Body) -> Response {
    let mime = mime_guess::from_path(key).first_or_octet_stream();
    let cache = if key.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, mime.as_ref().to_string()),
            (header::CACHE_CONTROL, cache.to_string()),
            (
                header::CONTENT_SECURITY_POLICY,
                "frame-ancestors 'none'".to_string(),
            ),
            (header::X_FRAME_OPTIONS, "DENY".to_string()),
        ],
        body,
    )
        .into_response()
}
