//! Wasmtime Component Model runtime for WASM Plugins.
//!
//! One shared engine and compiled-component cache. Each invocation gets a fresh
//! store, host context, and resource limits; guest instances are never pooled.
//! Invocations run synchronously on the blocking pool, and so do host
//! functions.
//!
//! Compiled components are also persisted as `.cwasm` files so a restart does
//! not recompile every Plugin on first use; loading one is an `mmap`.

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    ffi::OsString,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use wasmtime::{
    component::{Component, HasSelf, Linker, Resource, ResourceTable},
    Config, Engine, Store, StoreLimits, StoreLimitsBuilder,
};
use wasmtime_wasi::{FsPerms, WasiCtx, WasiCtxView, WasiView};

wasmtime::component::bindgen!({
    path: "../wit/squire-plugin.wit",
    world: "plugin",
});

use exports::squire::plugin::action::{ActionError, AttachmentSource};
use squire::plugin::browser::{
    ActionError as BrowserActionError, ActionOutput as BrowserActionOutput,
    Attachment as BrowserAttachment, AttachmentSource as BrowserAttachmentSource,
};
use squire::plugin::commands::{CommandRequest, CommandResult};
use squire::plugin::network::{NetworkRequest, NetworkResponse};
use squire::plugin::processes::{
    ListeningProcess, ProcessInfo, ProcessLogs, ProcessStatus, SpawnRequest, SpawnResult,
};
use squire::plugin::sockets::{ConnectError, Connection};

const MAX_MEMORY_BYTES: usize = 256 * 1024 * 1024;
const MAX_TABLE_ELEMENTS: usize = 100_000;
const MAX_INSTANCES: usize = 64;
const MAX_MEMORIES: usize = 4;
const MAX_TABLES: usize = 4;

/// Everything a single invocation needs from Squire.
pub struct InvocationContext {
    pub plugin_id: String,
    pub action_name: String,
    pub browser_scope: String,
    pub command_path: OsString,
    pub roots: Vec<String>,
    pub secrets: BTreeMap<String, String>,
    pub data_dir: PathBuf,
    pub staging_dir: PathBuf,
    pub deadline: Instant,
    pub cancellation: tokio_util::sync::CancellationToken,
    /// Where the guest reports what it is doing (`squire:plugin/status`).
    pub progress: crate::jobs::ActionProgress,
    pub output_limit: usize,
    pub squire_home: PathBuf,
    pub processes: Arc<crate::wasm_processes::ProcessManager>,
    pub http: NetworkClient,
    /// Public-web egress (`network.request-public`) for destinations the
    /// component did not choose itself.
    pub public_http: NetworkClient,
    pub browser: Arc<crate::browser::BrowserService>,
}

struct HostState {
    limits: StoreLimits,
    ctx: InvocationContext,
    wasi: WasiCtx,
    table: ResourceTable,
    locks: crate::wasm_locks::InvocationLocks,
    sockets: crate::wasm_sockets::InvocationSockets,
}

impl WasiView for HostState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

use crate::epoch::EpochTicker;
use crate::wasm_network::{NetworkClient, NetworkPolicy};
use crate::wasm_paths;

/// One Wasmtime engine and compiled-component cache shared by every WASM
/// Plugin invocation.
pub struct WasmRuntime {
    engine: Engine,
    /// WASI plus Squire host bindings, linked once for every component.
    linker: Linker<HostState>,
    /// Components compiled and type-checked against `linker`, ready to
    /// instantiate per invocation.
    components: Mutex<HashMap<String, PluginPre<HostState>>>,
    /// One gate per Plugin being loaded, so concurrent cold calls compile once.
    loading: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Calls hold a read lease; package commits hold the write lease.
    access: Mutex<HashMap<String, Arc<tokio::sync::RwLock<()>>>>,
    /// Persisted `.cwasm` artifacts, one directory per installed Plugin.
    cache_dir: PathBuf,
    http: NetworkClient,
    epoch: EpochTicker,
    processes: Arc<crate::wasm_processes::ProcessManager>,
}

/// Compiled and linked, but not yet visible to invocations.
pub(crate) struct PreparedComponent(PluginPre<HostState>);

pub(crate) const EGRESS_PROFILE: wreq_util::Profile = wreq_util::Profile::Chrome149;

