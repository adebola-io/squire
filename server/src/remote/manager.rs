//! Outbound hosted-MCP device connection.
//!
//! The hosted Worker owns the public MCP endpoint. This module keeps one
//! authenticated WebSocket to the Worker while Remote Access is enabled and
//! executes the tool operations it receives through Squire's normal tool path.

use crate::{
    account::{AccountManager, Revoked},
    remote::{
        catalog,
        protocol::{self, Incoming, NativeError, Outgoing},
    },
    state::AppState,
    store::Store,
    tools,
};
use anyhow::{bail, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, LazyLock, OnceLock},
    time::Duration,
};
use tokio::{
    sync::{broadcast, mpsc, Mutex, OnceCell},
    time::Instant,
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        client::IntoClientRequest, protocol::WebSocketConfig, Error as WsError, Message,
    },
};
use tokio_util::sync::CancellationToken;

const UUID_KEY: &str = "installation_uuid";
const CONNECT_PATH: &str = "/api/remote/connect";
const DEVICES_PATH: &str = "/api/remote/devices";
const MIN_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// Connection events kept for the Diagnostics panel.
const MAX_EVENTS: usize = 50;

pub(crate) static REMOTE_EVENT: LazyLock<Arc<str>> =
    LazyLock::new(|| Arc::from(r#"{"type":"remote"}"#));

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Disabled,
    Connecting,
    Connected,
    Reconnecting,
    SignedOut,
    Revoked,
    Incompatible,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: State,
    pub enabled: bool,
    pub account_connected: bool,
    pub device_name: String,
    /// The operating system as people name it, such as "macOS 26.0".
    pub os: String,
    pub mcp_url: String,
    pub protocol_version: u32,
    /// Connection attempts since the last success; 0 while connected.
    pub attempt: u32,
    /// Unix milliseconds when the current socket opened, while connected.
    pub connected_since: Option<i64>,
    /// Unix milliseconds of the last lease this side sent.
    pub last_lease_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub error_at: Option<i64>,
    /// Newest first.
    pub events: Vec<Event>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Tone {
    Info,
    Success,
    Error,
}

/// One line in the Diagnostics panel's event list.
#[derive(Debug, Clone, Serialize)]
pub struct Event {
    pub at: i64,
    pub tone: Tone,
    pub text: String,
}

/// An app with a grant to reach this computer, from the hosted service.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteApp {
    pub name: String,
    pub granted_at: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteApps {
    /// Unix milliseconds when this computer was first registered.
    pub registered_at: Option<i64>,
    pub apps: Vec<RemoteApp>,
}

struct Inner {
    state: State,
    account_id: Option<String>,
    error: Option<String>,
    error_at: Option<i64>,
    supervisor: Option<CancellationToken>,
    attempt: u32,
    /// Whether the current supervisor has had a socket open; losing one is
    /// "reconnecting", never having had one is still "connecting".
    ever_connected: bool,
    connected_since: Option<i64>,
    last_lease_at: Option<i64>,
    events: VecDeque<Event>,
}

impl Inner {
    fn push_event(&mut self, tone: Tone, text: impl Into<String>) {
        if self.events.len() >= MAX_EVENTS {
            self.events.pop_front();
        }
        self.events.push_back(Event {
            at: now_ms(),
            tone,
            text: text.into(),
        });
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// "macOS 26.0", "Windows 11 (26100)", "Linux 6.8" — what the account page
/// and the Connections header show for this computer.
fn os_label() -> String {
    let name = match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    };
    match sysinfo::System::os_version() {
        Some(version) if !version.trim().is_empty() => format!("{name} {}", version.trim()),
        _ => name.to_string(),
    }
}

struct InstallationRow {
    account_id: Option<String>,
    enabled: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Disposition {
    Retry,
    Stop,
}

struct Call {
    id: String,
    name: String,
    arguments: Value,
    client: String,
}

/// Owns the device identity and its reconnecting hosted connection.
pub struct Manager {
    store: Arc<Store>,
    account: Arc<AccountManager>,
    events: broadcast::Sender<Arc<str>>,
    uuid: OnceLock<String>,
    name: OnceLock<String>,
    identity: OnceCell<super::device_identity::DeviceIdentity>,
    os: LazyLock<String>,
    inner: Mutex<Inner>,
}

impl Manager {
    pub fn new(
        store: Arc<Store>,
        account: Arc<AccountManager>,
        events: broadcast::Sender<Arc<str>>,
    ) -> Result<Self> {
        Ok(Self {
            store,
            account,
            events,
            uuid: OnceLock::new(),
            name: OnceLock::new(),
            identity: OnceCell::new(),
            os: LazyLock::new(os_label),
            inner: Mutex::new(Inner {
                state: State::Disabled,
                account_id: None,
                error: None,
                error_at: None,
                supervisor: None,
                attempt: 0,
                ever_connected: false,
                connected_since: None,
                last_lease_at: None,
                events: VecDeque::new(),
            }),
        })
    }

    /// Starts the connection supervisor and reacts to account changes. The
    /// application state is attached once so tool dispatch can use the same
    /// execution path as local clients.
    pub fn attach(self: &Arc<Self>, state: AppState) {
        let manager = self.clone();
        tokio::spawn(async move {
            let mut events = manager.events.subscribe();
            manager.refresh(state.clone()).await;
            loop {
                match events.recv().await {
                    Ok(event) if event.as_ref() == crate::account::ACCOUNT_EVENT.as_ref() => {
                        manager.refresh(state.clone()).await;
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        manager.refresh(state.clone()).await;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    /// Probe hardware only for enabled Remote Access, once per process.
    /// The first hello shares this task if the result is still pending.
    fn warm_device_identity(self: &Arc<Self>) {
        if self.identity.get().is_some() {
            return;
        }
        let manager = self.clone();
        tokio::spawn(async move {
            manager
                .identity
                .get_or_init(super::device_identity::detect)
                .await;
        });
    }

    pub async fn status(&self) -> Result<Status> {
        let row = self.installation()?;
        let account_connected = row
            .as_ref()
            .and_then(|row| row.account_id.as_ref())
            .is_some();
        let inner = self.inner.lock().await;
        let enabled = row.as_ref().is_some_and(|row| row.enabled);
        let state = if !account_connected {
            State::SignedOut
        } else if !enabled {
            State::Disabled
        } else {
            inner.state
        };
        Ok(Status {
            state,
            enabled,
            account_connected,
            device_name: self.device_name().await,
            os: (*self.os).clone(),
            mcp_url: self
                .account
                .endpoint("/mcp")
                .map(|url| url.to_string())
                .unwrap_or_default(),
            protocol_version: protocol::PROTOCOL_VERSION,
            attempt: inner.attempt,
            connected_since: inner.connected_since,
            last_lease_at: inner.last_lease_at,
            error: inner.error.clone(),
            error_at: inner.error_at,
            events: inner.events.iter().rev().cloned().collect(),
        })
    }

    /// The apps with a grant to reach this computer, and when it was
    /// registered. Empty when signed out or never registered.
    pub async fn apps(&self) -> Result<RemoteApps> {
        let signed_in = self
            .installation()?
            .is_some_and(|row| row.account_id.is_some());
        if !signed_in {
            return Ok(RemoteApps::default());
        }
        let uuid = self.installation_uuid()?;
        let response = self
            .account
            .post_hosted_json(
                &format!("{DEVICES_PATH}/apps"),
                &json!({ "installationUuid": uuid }),
            )
            .await?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            bail!("{}", hosted_error(&body, status.as_u16()));
        }
        Ok(serde_json::from_str(&body)?)
    }

    /// Enables or disables hosted access. Enabling registers this installation
    /// with the hosted service before opening a socket; failures stay visible
    /// and retry in the background instead of silently turning the feature off.
    pub async fn set_enabled(self: &Arc<Self>, state: &AppState, enabled: bool) -> Result<Status> {
        let Some(row) = self.installation()? else {
            bail!("Connect a Squire account before enabling Remote Access");
        };
        let Some(account_id) = row.account_id.clone() else {
            bail!("Connect a Squire account before enabling Remote Access");
        };
        self.set_remote_enabled(enabled).await?;
        if enabled {
            self.warm_device_identity();
            {
                let mut inner = self.inner.lock().await;
                inner.error = None;
            }
            if let Err(error) = self.register_device().await {
                self.record_error(&format!("{error:#}")).await;
            }
            self.start_supervisor(state.clone(), account_id).await;
        } else {
            self.stop_supervisor(State::Disabled, None).await;
            if let Err(error) = self.disable_remote_device().await {
                tracing::warn!("Could not disable hosted device: {error:#}");
            }
        }
        self.status().await
    }

    async fn refresh(self: &Arc<Self>, state: AppState) {
        let row = match self.installation() {
            Ok(row) => row,
            Err(error) => {
                tracing::warn!("Could not read Remote Access state: {error:#}");
                return;
            }
        };
        let Some(row) = row else {
            self.settle(State::SignedOut).await;
            return;
        };
        let Some(account_id) = row.account_id else {
            self.settle(State::SignedOut).await;
            return;
        };
        if !row.enabled {
            self.settle(State::Disabled).await;
            return;
        }
        self.warm_device_identity();
        self.start_supervisor(state.clone(), account_id).await;
    }

    /// The stopped counterpart of `start_supervisor`'s same-account no-op.
    /// Account events arrive in bursts; once stopped in `state`, another one
    /// must not clear the reason the connection stopped (for example, that
    /// this computer was removed from Remote Access) or emit again.
    async fn settle(&self, state: State) {
        {
            let inner = self.inner.lock().await;
            if inner.supervisor.is_none() && inner.state == state {
                return;
            }
        }
        self.stop_supervisor(state, None).await;
    }

    /// Restarting for the same account is a no-op. ACCOUNT_EVENT also fires for
    /// approval progress and is easy to trigger in bursts; a reconnect here
    /// would abort in-flight remote calls for no reason.
    async fn start_supervisor(self: &Arc<Self>, state: AppState, account_id: String) {
        let cancel = CancellationToken::new();
        {
            let mut inner = self.inner.lock().await;
            if inner.supervisor.is_some() && inner.account_id.as_deref() == Some(&account_id) {
                return;
            }
            if let Some(old) = inner.supervisor.take() {
                old.cancel();
            }
            inner.state = State::Connecting;
            inner.account_id = Some(account_id);
            inner.error = None;
            inner.error_at = None;
            inner.attempt = 0;
            inner.ever_connected = false;
            inner.connected_since = None;
            inner.supervisor = Some(cancel.clone());
            inner.push_event(Tone::Info, "Connecting");
        }
        self.emit();
        let manager = self.clone();
        tokio::spawn(async move {
            manager.supervise(state, cancel).await;
        });
    }

    async fn stop_supervisor(&self, state: State, error: Option<String>) {
        {
            let mut inner = self.inner.lock().await;
            if let Some(cancel) = inner.supervisor.take() {
                cancel.cancel();
            }
            let changed = inner.state != state;
            inner.state = state;
            inner.account_id = None;
            inner.attempt = 0;
            inner.connected_since = None;
            inner.error_at = error.as_ref().map(|_| now_ms());
            match &error {
                Some(message) => inner.push_event(Tone::Error, message.clone()),
                None if changed => inner.push_event(Tone::Info, stopped_label(state)),
                None => {}
            }
            inner.error = error;
        }
        self.emit();
    }

    async fn supervise(self: Arc<Self>, state: AppState, cancel: CancellationToken) {
        let mut backoff = MIN_BACKOFF;
        loop {
            if cancel.is_cancelled() {
                return;
            }
            {
                let mut inner = self.inner.lock().await;
                inner.attempt += 1;
                inner.state = if inner.ever_connected {
                    State::Reconnecting
                } else {
                    State::Connecting
                };
            }
            self.emit();
            match self.connect_once(&state, &cancel).await {
                Ok(()) if !cancel.is_cancelled() => {
                    backoff = MIN_BACKOFF;
                    {
                        let mut inner = self.inner.lock().await;
                        inner.push_event(Tone::Info, "Connection closed by the hosted service");
                    }
                    self.set_state(State::Reconnecting).await;
                    self.emit();
                }
                Ok(()) => return,
                Err(ConnectionError {
                    disposition,
                    state,
                    message,
                    disable_remote,
                }) => {
                    if disable_remote {
                        let _ = self.set_remote_enabled(false).await;
                    }
                    if disposition == Disposition::Stop {
                        self.stop_supervisor(state, Some(message)).await;
                        return;
                    }
                    {
                        let mut inner = self.inner.lock().await;
                        inner.state = if inner.ever_connected {
                            State::Reconnecting
                        } else {
                            State::Connecting
                        };
                    }
                    self.record_error(&message).await;
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                }
            }
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = tokio::time::sleep(backoff) => {}
            }
        }
    }

    async fn connect_once(
        self: &Arc<Self>,
        state: &AppState,
        cancel: &CancellationToken,
    ) -> Result<(), ConnectionError> {
        let token = match self.account.access_token().await {
            Ok(token) => token,
            Err(error) => {
                let revoked = error.downcast_ref::<Revoked>().is_some();
                return Err(ConnectionError {
                    disposition: Disposition::Stop,
                    state: if revoked {
                        State::Revoked
                    } else {
                        State::SignedOut
                    },
                    message: format!("{error:#}"),
                    disable_remote: false,
                });
            }
        };
        let uuid = self
            .installation_uuid()
            .map_err(|error| ConnectionError::retry(State::Connecting, format!("{error:#}")))?;
        let mut url = self
            .account
            .endpoint(CONNECT_PATH)
            .map_err(|error| ConnectionError::retry(State::Connecting, format!("{error:#}")))?;
        if url.scheme() == "https" {
            url.set_scheme("wss").ok();
        } else {
            url.set_scheme("ws").ok();
        }
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|error| ConnectionError::retry(State::Connecting, format!("{error:#}")))?;
        let headers = request.headers_mut();
        headers.insert(
            "Authorization",
            format!("Bearer {token}")
                .parse()
                .map_err(|_| ConnectionError::retry(State::Connecting, "Invalid authorization"))?,
        );
        headers.insert(
            "X-Squire-Installation",
            uuid.parse().map_err(|_| {
                ConnectionError::retry(State::Connecting, "Invalid installation id")
            })?,
        );
        headers.insert("X-Squire-Protocol", protocol::PROTOCOL_VERSION.into());
        let config = WebSocketConfig::default()
            .read_buffer_size(16 * 1024)
            .write_buffer_size(16 * 1024)
            .max_message_size(Some(protocol::MAX_SOCKET_MESSAGE_BYTES))
            .max_frame_size(Some(protocol::MAX_SOCKET_MESSAGE_BYTES));
        let connected = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            result = connect_async_with_config(request, Some(config), false) => result,
        };
        let (socket, _) = match connected {
            Ok(connected) => connected,
            Err(error) => {
                let failure = self.connect_error(error);
                if failure.state == State::Revoked {
                    if let Err(error) = self.account.session_refused().await {
                        tracing::warn!("Could not record the refused session: {error:#}");
                    }
                }
                return Err(failure);
            }
        };
        {
            let mut inner = self.inner.lock().await;
            inner.state = State::Connected;
            inner.error = None;
            inner.error_at = None;
            inner.attempt = 0;
            inner.ever_connected = true;
            inner.connected_since = Some(now_ms());
            inner.push_event(Tone::Success, "Connected");
        }
        self.emit();
        self.pump(state, socket, cancel).await
    }

    async fn pump(
        self: &Arc<Self>,
        state: &AppState,
        socket: tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        cancel: &CancellationToken,
    ) -> Result<(), ConnectionError> {
        let (mut sink, mut stream) = socket.split();
        // The Worker serves tools/list from the catalog each connection reports.
        let identity = self
            .identity
            .get_or_init(super::device_identity::detect)
            .await
            .clone();
        let hello = serde_json::to_string(&Outgoing::Hello {
            tools: catalog::tools(),
            device: Some(identity),
        })
        .map_err(|error| ConnectionError::retry(State::Reconnecting, format!("{error}")))?;
        if let Err(error) = sink.send(Message::Text(hello.into())).await {
            return Err(ConnectionError::retry(
                State::Reconnecting,
                format!("Hosted connection failed: {error}"),
            ));
        }
        let (outgoing, mut messages) = mpsc::channel::<Outgoing>(64);
        let active: Arc<Mutex<HashMap<String, CancellationToken>>> = Arc::default();
        let mut lease = tokio::time::interval(protocol::LEASE_INTERVAL);
        lease.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // The Worker answers every lease. Writes into a half-open connection
        // keep succeeding into the TCP buffer, so silence is the only signal
        // that the hosted side is gone.
        let mut last_heard = Instant::now();
        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    self.cancel_active(&active).await;
                    let _ = sink.close().await;
                    return Ok(());
                }
                _ = lease.tick() => {
                    if last_heard.elapsed() >= protocol::LEASE_TIMEOUT {
                        self.cancel_active(&active).await;
                        return Err(ConnectionError::retry(
                            State::Reconnecting,
                            "The hosted connection stopped responding",
                        ));
                    }
                    if outgoing.send(Outgoing::Lease).await.is_err() {
                        break;
                    }
                    self.inner.lock().await.last_lease_at = Some(now_ms());
                }
                Some(message) = messages.recv() => {
                    let Ok(text) = serde_json::to_string(&message) else {
                        continue;
                    };
                    if sink.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                incoming = stream.next() => {
                    if matches!(incoming, Some(Ok(_))) {
                        last_heard = Instant::now();
                    }
                    match incoming {
                        Some(Ok(Message::Text(text))) => {
                            self.handle_message(state, &text, &outgoing, &active).await;
                        }
                        Some(Ok(Message::Ping(payload))) => {
                            let _ = sink.send(Message::Pong(payload)).await;
                        }
                        Some(Ok(Message::Close(_))) | None => break,
                        Some(Ok(_)) => {}
                        Some(Err(error)) => {
                            self.cancel_active(&active).await;
                            return Err(ConnectionError::retry(
                                State::Reconnecting,
                                format!("Hosted connection failed: {error}"),
                            ));
                        }
                    }
                }
            }
        }
        self.cancel_active(&active).await;
        Ok(())
    }

    async fn handle_message(
        self: &Arc<Self>,
        state: &AppState,
        text: &str,
        outgoing: &mpsc::Sender<Outgoing>,
        active: &Arc<Mutex<HashMap<String, CancellationToken>>>,
    ) {
        let message: Incoming = match serde_json::from_str(text) {
            Ok(message) => message,
            Err(_) => return,
        };
        match message {
            Incoming::Request {
                id,
                op,
                name,
                arguments,
                client,
            } => {
                if op != "tools.call" {
                    send_error(outgoing, &id, "unsupported", "Unsupported remote operation").await;
                    return;
                }
                if tools::definition(&name).is_none() {
                    send_error(
                        outgoing,
                        &id,
                        "unknown_tool",
                        format!("Unknown tool: {name}"),
                    )
                    .await;
                    return;
                }
                if active.lock().await.len() >= protocol::MAX_CONCURRENT_REQUESTS {
                    send_error(
                        outgoing,
                        &id,
                        "busy",
                        "Squire is handling too many remote calls",
                    )
                    .await;
                    return;
                }
                let cancellation = CancellationToken::new();
                active.lock().await.insert(id.clone(), cancellation.clone());
                let manager = self.clone();
                let app = state.clone();
                let outgoing = outgoing.clone();
                let active = active.clone();
                let call = Call {
                    id: id.clone(),
                    name,
                    arguments,
                    client: client.unwrap_or_else(|| "MCP client".into()),
                };
                tokio::spawn(async move {
                    manager.execute(app, call, cancellation, outgoing).await;
                    active.lock().await.remove(&id);
                });
            }
            Incoming::Cancel { id } => {
                if let Some(cancellation) = active.lock().await.get(&id) {
                    cancellation.cancel();
                }
            }
            Incoming::Other => {}
        }
    }

    async fn execute(
        self: Arc<Self>,
        app: AppState,
        call: Call,
        cancellation: CancellationToken,
        outgoing: mpsc::Sender<Outgoing>,
    ) {
        let Call {
            id,
            name,
            arguments,
            client,
        } = call;
        self.inner
            .lock()
            .await
            .push_event(Tone::Info, format!("tools.call {name} · {client}"));
        let run = tools::run_with_source_and_client_cancellable(
            &app,
            &name,
            arguments,
            "mcp",
            &client,
            cancellation.clone(),
        )
        .await;
        if cancellation.is_cancelled() {
            send_error(
                &outgoing,
                &id,
                "cancelled",
                "The MCP client cancelled this call",
            )
            .await;
            return;
        }
        let run = match run {
            Ok(run) => run,
            Err(error) => {
                self.inner
                    .lock()
                    .await
                    .push_event(Tone::Error, format!("tools.call {name} failed · {error:#}"));
                send_error(&outgoing, &id, "tool_error", format!("{error:#}")).await;
                return;
            }
        };
        let mut data = run.result;
        let attachments = data
            .get("attachments")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if attachments.len() != run.attachments.len() {
            send_error(
                &outgoing,
                &id,
                "invalid_result",
                "Tool returned a mismatched attachment list",
            )
            .await;
            return;
        }
        for (index, attachment) in run.attachments.iter().enumerate() {
            for (seq, chunk) in attachment.data.chunks(protocol::CHUNK_BYTES).enumerate() {
                let message = Outgoing::AttachmentChunk {
                    id: id.clone(),
                    index,
                    seq,
                    is_final: (seq + 1) * protocol::CHUNK_BYTES >= attachment.data.len(),
                    data: BASE64.encode(chunk),
                };
                if outgoing.send(message).await.is_err() {
                    return;
                }
            }
            if attachment.data.is_empty() {
                let message = Outgoing::AttachmentChunk {
                    id: id.clone(),
                    index,
                    seq: 0,
                    is_final: true,
                    data: String::new(),
                };
                if outgoing.send(message).await.is_err() {
                    return;
                }
            }
        }
        if !attachments.is_empty() {
            data["attachments"] = Value::Array(
                attachments
                    .iter()
                    .enumerate()
                    .map(|(index, attachment)| {
                        let data = &run.attachments[index].data;
                        json!({
                            "name": attachment
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("attachment"),
                            "mimeType": run.attachments[index].mime,
                            "bytes": data.len(),
                        })
                    })
                    .collect(),
            );
        }
        let _ = outgoing
            .send(Outgoing::Result {
                id,
                ok: true,
                data: Some(data),
                error: None,
            })
            .await;
    }

    async fn cancel_active(&self, active: &Arc<Mutex<HashMap<String, CancellationToken>>>) {
        let tokens = active
            .lock()
            .await
            .drain()
            .map(|(_, token)| token)
            .collect::<Vec<_>>();
        for token in tokens {
            token.cancel();
        }
    }

    async fn set_state(&self, state: State) {
        let mut inner = self.inner.lock().await;
        inner.state = state;
        if state != State::Connected {
            inner.connected_since = None;
        }
    }

    /// Keeps the failure visible without changing the connection state; the
    /// supervisor decides whether that is still "connecting" or "reconnecting".
    async fn record_error(&self, message: &str) {
        let mut inner = self.inner.lock().await;
        inner.connected_since = None;
        inner.error = Some(message.to_owned());
        inner.error_at = Some(now_ms());
        inner.push_event(Tone::Error, message);
        drop(inner);
        self.emit();
    }

    fn connect_error(&self, error: WsError) -> ConnectionError {
        match error {
            WsError::Http(response) => {
                let status = response.status();
                let body = response
                    .body()
                    .as_ref()
                    .and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok())
                    .and_then(|value| {
                        value
                            .get("message")
                            .or_else(|| value.get("error"))
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .unwrap_or_else(|| format!("Hosted service returned HTTP {status}"));
                let state = match status.as_u16() {
                    401 | 403 => State::Revoked,
                    404 => State::Disabled,
                    409 => State::Incompatible,
                    _ => State::Reconnecting,
                };
                ConnectionError {
                    disposition: if status.is_client_error() {
                        Disposition::Stop
                    } else {
                        Disposition::Retry
                    },
                    state,
                    message: if status.as_u16() == 404 {
                        "This computer was removed from Remote Access. Turn it on again to reconnect."
                            .to_string()
                    } else {
                        body
                    },
                    disable_remote: status.as_u16() == 404,
                }
            }
            other => ConnectionError::retry(State::Reconnecting, format!("{other}")),
        }
    }

    async fn register_device(&self) -> Result<()> {
        let uuid = self.installation_uuid()?;
        let name = self.device_name().await;
        let response = self
            .account
            .post_hosted_json(
                DEVICES_PATH,
                &json!({
                    "installationUuid": uuid,
                    "name": name,
                    "os": std::env::consts::OS,
                }),
            )
            .await?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            bail!("{}", hosted_error(&body, status.as_u16()));
        }
        Ok(())
    }

    async fn disable_remote_device(&self) -> Result<()> {
        let uuid = self.installation_uuid()?;
        let response = self
            .account
            .post_hosted_json(
                &format!("{DEVICES_PATH}/disable"),
                &json!({ "installationUuid": uuid }),
            )
            .await?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            bail!("{}", hosted_error(&body, status.as_u16()));
        }
        Ok(())
    }

    fn installation(&self) -> Result<Option<InstallationRow>> {
        self.store.read_blocking(|db| {
            use rusqlite::OptionalExtension;
            let row = db
                .query_row(
                    "SELECT account_id, remote_enabled FROM installation WHERE id = 1",
                    [],
                    |row| {
                        Ok(InstallationRow {
                            account_id: row.get(0)?,
                            enabled: row.get::<_, i64>(1)? != 0,
                        })
                    },
                )
                .optional()?;
            Ok(row)
        })
    }

    async fn set_remote_enabled(&self, enabled: bool) -> Result<()> {
        self.store
            .write(move |tx| {
                tx.execute(
                    "UPDATE installation SET remote_enabled = ?1 WHERE id = 1",
                    [i64::from(enabled)],
                )?;
                Ok(())
            })
            .await
    }

    fn installation_uuid(&self) -> Result<String> {
        if let Some(uuid) = self.uuid.get() {
            return Ok(uuid.clone());
        }
        let existing = self.store.write_blocking(|tx| {
            use rusqlite::OptionalExtension;
            let existing: Option<String> = tx
                .query_row("SELECT value FROM meta WHERE key = ?1", [UUID_KEY], |row| {
                    row.get(0)
                })
                .optional()?;
            if let Some(existing) = existing {
                return Ok(existing);
            }
            let uuid = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO meta(key, value) VALUES (?1, ?2)",
                rusqlite::params![UUID_KEY, &uuid],
            )?;
            Ok(uuid)
        })?;
        let _ = self.uuid.set(existing.clone());
        Ok(existing)
    }

    async fn device_name(&self) -> String {
        if let Some(name) = self.name.get() {
            return name.clone();
        }
        let name = crate::account::device_name().await;
        let _ = self.name.set(name.clone());
        name
    }

    fn emit(&self) {
        if self.events.receiver_count() > 0 {
            let _ = self.events.send(REMOTE_EVENT.clone());
        }
    }
}

struct ConnectionError {
    disposition: Disposition,
    state: State,
    message: String,
    disable_remote: bool,
}

impl ConnectionError {
    fn retry(state: State, message: impl Into<String>) -> Self {
        Self {
            disposition: Disposition::Retry,
            state,
            message: message.into(),
            disable_remote: false,
        }
    }
}

async fn send_error(
    outgoing: &mpsc::Sender<Outgoing>,
    id: &str,
    code: &str,
    message: impl Into<String>,
) {
    let _ = outgoing
        .send(Outgoing::Result {
            id: id.to_owned(),
            ok: false,
            data: None,
            error: Some(NativeError::new(code, message)),
        })
        .await;
}

fn stopped_label(state: State) -> &'static str {
    match state {
        State::Disabled => "Remote Access turned off",
        State::SignedOut => "Signed out",
        State::Revoked => "Session ended",
        State::Incompatible => "Update needed",
        State::Connecting | State::Connected | State::Reconnecting => "Stopped",
    }
}

fn hosted_error(body: &str, status: u16) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .or_else(|| value.get("error"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| format!("Hosted service returned HTTP {status}"))
}
