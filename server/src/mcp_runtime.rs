use crate::plugins::{McpConfig, McpConfigValue};
use anyhow::{Context, Result};
use reqwest::header::{HeaderName, HeaderValue};
use rmcp::{
    model::{
        CallToolRequest, CallToolRequestParams, CallToolResult, CancelledNotificationParam,
        ClientRequest, Implementation, ProtocolVersion, ServerResult, Tool,
    },
    service::{ClientInitializeError, PeerRequestOptions, RoleClient, RunningService},
    transport::{
        auth::{
            AuthClient, AuthError, CredentialStore, OAuthState, OAuthTokenResponse,
            StoredCredentials,
        },
        streamable_http_client::{AuthRequiredError, StreamableHttpClientTransportConfig},
        StreamableHttpClientTransport, TokioChildProcess,
    },
    ClientLifecycleMode, ClientServiceExt,
};
use serde_json::{Map, Value};
use std::{
    collections::HashMap,
    ffi::{OsStr, OsString},
    future::Future,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{io::AsyncBufReadExt, process::Command};
use tokio_util::sync::CancellationToken;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const STDIO_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(120);
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(30);
const OAUTH_HTTP_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a connection may sit unused before its server is shut down.
const IDLE_TIMEOUT: Duration = Duration::from_secs(600);
const IDLE_SWEEP_INTERVAL: Duration = Duration::from_secs(60);
/// OAuth credentials are stored as declared Plugin secrets so they appear in
/// the secrets UI and are removed with the rest of the Plugin's secrets.
pub const MCP_OAUTH_CLIENT_ID_KEY: &str = "MCP_OAUTH_CLIENT_ID";
pub const MCP_OAUTH_CLIENT_SECRET_KEY: &str = "MCP_OAUTH_CLIENT_SECRET";
pub const MCP_OAUTH_SCOPES_KEY: &str = "MCP_OAUTH_SCOPES";
pub const MCP_OAUTH_PREREGISTERED_KEY: &str = "MCP_OAUTH_PREREGISTERED";
pub const MCP_OAUTH_REDIRECT_URI_KEY: &str = "MCP_OAUTH_REDIRECT_URI";
pub const MCP_OAUTH_TOKEN_KEY: &str = "MCP_OAUTH_TOKEN";

/// Where an installed Plugin's OAuth credentials are persisted when the SDK
/// refreshes or discards them.
pub trait CredentialSink: Send + Sync {
    fn save(&self, client_id: &str, token: &OAuthTokenResponse) -> Result<()>;
    fn clear(&self) -> Result<()>;
}

/// Reserved environment variable naming an installed MCP Plugin's private
/// data directory (`squire_home/plugin-data/<id>`). Set for installed stdio
/// servers only, after the manifest `env` map, so a manifest cannot spoof it.
pub const MCP_PLUGIN_DATA_DIR_ENV: &str = "SQUIRE_PLUGIN_DATA_DIR";

/// The inputs every runtime operation needs.
pub struct McpConnectionParams {
    pub key: String,
    pub plugin_dir: PathBuf,
    /// The installed Plugin's private data directory. `None` for servers
    /// that are not installed (discovery) and for HTTP servers.
    pub data_dir: Option<PathBuf>,
    pub config: McpConfig,
    pub secrets: HashMap<String, String>,
    /// The Squire home whose embedded Node.js runs this server's `npx`. Set
    /// only for curated marketplace listings; `None` starts the command exactly
    /// as the person typed or approved it.
    pub embedded_npx_home: Option<PathBuf>,
    /// Persists refreshed OAuth credentials. Candidates only need credentials
    /// for the duration of their flow, so they pass `None`.
    pub sink: Option<Arc<dyn CredentialSink>>,
}

/// The MCP runtime's typed failure: callers can tell a user-initiated cancel or
/// per-call timeout (which leaves the connection usable) from a transport
/// failure.
#[derive(Debug)]
pub enum McpCallError {
    Cancelled,
    TimedOut,
    Failed(anyhow::Error),
}

/// Whether an initialization failure means the server requires OAuth.
///
/// rmcp's `ClientInitializeError::TransportError` carries the transport failure
/// without a `source()` link, so `error.chain()` cannot see through it. Ask
/// rmcp itself, which walks the inner transport chain manually.
pub fn is_authorization_required(error: &anyhow::Error) -> bool {
    if error.chain().any(|cause| {
        cause
            .downcast_ref::<ClientInitializeError>()
            .is_some_and(|init| init.is_authorization_required())
    }) {
        return true;
    }
    error.chain().any(|cause| {
        cause.downcast_ref::<AuthRequiredError>().is_some()
            || matches!(
                cause.downcast_ref::<AuthError>(),
                Some(AuthError::AuthorizationRequired)
            )
    })
}

pub fn oauth_http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(OAUTH_HTTP_TIMEOUT)
        .build()
        .context("failed to build MCP OAuth HTTP client")
}