impl WasmRuntime {
    pub fn new(cache_dir: PathBuf) -> Result<Self> {
        let mut config = Config::new();
        config.epoch_interruption(true);
        let engine = Engine::new(&config)
            .map_err(|error| wasmtime_error("failed to create the Wasmtime engine", error))?;
        let mut linker = Linker::<HostState>::new(&engine);
        wasmtime_wasi::p2::add_to_linker_sync(&mut linker)
            .map_err(|error| wasmtime_error("failed to link WASI", error))?;
        Plugin::add_to_linker::<_, HasSelf<_>>(&mut linker, |state: &mut HostState| state)
            .map_err(|error| wasmtime_error("failed to link the Squire host interfaces", error))?;
        // The TLS/HTTP2 half of the plugin egress identity: wreq's
        // Chrome149 profile supplies the fingerprints that match the
        // User-Agent and client hints the plugins send (their constants
        // live in the plugin SDK; the test at the bottom of this file
        // holds the two crates together). `headers(false)` keeps wreq
        // from also sending the profile's default headers: those are
        // navigation-shaped (Upgrade-Insecure-Requests, Sec-Fetch-*
        // navigate, Accept: text/html), while each plugin states headers
        // for its own request class. Plugins do send the profile's
        // Accept-Encoding explicitly, and the compression features on the
        // wreq dependency make the host decode what comes back.
        let http = NetworkClient::new(NetworkPolicy::Unrestricted, EGRESS_PROFILE)?;
        let ticker = EpochTicker::new(engine.clone());
        Ok(Self {
            engine,
            linker,
            components: Mutex::new(HashMap::new()),
            loading: Mutex::new(HashMap::new()),
            access: Mutex::new(HashMap::new()),
            cache_dir,
            http,
            epoch: ticker,
            processes: Arc::new(crate::wasm_processes::ProcessManager::new()),
        })
    }

    pub(crate) fn access(&self, id: &str) -> Arc<tokio::sync::RwLock<()>> {
        self.access
            .lock()
            .expect("WASM access gates")
            .entry(id.to_owned())
            .or_default()
            .clone()
    }

    pub(crate) fn prepare(&self, id: &str, path: &Path) -> Result<PreparedComponent> {
        let component = self.load(id, path)?;
        let instance_pre = self
            .linker
            .instantiate_pre(&component)
            .map_err(|error| wasmtime_error("failed to link the WASM Plugin component", error))?;
        PluginPre::new(instance_pre)
            .map(PreparedComponent)
            .map_err(|error| {
                wasmtime_error("failed to load the WASM Plugin component exports", error)
            })
    }

    /// The caller holds the installation's write lease until metadata and runtime agree.
    pub(crate) fn publish(&self, id: &str, component: PreparedComponent) {
        self.components
            .lock()
            .expect("WASM components")
            .insert(id.to_owned(), component.0);
    }

    /// Removes any cached compilation for an installed Plugin, in memory and
    /// on disk.
    pub fn evict(&self, installed_id: &str) {
        self.components.lock().unwrap().remove(installed_id);
        let _ = std::fs::remove_dir_all(self.cache_dir.join(installed_id));
    }

    /// Shared managed-process table for invocation contexts.
    pub fn processes(&self) -> Arc<crate::wasm_processes::ProcessManager> {
        self.processes.clone()
    }

    /// Shared HTTP client so invocations reuse connections and TLS sessions.
    pub fn http(&self) -> NetworkClient {
        self.http.clone()
    }

    /// Tree-kills background processes owned by a deleted plugin.
    pub fn cleanup_plugin(&self, plugin_id: &str) {
        self.processes.remove_plugin(plugin_id);
    }

    /// Whether `installed_id` has a compiled component in memory.
    pub fn is_cached(&self, installed_id: &str) -> bool {
        self.components.lock().unwrap().contains_key(installed_id)
    }

    /// Returns the pre-instantiated component for `installed_id`, compiling
    /// and linking it on first use. Installs and deletes call
    /// [`Self::evict`], so a cache entry always belongs to the component
    /// currently installed under that id.
    fn component(&self, installed_id: &str, path: &Path) -> Result<PluginPre<HostState>> {
        if let Some(cached) = self.components.lock().unwrap().get(installed_id) {
            return Ok(cached.clone());
        }
        let gate = self
            .loading
            .lock()
            .unwrap()
            .entry(installed_id.to_string())
            .or_default()
            .clone();
        let _loading = gate.lock().unwrap();
        if let Some(cached) = self.components.lock().unwrap().get(installed_id) {
            return Ok(cached.clone());
        }
        let loaded = self.link(installed_id, path);
        self.loading.lock().unwrap().remove(installed_id);
        loaded
    }

    fn link(&self, installed_id: &str, path: &Path) -> Result<PluginPre<HostState>> {
        let PreparedComponent(plugin_pre) = self.prepare(installed_id, path)?;
        Ok(self
            .components
            .lock()
            .unwrap()
            .entry(installed_id.to_string())
            .or_insert(plugin_pre)
            .clone())
    }

    /// Loads the persisted artifact for `path` when one matches, otherwise
    /// compiles, persists and loads it. Any cache failure falls back to an
    /// in-memory compile; the cache is an optimization, never a requirement.
    ///
    /// Runs once per Plugin per process (the linked component is then held in
    /// memory), so hashing the source here costs far less than the compile it
    /// replaces.
    fn load(&self, installed_id: &str, path: &Path) -> Result<Component> {
        let bytes =
            std::fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
        let artifact = self.artifact_path(installed_id, &bytes);
        if artifact.is_file() {
            // SAFETY: artifacts are written only by this runtime under
            // SQUIRE_HOME. Anyone able to replace them could equally replace
            // `plugin.wasm`, which already runs with host filesystem access,
            // so trusting them adds no capability. Wasmtime still rejects
            // artifacts from an incompatible engine or build.
            if let Ok(component) = unsafe { Component::deserialize_file(&self.engine, &artifact) } {
                return Ok(component);
            }
            let _ = std::fs::remove_file(&artifact);
        }
        let serialized = self.engine.precompile_component(&bytes).map_err(|error| {
            wasmtime_error(
                &format!("{} is not a valid WASM component", path.display()),
                error,
            )
        })?;
        if persist_artifact(&artifact, &serialized).is_ok() {
            // SAFETY: as above; this file was just written from `serialized`.
            if let Ok(component) = unsafe { Component::deserialize_file(&self.engine, &artifact) } {
                return Ok(component);
            }
        }
        // SAFETY: `serialized` was produced by this engine a moment ago.
        unsafe { Component::deserialize(&self.engine, &serialized) }
            .map_err(|error| wasmtime_error("failed to load the compiled WASM component", error))
    }

    /// `<cache>/<id>/<digest>.cwasm`, content-addressed: the digest covers the
    /// engine build and settings plus the exact component bytes, so an
    /// upgraded engine or any different `plugin.wasm` misses the cache.
    fn artifact_path(&self, installed_id: &str, bytes: &[u8]) -> PathBuf {
        let mut engine_hash = std::collections::hash_map::DefaultHasher::new();
        self.engine
            .precompile_compatibility_hash()
            .hash(&mut engine_hash);
        let mut digest = Sha256::new();
        digest.update(engine_hash.finish().to_le_bytes());
        digest.update(bytes);
        let digest = digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        self.cache_dir
            .join(installed_id)
            .join(format!("{digest}.cwasm"))
    }

    /// Instantiates the component in a fresh store and calls `invoke`. Blocks
    /// the calling thread: call it from the blocking pool.
    ///
    /// The outer `Result` reports host failures (compile, instantiate, trap).
    /// The inner `Result` reports plugin-reported Action failures.
    pub fn invoke_blocking(
        &self,
        installed_id: &str,
        component_path: &Path,
        action_id: &str,
        arguments_json: &str,
        ctx: InvocationContext,
    ) -> Result<Result<Value, String>> {
        let component = self.component(installed_id, component_path)?;
        let _active = self.epoch.begin();
        run_component(&self.engine, &component, ctx, action_id, arguments_json)
    }
}

/// Replaces the Plugin's artifacts with `bytes` at `artifact`, atomically.
fn persist_artifact(artifact: &Path, bytes: &[u8]) -> Result<()> {
    let directory = artifact.parent().context("artifact path has no parent")?;
    // Older fingerprints for this Plugin are dead weight once replaced.
    let _ = std::fs::remove_dir_all(directory);
    std::fs::create_dir_all(directory)?;
    let temp = directory.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, bytes)?;
    std::fs::rename(&temp, artifact).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })?;
    Ok(())
}

impl Drop for WasmRuntime {
    fn drop(&mut self) {
        // Tree-kill every managed background process on server shutdown.
        self.processes.shutdown();
    }
}