/// Live MCP connections, one per installed Plugin.
#[derive(Default)]
pub struct McpRuntime {
    slots: Mutex<HashMap<String, Arc<Slot>>>,
}

/// One Plugin's connection. `connecting` serializes connection attempts so
/// concurrent first calls share a single server process.
#[derive(Default)]
struct Slot {
    connecting: tokio::sync::Mutex<()>,
    connection: Mutex<Option<Arc<McpConnection>>>,
}

impl Slot {
    /// The open connection, marked as used.
    fn live(&self) -> Option<Arc<McpConnection>> {
        let connection = self.connection.lock().unwrap().clone()?;
        if connection.service.is_closed() {
            return None;
        }
        *connection.last_used.lock().unwrap() = Instant::now();
        Some(connection)
    }
}

struct McpConnection {
    service: RunningService<RoleClient, ()>,
    metadata: McpMetadata,
    last_used: Mutex<Instant>,
}

#[derive(Clone, Debug, Default)]
pub struct McpMetadata {
    pub protocol_version: Option<String>,
    pub server_info: Option<Implementation>,
}

#[derive(Clone, Debug)]
pub struct McpDiscovery {
    pub metadata: McpMetadata,
    pub tools: Vec<Tool>,
}

impl McpRuntime {
    /// Connects, lists tools and disconnects, for servers that are not
    /// installed yet.
    pub async fn discover_once(
        plugin_dir: &Path,
        config: &McpConfig,
        secrets: &HashMap<String, String>,
        embedded_npx_home: Option<&Path>,
    ) -> Result<McpDiscovery> {
        let connection = connect(&McpConnectionParams {
            key: "discovery".to_string(),
            plugin_dir: plugin_dir.to_path_buf(),
            data_dir: None,
            config: config.clone(),
            secrets: secrets.clone(),
            embedded_npx_home: embedded_npx_home.map(Path::to_path_buf),
            sink: None,
        })
        .await?;
        let tools = list_tools(&connection).await?;
        Ok(McpDiscovery {
            metadata: connection.metadata,
            tools,
        })
    }