fn run_component(
    engine: &Engine,
    component: &PluginPre<HostState>,
    ctx: InvocationContext,
    action_id: &str,
    arguments_json: &str,
) -> Result<Result<Value, String>> {
    let limits = StoreLimitsBuilder::new()
        .memory_size(MAX_MEMORY_BYTES)
        .table_elements(MAX_TABLE_ELEMENTS)
        .instances(MAX_INSTANCES)
        .memories(MAX_MEMORIES)
        .tables(MAX_TABLES)
        .build();
    let wasi = build_wasi_ctx()?;
    let mut store = Store::new(
        engine,
        HostState {
            limits,
            ctx,
            wasi,
            table: ResourceTable::new(),
            locks: crate::wasm_locks::InvocationLocks::default(),
            sockets: crate::wasm_sockets::InvocationSockets::default(),
        },
    );
    store.limiter(|state| &mut state.limits);
    store.set_epoch_deadline(1);
    store.epoch_deadline_callback(|store| {
        if store.data().ctx.cancellation.is_cancelled() {
            return Err(wasmtime::Error::msg("invocation cancelled"));
        }
        if Instant::now() >= store.data().ctx.deadline {
            return Err(wasmtime::Error::msg("invocation deadline expired"));
        }
        Ok(wasmtime::UpdateDeadline::Continue(1))
    });
    let bindings = component.instantiate(&mut store).map_err(|error| {
        wasmtime_error("failed to instantiate the WASM Plugin component", error)
    })?;
    let arguments_json = wasm_paths::arguments_to_guest(arguments_json);
    let result = bindings
        .squire_plugin_action()
        .call_invoke(&mut store, action_id, &arguments_json)
        .map_err(|error| wasmtime_error("WASM Plugin invocation failed", error))?;

    match result {
        Ok(output) => {
            let mut structured = match structured_content(&output.structured_json) {
                Ok(structured) => structured,
                Err(error) => {
                    return Ok(Err(format!(
                        "Plugin returned a malformed result: {error:#}"
                    )))
                }
            };
            wasm_paths::json_to_host(&mut structured);
            let staging_dir = &store.data().ctx.staging_dir;
            let attachments = output
                .attachments
                .into_iter()
                .map(|attachment| {
                    let path = match attachment.source {
                        AttachmentSource::Path(path) => {
                            wasm_paths::text_to_host(&path).into_owned()
                        }
                        AttachmentSource::Bytes(bytes) => stage_bytes(staging_dir, &bytes)?,
                    };
                    Ok(json!({ "path": path, "mimeType": attachment.mime_type }))
                })
                .collect::<Result<Vec<_>>>()?;
            // Results are returned to the caller exactly as the component
            // produced them.
            let mut value = json!({ "structuredContent": structured });
            if !attachments.is_empty() {
                value["attachments"] = Value::Array(attachments);
            }
            Ok(Ok(value))
        }
        Err(ActionError::ActionFailed(message) | ActionError::InvalidArguments(message)) => {
            Ok(Err(wasm_paths::text_to_host(&message).into_owned()))
        }
    }
}

fn structured_content(json: &str) -> Result<Value> {
    let structured: Value =
        serde_json::from_str(json).context("structured-json is not valid JSON")?;
    if !structured.is_object() {
        bail!("structured-json must be a JSON object");
    }
    Ok(structured)
}