    /// Publishes the discovered catalog before making the connection callable.
    /// Concurrent first calls share this entire operation, not just the handshake.
    pub async fn discover<F, Fut>(&self, params: &McpConnectionParams, publish: F) -> Result<()>
    where
        F: FnOnce(McpDiscovery) -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        let slot = self
            .slots
            .lock()
            .unwrap()
            .entry(params.key.clone())
            .or_default()
            .clone();
        let _connecting = slot.connecting.lock().await;
        if slot.live().is_some() {
            return Ok(());
        }
        let connection = Arc::new(connect(params).await?);
        let tools = list_tools(&connection).await?;
        publish(McpDiscovery {
            metadata: connection.metadata.clone(),
            tools,
        })
        .await?;
        let slots = self.slots.lock().unwrap();
        if !slots
            .get(&params.key)
            .is_some_and(|current| Arc::ptr_eq(current, &slot))
        {
            anyhow::bail!("MCP connection changed during discovery; retry the Action");
        }
        *slot.connection.lock().unwrap() = Some(connection);
        Ok(())
    }

    /// Whether `key` has an open connection. A Plugin without one reconnects on
    /// its next call, which is when its tool list is re-read.
    pub fn is_connected(&self, key: &str) -> bool {
        let slot = self.slots.lock().unwrap().get(key).cloned();
        slot.is_some_and(|slot| slot.live().is_some())
    }

    /// Calls a tool on a discovered connection, bounded by `deadline` and
    /// `cancellation`. Cancellation notification delivery is best effort.
    pub async fn call_tool(
        &self,
        params: &McpConnectionParams,
        name: &str,
        args: Map<String, Value>,
        deadline: Instant,
        cancellation: &CancellationToken,
    ) -> std::result::Result<CallToolResult, McpCallError> {
        let deadline = tokio::time::Instant::from_std(deadline);
        let connection = self
            .slots
            .lock()
            .unwrap()
            .get(&params.key)
            .and_then(|slot| slot.live())
            .ok_or_else(|| {
                McpCallError::Failed(anyhow::anyhow!(
                    "MCP connection is not ready; retry the Action"
                ))
            })?;
        let request = ClientRequest::CallToolRequest(CallToolRequest::new(
            CallToolRequestParams::new(name.to_string()).with_arguments(args),
        ));
        let result = async {
            let handle = tokio::select! {
                _ = cancellation.cancelled() => return Err(McpCallError::Cancelled),
                result = tokio::time::timeout_at(deadline, connection.service
                    .send_cancellable_request(request, PeerRequestOptions::no_options())) => {
                    result.map_err(|_| McpCallError::TimedOut)?
                        .context("failed to send MCP tools/call")
                        .map_err(McpCallError::Failed)?
                }
            };
            let request_id = handle.id.clone();
            let (error, reason) = tokio::select! {
                _ = cancellation.cancelled() => (McpCallError::Cancelled, "Squire Action cancelled"),
                response = tokio::time::timeout_at(deadline, handle.await_response()) => match response {
                    Ok(response) => {
                        return match response
                            .context("MCP tools/call failed")
                            .map_err(McpCallError::Failed)?
                        {
                            ServerResult::CallToolResult(result) => Ok(result),
                            _ => Err(McpCallError::Failed(anyhow::anyhow!(
                                "MCP tools/call returned an unexpected response"
                            ))),
                        };
                    }
                    Err(_) => (McpCallError::TimedOut, "Squire Action timed out"),
                },
            };
            // Notification delivery must not hold the caller past its deadline.
            let peer = connection.service.peer().clone();
            tokio::spawn(async move {
                let _ = tokio::time::timeout(
                    Duration::from_secs(1),
                    peer.notify_cancelled(CancelledNotificationParam::new(
                        Some(request_id),
                        Some(reason.to_string()),
                    )),
                )
                .await;
            });
            Err(error)
        }
        .await;
        if matches!(result, Err(McpCallError::Failed(_))) {
            self.invalidate_if_same(&params.key, &connection);
        }
        result
    }

    /// Drops `key`'s connection so the next call reconnects with current
    /// configuration and secrets.
    pub fn invalidate(&self, key: &str) {
        if let Some(slot) = self.slots.lock().unwrap().remove(key) {
            *slot.connection.lock().unwrap() = None;
        }
    }

    /// Called after draining the Plugin's jobs, before removing session data.
    pub async fn stop(&self, key: &str) -> Result<()> {
        let slot = self.slots.lock().unwrap().get(key).cloned();
        let Some(slot) = slot else { return Ok(()) };
        let _connecting = slot
            .connecting
            .try_lock()
            .context("MCP connection is starting; retry clearing state after it finishes")?;
        let connection = slot.connection.lock().unwrap().take();
        self.slots.lock().unwrap().remove(key);
        if let Some(connection) = connection {
            let connection = Arc::try_unwrap(connection).map_err(|_| {
                anyhow::anyhow!("MCP connection is still in use; state was not cleared")
            })?;
            connection
                .service
                .cancel()
                .await
                .context("MCP shutdown failed")?;
        }
        Ok(())
    }

    /// Shuts down servers idle for [`IDLE_TIMEOUT`] so unused stdio processes
    /// do not stay resident for the life of the app.
    pub fn spawn_idle_eviction(self: Arc<Self>) {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(IDLE_SWEEP_INTERVAL);
            loop {
                interval.tick().await;
                self.evict_idle();
            }
        });
    }

    fn evict_idle(&self) {
        let slots = self
            .slots
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for slot in slots {
            let mut connection = slot.connection.lock().unwrap();
            // An in-flight call holds its own clone, so a lone reference is idle.
            let idle = connection.as_ref().is_some_and(|connection| {
                Arc::strong_count(connection) == 1
                    && connection.last_used.lock().unwrap().elapsed() >= IDLE_TIMEOUT
            });
            if idle {
                *connection = None;
            }
        }
    }

    fn invalidate_if_same(&self, key: &str, connection: &Arc<McpConnection>) {
        let Some(slot) = self.slots.lock().unwrap().get(key).cloned() else {
            return;
        };
        let mut current = slot.connection.lock().unwrap();
        if current
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, connection))
        {
            *current = None;
        }
    }
}

/// A `CredentialStore` seeded with the credentials loaded from Plugin secrets
/// that also writes every refresh or clear back through `sink`.
struct PersistentCredentialStore {
    credentials: Mutex<Option<StoredCredentials>>,
    sink: Arc<dyn CredentialSink>,
}

#[async_trait::async_trait]
impl CredentialStore for PersistentCredentialStore {
    async fn load(&self) -> std::result::Result<Option<StoredCredentials>, AuthError> {
        Ok(self.credentials.lock().unwrap().clone())
    }

    async fn save(&self, credentials: StoredCredentials) -> std::result::Result<(), AuthError> {
        *self.credentials.lock().unwrap() = Some(credentials.clone());
        let StoredCredentials {
            client_id,
            token_response,
            ..
        } = credentials;
        let Some(token) = token_response else {
            return Ok(());
        };
        let sink = self.sink.clone();
        persist(move || sink.save(&client_id, &token)).await
    }

    async fn clear(&self) -> std::result::Result<(), AuthError> {
        *self.credentials.lock().unwrap() = None;
        let sink = self.sink.clone();
        persist(move || sink.clear()).await
    }
}

/// Runs a credential write off the async worker and reports its failure to
/// the SDK instead of dropping it.
async fn persist(
    write: impl FnOnce() -> Result<()> + Send + 'static,
) -> std::result::Result<(), AuthError> {
    tokio::task::spawn_blocking(write)
        .await
        .map_err(|error| AuthError::CredentialStoreError(error.to_string()))?
        .map_err(|error| AuthError::CredentialStoreError(format!("{error:#}")))
}

async fn handshake<T, E, A>(
    transport: T,
    label: &str,
    timeout: Duration,
) -> Result<RunningService<RoleClient, ()>>
where
    T: rmcp::transport::IntoTransport<RoleClient, E, A>,
    E: std::error::Error + Send + Sync + 'static,
{
    tokio::time::timeout(
        timeout,
        ().serve_with_lifecycle(
            transport,
            ClientLifecycleMode::Auto {
                preferred_versions: vec![
                    ProtocolVersion::V_2026_07_28,
                    ProtocolVersion::V_2025_11_25,
                ],
                legacy_version: Some(ProtocolVersion::V_2025_11_25),
            },
        ),
    )
    .await
    .with_context(|| format!("{label} timed out"))?
    .map_err(Into::into)
}

async fn list_tools(connection: &McpConnection) -> Result<Vec<Tool>> {
    tokio::time::timeout(DISCOVERY_TIMEOUT, connection.service.list_all_tools())
        .await
        .context("MCP tools/list timed out")?
        .context("MCP tools/list failed")
}