/// Writes an in-memory attachment into the invocation's staging directory so
/// it joins the same snapshot path as file attachments. Oversized content is
/// rejected before touching the disk.
fn stage_bytes(staging_dir: &Path, bytes: &[u8]) -> Result<String> {
    let limit = crate::connections::MAX_ATTACHMENT_BYTES;
    if bytes.len() as u64 > limit {
        bail!("Attachment exceeds {limit} bytes");
    }
    std::fs::create_dir_all(staging_dir)
        .with_context(|| format!("failed to create {}", staging_dir.display()))?;
    let path = staging_dir.join(format!(".attachment-{}", uuid::Uuid::new_v4()));
    std::fs::write(&path, bytes)
        .with_context(|| format!("failed to stage attachment {}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Converts a Wasmtime error into an `anyhow` error with context.
///
/// `wasmtime::Error` intentionally does not implement `std::error::Error`, so
/// `anyhow::Context` cannot be used directly on Wasmtime results.
fn wasmtime_error(context: &str, error: wasmtime::Error) -> anyhow::Error {
    anyhow::anyhow!("{context}: {error:#}")
}

/// Builds the WASI context for one invocation.
///
/// Components are trusted native code: like a child process they can read and
/// write the host filesystem and run host programs. On Unix the host root is
/// preopened at `/`, on Windows every available drive root as its letter
/// (`C:`), which plugins reach as `/C:/…` (see [`wasm_paths`]). The Plugin's
/// private data directory and invocation staging directory live on that
/// filesystem and are passed to the component by path.
fn build_wasi_ctx() -> Result<WasiCtx> {
    let mut builder = WasiCtx::builder();
    builder.allow_blocking_current_thread(true);

    #[cfg(unix)]
    builder
        .preopened_dir("/", "/", FsPerms::ReadWrite)
        .map_err(|error| wasmtime_error("failed to preopen the filesystem root", error))?;

    #[cfg(not(unix))]
    for drive in b'A'..=b'Z' {
        let root = format!("{}:\\", drive as char);
        let path = Path::new(&root);
        if path.is_dir() {
            builder
                .preopened_dir(path, &root[..2], FsPerms::ReadWrite)
                .map_err(|error| {
                    wasmtime_error(&format!("failed to preopen drive {root}"), error)
                })?;
        }
    }

    Ok(builder.build())
}

impl squire::plugin::status::Host for HostState {
    fn report(&mut self, message: String) {
        self.ctx.progress.report(&message);
    }
}

impl squire::plugin::secrets::Host for HostState {
    fn get(&mut self, name: String) -> Option<String> {
        self.ctx.secrets.get(&name).cloned()
    }
}

fn block_on_host<T>(
    operation: &str,
    future: impl std::future::Future<Output = std::result::Result<T, String>>,
) -> std::result::Result<T, String> {
    tokio::runtime::Handle::try_current()
        .map_err(|_| format!("no async runtime is available for {operation} execution"))?
        .block_on(future)
}

impl squire::plugin::network::Host for HostState {
    fn request(&mut self, request: NetworkRequest) -> std::result::Result<NetworkResponse, String> {
        block_on_host("network", async {
            tokio::select! {
                biased;
                _ = self.ctx.cancellation.cancelled() => Err("invocation cancelled".into()),
                result = self.ctx.http.execute(&request, self.ctx.deadline) => result,
            }
        })
    }

    fn request_public(
        &mut self,
        request: NetworkRequest,
    ) -> std::result::Result<NetworkResponse, String> {
        block_on_host("network", async {
            tokio::select! {
                biased;
                _ = self.ctx.cancellation.cancelled() => Err("invocation cancelled".into()),
                result = self.ctx.public_http.execute(&request, self.ctx.deadline) => result,
            }
        })
    }
}

impl squire::plugin::sockets::Host for HostState {
    fn connect_with_timeout(
        &mut self,
        port: u16,
        timeout_ms: u32,
    ) -> std::result::Result<Resource<Connection>, ConnectError> {
        self.connect_until(
            port,
            self.ctx
                .deadline
                .min(Instant::now() + Duration::from_millis(u64::from(timeout_ms))),
        )
    }

    fn connect(&mut self, port: u16) -> std::result::Result<Resource<Connection>, ConnectError> {
        self.connect_until(port, self.ctx.deadline)
    }
}

impl HostState {
    fn connect_until(
        &mut self,
        port: u16,
        deadline: Instant,
    ) -> std::result::Result<Resource<Connection>, ConnectError> {
        let result = tokio::runtime::Handle::try_current()
            .map_err(|e| ConnectError::Failed(format!("no runtime for TCP connect: {e}")))?
            .block_on(self.sockets.connect(port, deadline, &self.ctx.cancellation));
        let socket = result.map_err(|error| match error {
            crate::wasm_sockets::ConnectError::Refused => ConnectError::Refused,
            crate::wasm_sockets::ConnectError::InvalidPort => ConnectError::InvalidPort,
            crate::wasm_sockets::ConnectError::LimitReached => ConnectError::LimitReached,
            crate::wasm_sockets::ConnectError::Failed(e) => ConnectError::Failed(e),
        })?;
        let resource = self.table.push(socket).map_err(|error| {
            self.sockets.closed();
            ConnectError::Failed(format!("cannot allocate TCP resource: {error}"))
        })?;
        Ok(Resource::new_own(resource.rep()))
    }
}

impl squire::plugin::sockets::HostConnection for HostState {
    fn send(
        &mut self,
        rep: Resource<Connection>,
        bytes: Vec<u8>,
    ) -> std::result::Result<(), String> {
        let resource = Resource::<crate::wasm_sockets::SocketConnection>::new_borrow(rep.rep());
        let conn = self
            .table
            .get_mut(&resource)
            .map_err(|e| format!("TCP connection is closed: {e}"))?;
        let deadline = conn.deadline;
        let result = block_on_host(
            "TCP send",
            self.sockets
                .send(conn, &bytes, deadline, &self.ctx.cancellation),
        );
        result
    }

    fn recv(
        &mut self,
        rep: Resource<Connection>,
        max_bytes: u32,
    ) -> std::result::Result<Vec<u8>, String> {
        let resource = Resource::<crate::wasm_sockets::SocketConnection>::new_borrow(rep.rep());
        let conn = self
            .table
            .get_mut(&resource)
            .map_err(|e| format!("TCP connection is closed: {e}"))?;
        let deadline = conn.deadline;
        let result = block_on_host(
            "TCP recv",
            self.sockets
                .recv(conn, max_bytes, deadline, &self.ctx.cancellation),
        );
        result
    }

    fn drop(&mut self, rep: Resource<Connection>) -> wasmtime::Result<()> {
        self.table
            .delete(Resource::<crate::wasm_sockets::SocketConnection>::new_own(
                rep.rep(),
            ))?;
        self.sockets.closed();
        Ok(())
    }
}

impl squire::plugin::browser::Host for HostState {
    fn invoke(
        &mut self,
        action: String,
        profile: Option<String>,
        args_json: String,
    ) -> std::result::Result<BrowserActionOutput, BrowserActionError> {
        let browser = self.ctx.browser.clone();
        let owner = self.ctx.plugin_id.clone();
        let args_json = wasm_paths::text_to_host(&args_json).into_owned();
        let roots = self.ctx.roots.clone();
        let data_dir = self.ctx.data_dir.clone();
        let staging_dir = self.ctx.staging_dir.clone();
        let deadline = self.ctx.deadline;
        let cancellation = self.ctx.cancellation.clone();
        let output = block_on_host(
            "browser",
            browser.invoke(crate::browser::BrowserInvocation {
                owner: &owner,
                invocation_action: &self.ctx.action_name,
                scope: &self.ctx.browser_scope,
                action: &action,
                profile: profile.as_deref(),
                args_json: &args_json,
                enabled_roots: &roots,
                data_dir: &data_dir,
                staging_dir: &staging_dir,
                deadline,
                cancellation: &cancellation,
            }),
        )
        .map_err(|message| {
            if message.starts_with("error=invalid_argument") {
                BrowserActionError::InvalidArguments(message)
            } else {
                BrowserActionError::ActionFailed(message)
            }
        })?;
        let structured_json = serde_json::to_string(&output.structured)
            .map_err(|error| BrowserActionError::ActionFailed(error.to_string()))?;
        Ok(BrowserActionOutput {
            structured_json,
            attachments: output
                .attachments
                .into_iter()
                .map(|(path, mime_type)| BrowserAttachment {
                    source: BrowserAttachmentSource::Path(wasm_paths::to_guest(Path::new(&path))),
                    mime_type,
                })
                .collect(),
        })
    }
}

impl squire::plugin::commands::Host for HostState {
    fn run(&mut self, mut request: CommandRequest) -> std::result::Result<CommandResult, String> {
        command_line_to_host(
            &mut request.program,
            &mut request.arguments,
            &mut request.working_directory,
            &mut request.environment,
        );
        block_on_host("command", run_command(&self.ctx, request))
    }
}

/// A command from a plugin, with the paths in its command line, working
/// directory and environment in Windows form.
fn command_line_to_host(
    program: &mut String,
    arguments: &mut [String],
    working_directory: &mut Option<String>,
    environment: &mut [(String, String)],
) {
    let convert = |text: &mut String| {
        if let std::borrow::Cow::Owned(converted) = wasm_paths::text_to_host(text) {
            *text = converted;
        }
    };
    convert(program);
    arguments.iter_mut().for_each(convert);
    if let Some(directory) = working_directory {
        convert(directory);
    }
    environment.iter_mut().for_each(|(_, value)| convert(value));
}

impl squire::plugin::processes::Host for HostState {
    fn spawn(&mut self, mut request: SpawnRequest) -> std::result::Result<SpawnResult, String> {
        command_line_to_host(
            &mut request.program,
            &mut request.arguments,
            &mut request.working_directory,
            &mut request.environment,
        );
        self.ctx
            .processes
            .spawn(
                &self.ctx.plugin_id,
                crate::wasm_processes::ProcessSpawnSpec {
                    key: request.key.as_deref(),
                    program: &request.program,
                    arguments: &request.arguments,
                    working_directory: request.working_directory.as_deref(),
                    environment: &request.environment,
                },
                &self.ctx.command_path,
            )
            .map(|result| SpawnResult {
                process: ProcessInfo {
                    id: result.process.id,
                    pid: result.process.pid,
                    key: result.process.key,
                    program: result.process.program,
                    arguments: result.process.arguments,
                    working_directory: result.process.working_directory,
                    environment: result.process.environment,
                },
                reused: result.reused,
            })
    }

    fn list_processes(&mut self) -> Vec<ProcessInfo> {
        self.ctx
            .processes
            .list(&self.ctx.plugin_id)
            .into_iter()
            .map(|process| ProcessInfo {
                id: process.id,
                pid: process.pid,
                key: process.key,
                program: process.program,
                arguments: process.arguments,
                working_directory: process.working_directory,
                environment: process.environment,
            })
            .collect()
    }

    fn status(&mut self, id: String) -> std::result::Result<ProcessStatus, String> {
        let (running, exit_code, pid) = self.ctx.processes.status(&self.ctx.plugin_id, &id)?;
        Ok(ProcessStatus {
            running,
            exit_code,
            pid,
        })
    }

    fn find_listeners(
        &mut self,
        working_directory: String,
        environment_keys: Vec<String>,
    ) -> std::result::Result<Vec<ListeningProcess>, String> {
        let deadline = self.ctx.deadline;
        let cancellation = self.ctx.cancellation.clone();
        let working_directory = wasm_paths::text_to_host(&working_directory);
        block_on_host(
            "external process discovery",
            crate::wasm_processes::find_listeners(
                &working_directory,
                &environment_keys,
                deadline,
                &cancellation,
            ),
        )
        .map(|processes| {
            processes
                .into_iter()
                .map(|process| ListeningProcess {
                    pid: process.pid,
                    lifecycle_event: process.lifecycle_event,
                    environment: process.environment,
                    ports: process.ports,
                })
                .collect()
        })
    }

    fn read(&mut self, id: String, max_bytes: u32) -> std::result::Result<ProcessLogs, String> {
        let (stdout, stderr, stdout_truncated, stderr_truncated, running, exit_code) = self
            .ctx
            .processes
            .read(&self.ctx.plugin_id, &id, max_bytes as usize)?;
        Ok(ProcessLogs {
            stdout,
            stderr,
            stdout_truncated,
            stderr_truncated,
            running,
            exit_code,
        })
    }

    fn stop(&mut self, id: String) -> std::result::Result<String, String> {
        self.ctx.processes.stop(&self.ctx.plugin_id, &id)
    }

    fn remove(&mut self, id: String) -> std::result::Result<(), String> {
        self.ctx.processes.remove(&self.ctx.plugin_id, &id)
    }
}

impl squire::plugin::locks::Host for HostState {
    fn acquire(&mut self, name: String) -> std::result::Result<(), String> {
        self.locks.acquire(
            &self.ctx.plugin_id,
            &self.ctx.squire_home,
            &name,
            self.ctx.deadline,
            &self.ctx.cancellation,
        )
    }

    fn try_acquire(&mut self, name: String) -> std::result::Result<bool, String> {
        self.locks
            .try_acquire(&self.ctx.plugin_id, &self.ctx.squire_home, &name)
    }

    fn release(&mut self, name: String) -> std::result::Result<(), String> {
        self.locks.release(&name)
    }
}

impl squire::plugin::env::Host for HostState {
    fn operating_system(&mut self) -> String {
        std::env::consts::OS.to_string()
    }

    fn architecture(&mut self) -> String {
        std::env::consts::ARCH.to_string()
    }

    fn roots(&mut self) -> Vec<String> {
        self.ctx
            .roots
            .iter()
            .map(|root| wasm_paths::to_guest(Path::new(root)))
            .collect()
    }

    fn data_dir(&mut self) -> std::result::Result<String, String> {
        // Created only for components that ask.
        crate::util::create_private_dir(&self.ctx.data_dir).map_err(|error| {
            format!("failed to create {}: {error}", self.ctx.data_dir.display())
        })?;
        Ok(wasm_paths::to_guest(&self.ctx.data_dir))
    }

    fn squire_home(&mut self) -> String {
        wasm_paths::to_guest(&self.ctx.squire_home)
    }

    fn deadline_unix_ms(&mut self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| {
                elapsed.as_millis() as u64
                    + self
                        .ctx
                        .deadline
                        .saturating_duration_since(Instant::now())
                        .as_millis() as u64
            })
            .unwrap_or(0)
    }

    fn staging_directory(&mut self) -> std::result::Result<String, String> {
        // Created only for components that stage files; the host removes it
        // when the invocation ends.
        std::fs::create_dir_all(&self.ctx.staging_dir).map_err(|error| {
            format!(
                "failed to create {}: {error}",
                self.ctx.staging_dir.display()
            )
        })?;
        Ok(wasm_paths::to_guest(&self.ctx.staging_dir))
    }
}

async fn run_command(
    ctx: &InvocationContext,
    request: CommandRequest,
) -> std::result::Result<CommandResult, String> {
    if request.program.trim().is_empty() {
        return Err("command program must not be empty".to_string());
    }
    if let Some(working_directory) = request.working_directory.as_deref() {
        crate::wasm_processes::validate_working_directory(working_directory)?;
    }
    let program_name = request.program.clone();
    // One deadline governs the entire foreground operation: spawn, stdin
    // write, stdout/stderr draining, and wait. The timeout below wraps all of
    // them so a blocked stdin write cannot outlive the invocation.
    let timeout = ctx.deadline.saturating_duration_since(Instant::now());
    tokio::select! {
        biased;
        _ = ctx.cancellation.cancelled() => Err("invocation cancelled".into()),
        result = tokio::time::timeout(timeout, run_command_inner(ctx, request)) => {
            result.unwrap_or_else(|_| Err(format!("command `{program_name}` exceeded the invocation deadline")))
        }
    }
}

async fn run_command_inner(
    ctx: &InvocationContext,
    mut request: CommandRequest,
) -> std::result::Result<CommandResult, String> {
    let mut command = tokio::process::Command::new(crate::util::resolve_program(
        std::ffi::OsStr::new(&request.program),
        Some(&ctx.command_path),
    ));
    command.args(&request.arguments);
    if let Some(working_directory) = request.working_directory.as_deref() {
        command.current_dir(Path::new(working_directory));
    }
    // Inherit the host environment for tooling, disable interactive prompts,
    // override PATH, then apply the component's explicit overrides. This is
    // an execution facility, not a Plugin configuration API.
    crate::wasm_processes::make_noninteractive(command.as_std_mut());
    command.env("PATH", &ctx.command_path);
    for (name, value) in &request.environment {
        command.env(name, value);
    }
    command.stdin(if request.stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to run `{}`: {error}", request.program))?;
    let pid = child.id();
    // Guarantees the whole process group is signalled if this future is
    // cancelled (deadline timeout), hits an I/O error, or returns early.
    // `kill_on_drop(true)` only targets the direct child.
    let mut guard = TreeKillGuard {
        pid,
        disarmed: false,
    };
    let program = request.program.clone();
    let stdin_data = request.stdin.take();
    let stdin_pipe = child.stdin.take();
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let limit = ctx.output_limit;

    // Drain stdin, both output pipes, and wait concurrently so a child that
    // fills its stdout/stderr pipe while the parent is still writing stdin
    // cannot deadlock. `try_join!` fails fast on the first I/O error and the
    // guard kills the tree on drop.
    let ((), (stdout_bytes, stdout_truncated), (stderr_bytes, stderr_truncated), status) = tokio::try_join!(
        async {
            write_stdin(stdin_pipe, stdin_data)
                .await
                .map_err(|error| format!("failed to write command stdin: {error}"))
        },
        async {
            drain_bounded(stdout_pipe, limit)
                .await
                .map_err(|error| format!("failed while running `{program}`: {error}"))
        },
        async {
            drain_bounded(stderr_pipe, limit)
                .await
                .map_err(|error| format!("failed while running `{program}`: {error}"))
        },
        async {
            child
                .wait()
                .await
                .map_err(|error| format!("failed while running `{program}`: {error}"))
        }
    )?;
    guard.disarmed = true;

    let (stdout, stdout_truncated) = (
        String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stdout_truncated,
    );
    let (stderr, stderr_truncated) = (
        String::from_utf8_lossy(&stderr_bytes).into_owned(),
        stderr_truncated,
    );
    Ok(CommandResult {
        exit_code: status.code().unwrap_or(-1),
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
    })
}

/// Writes stdin concurrently with output draining, then shuts down the write
/// side so the child observes EOF.
async fn write_stdin(
    pipe: Option<tokio::process::ChildStdin>,
    data: Option<String>,
) -> std::result::Result<(), String> {
    let Some(data) = data else {
        return Ok(());
    };
    let Some(mut pipe) = pipe else {
        return Ok(());
    };
    use tokio::io::AsyncWriteExt;
    pipe.write_all(data.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    pipe.shutdown().await.map_err(|error| error.to_string())?;
    Ok(())
}

/// Drains one piped stream to EOF, retaining at most `limit` leading bytes.
///
/// Reading continues past the limit (discarding the remainder) so the child
/// never blocks on a full pipe while still producing output. The returned
/// flag reports whether the stream exceeded the limit.
async fn drain_bounded<R>(
    reader: Option<R>,
    limit: usize,
) -> std::result::Result<(Vec<u8>, bool), String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let Some(mut reader) = reader else {
        return Ok((Vec::new(), false));
    };
    use tokio::io::AsyncReadExt;
    let mut retained = Vec::new();
    if limit > 0 {
        retained.reserve(limit.min(8192));
    }
    let mut truncated = false;
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                if retained.len() < limit {
                    let room = limit - retained.len();
                    let take = room.min(n);
                    retained.extend_from_slice(&chunk[..take]);
                    if n > take {
                        truncated = true;
                    }
                } else {
                    truncated = true;
                }
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok((retained, truncated))
}

struct TreeKillGuard {
    pid: Option<u32>,
    disarmed: bool,
}

impl Drop for TreeKillGuard {
    fn drop(&mut self) {
        if !self.disarmed {
            kill_process_tree(self.pid);
        }
    }
}

fn kill_process_tree(pid: Option<u32>) {
    if let Some(pid) = pid {
        crate::wasm_processes::kill_tree_now(pid);
    }
}