async fn connect(params: &McpConnectionParams) -> Result<McpConnection> {
    let service = match &params.config {
        McpConfig::Stdio { command, args, env } => {
            let npx = match &params.embedded_npx_home {
                Some(squire_home) if command == "npx" => {
                    let squire_home = squire_home.clone();
                    Some(
                        tokio::task::spawn_blocking(move || crate::node_runtime::npx(&squire_home))
                            .await
                            .context("Node.js runtime task failed")?
                            .context("failed to prepare Squire's npx")?,
                    )
                }
                _ => None,
            };
            let mut process = match &npx {
                Some(npx) => {
                    let mut process = Command::new(&npx.program);
                    process.args(&npx.leading_args);
                    process
                }
                None => Command::new(crate::util::resolve_program(
                    resolve_command(&params.plugin_dir, command).as_os_str(),
                    None,
                )),
            };
            crate::util::hide_console(process.as_std_mut());
            // Secrets reach the child only through the manifest's env map, so
            // Squire's own environment never leaks into the MCP server.
            process
                .args(args)
                .current_dir(&params.plugin_dir)
                .env_clear();
            for name in [
                "PATH",
                "HOME",
                "USER",
                "TMPDIR",
                "SystemRoot",
                "USERPROFILE",
                "APPDATA",
                "LOCALAPPDATA",
                "TEMP",
                "TMP",
                "PATHEXT",
            ] {
                if let Some(value) = std::env::var_os(name) {
                    process.env(name, value);
                }
            }
            for (name, value) in env {
                process.env(name, resolve_value(value, &params.secrets)?);
            }
            // Host-managed, so after the manifest's env: Squire's Node.js stays
            // first on whichever PATH the server ends up with (the manifest's,
            // or the inherited one), and npm's cache stays under SQUIRE_HOME.
            if let (Some(npx), Some(squire_home)) = (&npx, &params.embedded_npx_home) {
                embedded_npx_env(process.as_std_mut(), npx, squire_home)?;
            }
            // Authoritative last: the private data directory is host-managed
            // (`plugin-data/<id>`, cleared on delete/clear), never manifest input.
            if let Some(data_dir) = &params.data_dir {
                crate::util::create_private_dir(data_dir)?;
                process.env(MCP_PLUGIN_DATA_DIR_ENV, data_dir);
            }
            let (transport, stderr) = TokioChildProcess::builder(process)
                .stderr(Stdio::piped())
                .spawn()
                .with_context(|| {
                    format!("failed to start MCP command `{command}`; check that it is installed and available to Squire")
                })?;
            if let Some(stderr) = stderr {
                tokio::spawn(async move {
                    let mut lines = tokio::io::BufReader::new(stderr).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        tracing::error!("[MCP] {line}");
                    }
                });
            }
            handshake(transport, "MCP stdio negotiation", STDIO_HANDSHAKE_TIMEOUT).await?
        }
        McpConfig::StreamableHttp { url, headers } => {
            let mut custom_headers = HashMap::new();
            for (name, value) in headers {
                let name = HeaderName::from_bytes(name.as_bytes())
                    .with_context(|| format!("invalid MCP header name `{name}`"))?;
                let value = HeaderValue::from_str(&resolve_value(value, &params.secrets)?)
                    .context("invalid MCP header value")?;
                custom_headers.insert(name, value);
            }
            let transport_config = StreamableHttpClientTransportConfig::with_uri(url.clone())
                .custom_headers(custom_headers);
            if let (Some(client_id), Some(token_json)) = (
                params.secrets.get(MCP_OAUTH_CLIENT_ID_KEY),
                params.secrets.get(MCP_OAUTH_TOKEN_KEY),
            ) {
                let token: OAuthTokenResponse = serde_json::from_str(token_json)
                    .context("stored MCP OAuth token is invalid")?;
                let http_client = oauth_http_client()?;
                let mut oauth = OAuthState::new(url, Some(http_client.clone()))
                    .await
                    .context("failed to initialize MCP OAuth state")?;
                oauth
                    .set_credentials(client_id, token.clone())
                    .await
                    .context("failed to restore MCP OAuth credentials")?;
                let mut manager = oauth
                    .into_authorization_manager()
                    .context("MCP OAuth state did not contain an authorization manager")?;
                if let Some(secret) = params.secrets.get(MCP_OAUTH_CLIENT_SECRET_KEY) {
                    let redirect_uri = params
                        .secrets
                        .get(MCP_OAUTH_REDIRECT_URI_KEY)
                        .map(String::as_str)
                        .unwrap_or("http://127.0.0.1/callback");
                    let mut client =
                        rmcp::transport::auth::OAuthClientConfig::new(client_id, redirect_uri);
                    client.client_secret = Some(secret.clone());
                    client.scopes = params
                        .secrets
                        .get(MCP_OAUTH_SCOPES_KEY)
                        .map(|scopes| scopes.split_whitespace().map(str::to_owned).collect())
                        .unwrap_or_default();
                    manager
                        .configure_client(client)
                        .context("failed to restore registered MCP client credentials")?;
                }
                if let Some(sink) = params.sink.clone() {
                    let stored =
                        StoredCredentials::new(client_id.clone(), Some(token), Vec::new(), None);
                    manager.set_credential_store(PersistentCredentialStore {
                        credentials: Mutex::new(Some(stored)),
                        sink,
                    });
                }
                // OAuth discovery/refresh uses the bounded client above. Tool calls
                // and SSE streams are bounded by the Action's own deadline.
                let auth_client = AuthClient::new(reqwest::Client::new(), manager);
                let transport =
                    StreamableHttpClientTransport::with_client(auth_client, transport_config);
                handshake(transport, "MCP OAuth HTTP negotiation", HANDSHAKE_TIMEOUT).await?
            } else {
                let transport = StreamableHttpClientTransport::from_config(transport_config);
                handshake(transport, "MCP HTTP negotiation", HANDSHAKE_TIMEOUT).await?
            }
        }
    };
    let metadata = match service.peer_info() {
        Some(peer) => McpMetadata {
            protocol_version: Some(peer.protocol_version.as_str().to_string()),
            server_info: peer.server_info.clone(),
        },
        None => McpMetadata::default(),
    };
    Ok(McpConnection {
        service,
        metadata,
        last_used: Mutex::new(Instant::now()),
    })
}

/// Sets the environment that keeps a curated `npx` server on Squire's
/// Node.js, overriding anything the manifest set for the same names.
fn embedded_npx_env(
    process: &mut std::process::Command,
    npx: &crate::node_runtime::Npx,
    squire_home: &Path,
) -> Result<()> {
    // Windows environment names are case-insensitive (`Path`); npm reads its
    // `npm_config_*` variables case-insensitively everywhere.
    let is_path = |name: &OsStr| {
        if cfg!(windows) {
            name.eq_ignore_ascii_case("PATH")
        } else {
            name == "PATH"
        }
    };
    let path = process
        .get_envs()
        .filter(|(name, _)| is_path(name))
        .find_map(|(_, value)| value.map(OsStr::to_os_string))
        .unwrap_or_default();
    let path = std::env::join_paths(
        std::iter::once(npx.bin_dir.clone()).chain(std::env::split_paths(&path)),
    )
    .context("Squire's Node.js directory cannot be put on PATH")?;
    let npm_overrides: Vec<OsString> = process
        .get_envs()
        .map(|(name, _)| name)
        .filter(|name| {
            name.eq_ignore_ascii_case("npm_config_cache")
                || name.eq_ignore_ascii_case("npm_config_update_notifier")
        })
        .map(OsStr::to_os_string)
        .collect();
    for name in npm_overrides {
        process.env_remove(name);
    }
    process
        .env("PATH", path)
        .env(
            "npm_config_cache",
            crate::node_runtime::npm_cache(squire_home),
        )
        // npm's update notice is written to stderr, which is logged as errors.
        .env("npm_config_update_notifier", "false");
    Ok(())
}

/// Resolves the configured command. Bare names are looked up on `PATH` and
/// absolute paths are used as given; a relative path names a file bundled in
/// the Plugin directory. The command is exactly what the user typed or approved
/// in the package preview, so it is not restricted further.
fn resolve_command(plugin_dir: &Path, command: &str) -> PathBuf {
    let path = Path::new(command);
    if path.is_relative() && (command.contains('/') || command.contains('\\')) {
        plugin_dir.join(path)
    } else {
        path.to_path_buf()
    }
}

fn resolve_value(value: &McpConfigValue, secrets: &HashMap<String, String>) -> Result<String> {
    match value {
        McpConfigValue::Literal(value) => Ok(value.clone()),
        McpConfigValue::Secret { secret } => secrets
            .get(secret)
            .with_context(|| format!("missing Plugin secret `{secret}`"))
            .cloned(),
    }
}
