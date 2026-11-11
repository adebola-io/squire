//! Host-owned persistent browser service shared by every WASM Plugin.
//!
//! Rust owns profile namespaces, storage/capacity policy, export authorization,
//! runtime provisioning, the SQUIRE_HOME ownership lock, and the lifetime of
//! one Node supervisor. The supervisor receives absolute profile directories;
//! a guest never chooses an owner or filesystem location.

use anyhow::{Context, Result};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    ffi::OsString,
    fs::{File, OpenOptions, TryLockError},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, watch, Mutex as AsyncMutex},
};
use tokio_util::sync::CancellationToken;

const MAX_UPLOAD_BYTES: u64 = 100 * 1024 * 1024;
const MAX_PROFILES_PER_OWNER: usize = 16;
// Neither counts the caches the browser rebuilds on its own, which a used
// profile fills with hundreds of MB; browser-storage.cjs bounds those
// separately. What is left is logins, site storage, screenshots and downloads.
const OWNER_STORAGE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const PROFILE_STORAGE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_RUNNING_PROFILES_PER_OWNER: usize = 2;
const MAX_ACTIVE_PROFILES: usize = 6;
const PROFILE_MAX_LEN: usize = 64;

#[derive(Debug)]
pub struct BrowserOutput {
    pub structured: Value,
    pub attachments: Vec<(String, String)>,
}

#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserSetting {
    Read,
    Open,
    Select,
    Reset,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct BrowserSettingsError {
    pub code: String,
    pub message: String,
}
impl BrowserSettingsError {
    fn unavailable(message: &str) -> Self {
        Self {
            code: "browser_unavailable".into(),
            message: message.into(),
        }
    }
}

fn browser_limits() -> Value {
    json!({
        "profileStorageBytes": PROFILE_STORAGE_BYTES,
        "ownerStorageBytes": OWNER_STORAGE_BYTES,
        "maxProfilesPerOwner": MAX_PROFILES_PER_OWNER,
        "maxRunningProfilesPerOwner": MAX_RUNNING_PROFILES_PER_OWNER,
        "maxActiveProfiles": MAX_ACTIVE_PROFILES
    })
}

#[derive(Clone, Debug)]
struct BrowserProcess {
    pid: u32,
    identity: String,
}

#[derive(Clone, Debug)]
enum SetupState {
    Unknown,
    Installing,
    Ready,
    Failed {
        reason: String,
        retry_after: std::time::Instant,
    },
}

type BrowserProcesses = Arc<Mutex<HashMap<(String, String), Vec<BrowserProcess>>>>;

type PendingRequests =
    Arc<Mutex<HashMap<u64, oneshot::Sender<std::result::Result<Value, String>>>>>;

pub struct BrowserInvocation<'a> {
    pub owner: &'a str,
    pub invocation_action: &'a str,
    pub scope: &'a str,
    pub action: &'a str,
    pub profile: Option<&'a str>,
    pub args_json: &'a str,
    pub enabled_roots: &'a [String],
    pub data_dir: &'a Path,
    pub staging_dir: &'a Path,
    pub deadline: std::time::Instant,
    pub cancellation: &'a CancellationToken,
}

/// Only installed Plugin branding is exposed to its own sign-in screen.
/// Neither Plugin HTML nor arbitrary filesystem paths enter the handoff.
fn sign_in_brand(squire_home: &Path, owner: &str) -> (Option<String>, Option<String>) {
    if owner.is_empty()
        || owner.len() > 64
        || !owner
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return (None, None);
    }
    let directory = squire_home.join("plugins").join(owner);
    if !std::fs::symlink_metadata(&directory).is_ok_and(|meta| meta.file_type().is_dir()) {
        return (None, None);
    }
    let name = std::fs::read(directory.join("manifest.json"))
        .ok()
        .filter(|bytes| bytes.len() <= 64 * 1024)
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|manifest| manifest["name"].as_str().map(str::to_owned))
        .filter(|name| !name.is_empty() && name.len() <= 100);
    let icon = [
        ("icon-dark.svg", "image/svg+xml"),
        ("icon.svg", "image/svg+xml"),
        ("icon.png", "image/png"),
        ("icon.webp", "image/webp"),
        ("icon.jpg", "image/jpeg"),
        ("icon.jpeg", "image/jpeg"),
    ]
    .into_iter()
    .find_map(|(file, mime)| {
        let path = directory.join(file);
        if !std::fs::symlink_metadata(&path)
            .is_ok_and(|meta| meta.file_type().is_file() && meta.len() <= 64 * 1024)
        {
            return None;
        }
        let bytes = std::fs::read(path).ok()?;
        use base64::Engine;
        Some(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    });
    (name, icon)
}

pub struct BrowserService {
    squire_home: PathBuf,
    store: Arc<crate::store::Store>,
    command_path: OsString,
    owner_lock: Mutex<Option<File>>,
    initialized: AtomicBool,
    setup: Mutex<SetupState>,
    setup_updates: watch::Sender<SetupState>,
    chromium_setup: Mutex<SetupState>,
    chromium_updates: watch::Sender<SetupState>,
    supervisor: AsyncMutex<Option<Arc<Supervisor>>>,
    next_request: AtomicU64,
    browser_processes: BrowserProcesses,
    shutting_down: AtomicBool,
    frames: crate::browser_viewer::FrameChannels,
    desktop_events: tokio::sync::broadcast::Sender<Arc<str>>,
}

impl BrowserService {
    pub fn new(
        squire_home: PathBuf,
        command_path: OsString,
        store: Arc<crate::store::Store>,
        desktop_events: tokio::sync::broadcast::Sender<Arc<str>>,
    ) -> Self {
        Self {
            squire_home,
            store,
            command_path,
            owner_lock: Mutex::new(None),
            initialized: AtomicBool::new(false),
            setup: Mutex::new(SetupState::Unknown),
            setup_updates: watch::channel(SetupState::Unknown).0,
            chromium_setup: Mutex::new(SetupState::Unknown),
            chromium_updates: watch::channel(SetupState::Unknown).0,
            supervisor: AsyncMutex::new(None),
            next_request: AtomicU64::new(1),
            browser_processes: Arc::new(Mutex::new(HashMap::new())),
            shutting_down: AtomicBool::new(false),
            frames: Arc::new(Mutex::new(HashMap::new())),
            desktop_events,
        }
    }

    pub async fn invoke(
        self: &Arc<Self>,
        invocation: BrowserInvocation<'_>,
    ) -> std::result::Result<BrowserOutput, String> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("error=runtime_lost message=\"Squire is shutting down\"".into());
        }
        let BrowserInvocation {
            owner,
            invocation_action,
            scope,
            action,
            profile,
            args_json,
            enabled_roots,
            data_dir,
            staging_dir,
            deadline,
            cancellation,
        } = invocation;
        let shared = owner == "browser";
        self.ensure_ownership()?;
        let mut args: Map<String, Value> = serde_json::from_str(args_json).map_err(|error| {
            format!("error=invalid_argument message=\"invalid browser args-json: {error}\"")
        })?;
        if args.contains_key("profile") || args.contains_key("owner") {
            return Err(
                "error=invalid_argument message=\"browser args-json must not contain profile or owner\""
                    .into(),
            );
        }

        let profile = if shared {
            if profile.is_some() {
                return Err(
                    "error=invalid_argument message=\"Use tab handles, not profiles\"".into(),
                );
            }
            None
        } else if action == "list_profiles" {
            if profile.is_some() {
                return Err(
                    "error=invalid_argument message=\"list_profiles does not accept profile\""
                        .into(),
                );
            }
            None
        } else {
            let profile = profile.ok_or_else(|| {
                "error=invalid_argument message=\"profile is required\"".to_string()
            })?;
            validate_profile_name(profile)?;
            Some(profile)
        };

        self.wait_runtime(deadline, cancellation).await?;

        let owner_dir = data_dir.join(".browser");
        let profiles_dir = owner_dir.join("profiles");
        let profile_dir = profile.map(|name| profiles_dir.join(name));
        validate_browser_namespace(data_dir, &owner_dir, &profiles_dir, profile_dir.as_deref())?;

        let supervisor = self.supervisor().await?;
        if action == "upload" {
            let source = args
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| "error=invalid_argument message=\"path is required\"".to_string())?
                .to_string();
            let snapshot =
                snapshot_upload_source(&source, enabled_roots, data_dir, &owner_dir, staging_dir)?;
            args.insert(
                "path".to_string(),
                Value::String(snapshot.to_string_lossy().into_owned()),
            );
        }
        if matches!(action, "move_download" | "export_screenshot") {
            let destination = args
                .get("destination")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    "error=invalid_argument message=\"destination is required\"".to_string()
                })?;
            authorize_export(destination, enabled_roots, data_dir, &owner_dir)?;
        }

        let (plugin_name, plugin_icon) = if action == "sign_in_start" {
            sign_in_brand(&self.squire_home, owner)
        } else {
            (None, None)
        };
        let id = self.next_request.fetch_add(1, Ordering::Relaxed);
        let request = json!({
            "id": id,
            "kind": "action",
            "shared": shared,
            "scope": scope,
            "action": action,
            "owner": owner,
            "invocationAction": invocation_action,
            "pluginName": plugin_name,
            "pluginIcon": plugin_icon,
            "profile": profile,
            "ownerDir": owner_dir,
            "profileDir": profile_dir,
            "args": args,
            "stagingDir": staging_dir,
            "limits": browser_limits()
        });
        let response = self
            .request_with_chromium(&supervisor, request, deadline, cancellation)
            .await?;
        parse_supervisor_output(response)
    }

    /// Internal UI requests use only an already-running supervisor, never
    /// provision a runtime, start a profile, or accept guest-selected owners.
    pub(crate) async fn viewer_request(
        &self,
        mut request: Value,
    ) -> std::result::Result<Value, String> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("Browser stopped".into());
        }
        let supervisor = self
            .supervisor
            .lock()
            .await
            .clone()
            .ok_or("Browser not running")?;
        let id = self.next_request.fetch_add(1, Ordering::Relaxed);
        request["id"] = json!(id);
        request["kind"] = json!("viewer");
        let value = supervisor
            .request(
                request,
                id,
                std::time::Instant::now() + std::time::Duration::from_secs(10),
                &CancellationToken::new(),
            )
            .await?;
        parse_supervisor_output(value).map(|output| output.structured)
    }

    pub(crate) fn viewer_subscription(
        &self,
        tab: &str,
        lease: crate::browser_viewer::ViewerLease,
    ) -> Option<crate::browser_viewer::Subscription> {
        let frames = self.frames.lock().expect("browser frames");
        let channel = frames.get(tab)?;
        Some(crate::browser_viewer::Subscription {
            frames: channel.latest.subscribe(),
            lease,
        })
    }

    /// Desktop presence is a projection of the same tab/scope registry that
    /// authorizes cached thumbnails; never query Node for it again.
    pub(crate) fn viewer_presence(&self) -> Value {
        browser_presence(&self.frames)
    }

    pub(crate) fn viewer_thumbnail(&self, scope: &str, tab: &str) -> Option<Arc<Vec<u8>>> {
        let channels = self.frames.lock().expect("browser frames");
        let entry = channels.get(tab)?;
        if !entry.scopes.contains(scope) {
            return None;
        }
        let frame = entry.latest.borrow().clone();
        frame
    }

    /// One provisioner for each asset: concurrent invocations subscribe to
    /// completion instead of spinning or launching duplicate downloads.
    async fn wait_runtime(
        self: &Arc<Self>,
        deadline: std::time::Instant,
        cancellation: &CancellationToken,
    ) -> std::result::Result<(), String> {
        let updates = self.setup_updates.subscribe();
        if matches!(self.ensure_runtime().await?, RuntimeReadiness::Ready) {
            return Ok(());
        }
        wait_for_setup(
            updates,
            deadline,
            cancellation,
            "browser_runtime_unavailable",
            "Browser runtime is still installing; retry the action.",
        )
        .await
    }

    async fn wait_chromium(
        self: &Arc<Self>,
        deadline: std::time::Instant,
        cancellation: &CancellationToken,
    ) -> std::result::Result<(), String> {
        let updates = self.chromium_updates.subscribe();
        {
            let mut setup = self.chromium_setup.lock().unwrap();
            match &*setup {
                SetupState::Ready => return Ok(()),
                SetupState::Failed {
                    reason,
                    retry_after,
                } if std::time::Instant::now() < *retry_after => {
                    return Err(browser_setup_error("browser_install_failed", reason));
                }
                SetupState::Installing => {}
                SetupState::Unknown | SetupState::Failed { .. } => {
                    // A new explicit request may retry a transient failure
                    // after the cooldown, without multiplying installers.
                    *setup = SetupState::Installing;
                    self.chromium_updates.send_replace(SetupState::Installing);
                    let service = self.clone();
                    tokio::spawn(async move {
                        let outcome = crate::wasm_runtime_assets::install_managed_chromium(
                            &service.squire_home,
                        )
                        .await;
                        let state = match outcome {
                            Ok(()) => SetupState::Ready,
                            Err(error) => SetupState::Failed {
                                reason: format!("{error:#}"),
                                retry_after: std::time::Instant::now()
                                    + std::time::Duration::from_secs(30),
                            },
                        };
                        *service.chromium_setup.lock().unwrap() = state.clone();
                        service.chromium_updates.send_replace(state);
                    });
                }
            }
        }
        wait_for_setup(
            updates,
            deadline,
            cancellation,
            "browser_install_failed",
            "Chromium is still downloading; retry this action when installation finishes.",
        )
        .await
    }

    async fn request_with_chromium(
        self: &Arc<Self>,
        supervisor: &Arc<Supervisor>,
        request: Value,
        deadline: std::time::Instant,
        cancellation: &CancellationToken,
    ) -> std::result::Result<Value, String> {
        let id = request["id"]
            .as_u64()
            .ok_or_else(|| "browser request has no id".to_owned())?;
        let response = supervisor
            .request(request.clone(), id, deadline, cancellation)
            .await?;
        if response["ok"] != false
            || supervisor_error_code(&response) != Some("browser_install_required")
        {
            return Ok(response);
        }
        self.wait_chromium(deadline, cancellation).await?;
        let next_id = self.next_request.fetch_add(1, Ordering::Relaxed);
        let mut retry = request;
        retry["id"] = json!(next_id);
        // Re-read discovery only once after the successful installation.
        retry["refreshBrowsers"] = json!(true);
        supervisor
            .request(retry, next_id, deadline, cancellation)
            .await
    }

    pub async fn settings_action(
        self: &Arc<Self>,
        action: BrowserSetting,
        args: &Value,
    ) -> std::result::Result<Value, BrowserSettingsError> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(BrowserSettingsError::unavailable(
                "Squire is shutting down.",
            ));
        }
        self.ensure_ownership().map_err(|_| {
            BrowserSettingsError::unavailable(
                "Browser runtime is unavailable or in use by another Squire server.",
            )
        })?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let cancellation = CancellationToken::new();
        self.wait_runtime(deadline, &cancellation)
            .await
            .map_err(|reason| BrowserSettingsError::unavailable(&reason))?;
        let supervisor = self.supervisor().await.map_err(|_| {
            BrowserSettingsError::unavailable(
                "Browser runtime could not be started. Retry shortly.",
            )
        })?;
        let id = self.next_request.fetch_add(1, Ordering::Relaxed);
        let request = json!({
            "id": id, "kind": "settings", "action": action, "args": args,
            "owner": "browser", "ownerDir": self.squire_home.join("plugin-data/browser/.browser"),
            "limits": browser_limits()
        });
        let value = self
            .request_with_chromium(&supervisor, request, deadline, &cancellation)
            .await
            .map_err(|reason| BrowserSettingsError::unavailable(&reason))?;
        if value.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(
                serde_json::from_value(value["error"].clone()).unwrap_or_else(|_| {
                    BrowserSettingsError::unavailable("Browser request failed. Refresh settings.")
                }),
            );
        }
        value
            .pointer("/output/structuredContent")
            .cloned()
            .ok_or_else(|| {
                BrowserSettingsError::unavailable("Browser returned an invalid settings response.")
            })
    }

    /// Close Chromium before terminating its supervisor so cookies and site
    /// storage can flush. Drop remains a bounded emergency fallback.
    pub async fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
        if let Some(supervisor) = self.supervisor.lock().await.take() {
            supervisor.stdin.lock().await.take();
            let until = std::time::Instant::now() + std::time::Duration::from_secs(15);
            loop {
                let exited = supervisor
                    .child
                    .lock()
                    .expect("supervisor child poisoned")
                    .try_wait()
                    .is_ok_and(|status| status.is_some());
                if exited {
                    break;
                }
                if std::time::Instant::now() >= until {
                    supervisor.kill();
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        }
    }

    /// Called before Plugin files/data are removed. It intentionally does not
    /// acquire the browser ownership lock: a server that never owned the
    /// browser service must not signal another server's processes.
    pub fn remove_owner(&self, owner: &str) {
        if !self.initialized.load(Ordering::Acquire) {
            return;
        }

        // Hard-kill only browser roots whose identity was recorded for this
        // owner. Cleanup is best-effort: uninstall must not be held hostage by
        // an unverifiable or already-dead process.
        let _ = kill_verified_registry(&self.browser_processes, Some(owner));

        // Tell the supervisor to reject queued work and mark active work as
        // abandoned. Do not wait for in-flight operations while the Plugin
        // catalog mutex is held.
        let supervisor = self.supervisor.blocking_lock().clone();
        if let Some(supervisor) = supervisor.filter(|item| item.alive.load(Ordering::Acquire)) {
            let request = json!({"control": "remove_owner", "owner": owner});
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = supervisor.write(&request).await;
                });
            }
        }
    }

    /// Waits for the supervisor to discard this owner's contexts and queued
    /// operations before the data directory can be removed.
    pub async fn stop_owner(&self, owner: &str) -> std::result::Result<(), String> {
        let supervisor = self.supervisor.lock().await.clone();
        if let Some(supervisor) = supervisor.filter(|item| item.alive.load(Ordering::Acquire)) {
            let id = self.next_request.fetch_add(1, Ordering::Relaxed);
            supervisor
                .request(
                    json!({"id": id, "control": "remove_owner", "owner": owner}),
                    id,
                    std::time::Instant::now() + std::time::Duration::from_secs(30),
                    &CancellationToken::new(),
                )
                .await?;
        }
        kill_verified_registry(&self.browser_processes, Some(owner))
    }

    fn ensure_ownership(&self) -> std::result::Result<(), String> {
        if self.initialized.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut held = self.owner_lock.lock().unwrap();
        if held.is_none() {
            std::fs::create_dir_all(&self.squire_home)
                .map_err(|error| format!("browser runtime unavailable: {error}"))?;
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(self.squire_home.join("browser.lock"))
                .map_err(|error| format!("browser runtime unavailable: {error}"))?;
            match file.try_lock() {
                Ok(()) => *held = Some(file),
                Err(TryLockError::WouldBlock) => return Err(
                    "error=browser_runtime_unavailable message=\"in use by another Squire server\""
                        .into(),
                ),
                Err(TryLockError::Error(error)) => {
                    return Err(format!("browser runtime unavailable: {error}"))
                }
            }
            if let Err(error) = self.startup_cleanup() {
                *held = None;
                return Err(error);
            }
            self.initialized.store(true, Ordering::Release);
        }
        Ok(())
    }

    fn startup_cleanup(&self) -> std::result::Result<(), String> {
        // Kill legacy daemons before moving profile directories they may still
        // have open, then migrate and prune abandoned owner data.
        sweep_legacy_runtime_files(&self.squire_home)?;
        migrate_browser_profiles(&self.squire_home)?;
        remove_orphan_browser_data(&self.squire_home, &self.store)?;
        Ok(())
    }

    async fn ensure_runtime(self: &Arc<Self>) -> std::result::Result<RuntimeReadiness, String> {
        let mut setup = self.setup.lock().unwrap();
        match &*setup {
            SetupState::Ready => return Ok(RuntimeReadiness::Ready),
            SetupState::Installing => return Ok(RuntimeReadiness::Installing),
            SetupState::Failed {
                reason,
                retry_after,
            } => {
                if std::time::Instant::now() < *retry_after {
                    return Err(browser_setup_error("browser_runtime_unavailable", reason));
                }
                *setup = SetupState::Unknown;
            }
            SetupState::Unknown => {}
        }

        crate::wasm_runtime_assets::browser_driver_path(&self.squire_home)
            .map_err(|error| format!("browser runtime unavailable: {error:#}"))?;
        if crate::wasm_runtime_assets::browser_runtime_ready(&self.squire_home) {
            *setup = SetupState::Ready;
            self.setup_updates.send_replace(SetupState::Ready);
            return Ok(RuntimeReadiness::Ready);
        }
        *setup = SetupState::Installing;
        self.setup_updates.send_replace(SetupState::Installing);
        drop(setup);

        let service = self.clone();
        tokio::task::spawn_blocking(move || {
            let outcome = crate::wasm_runtime_assets::install_browser_runtime(&service.squire_home);
            let state = match outcome {
                Ok(()) => SetupState::Ready,
                Err(error) => SetupState::Failed {
                    reason: format!("{error:#}"),
                    retry_after: std::time::Instant::now() + std::time::Duration::from_secs(30),
                },
            };
            *service.setup.lock().unwrap() = state.clone();
            service.setup_updates.send_replace(state);
        });
        Ok(RuntimeReadiness::Installing)
    }

    async fn supervisor(self: &Arc<Self>) -> std::result::Result<Arc<Supervisor>, String> {
        let mut slot = self.supervisor.lock().await;
        if let Some(supervisor) = slot
            .as_ref()
            .filter(|item| item.alive.load(Ordering::Acquire))
        {
            return Ok(supervisor.clone());
        }
        if slot.is_some() {
            *slot = None;
        }
        let supervisor = Arc::new(
            Supervisor::spawn(
                &self.squire_home,
                &self.command_path,
                self.browser_processes.clone(),
                self.frames.clone(),
                self.desktop_events.clone(),
            )
            .await
            .map_err(|error| format!("error=browser_runtime_unavailable message={error}"))?,
        );
        *slot = Some(supervisor.clone());
        Ok(supervisor)
    }
}

impl Drop for BrowserService {
    fn drop(&mut self) {
        if let Some(supervisor) = self.supervisor.get_mut().take() {
            supervisor.kill();
        }
        let _ = kill_verified_registry(&self.browser_processes, None);
    }
}

fn browser_setup_error(code: &str, message: &str) -> String {
    format!(
        "error={code} message={}",
        serde_json::to_string(message).unwrap_or_else(|_| "\"browser setup failed\"".into())
    )
}

async fn wait_for_setup(
    mut updates: watch::Receiver<SetupState>,
    deadline: std::time::Instant,
    cancellation: &CancellationToken,
    failure_code: &str,
    pending_message: &str,
) -> std::result::Result<(), String> {
    loop {
        let state = updates.borrow_and_update().clone();
        match state {
            SetupState::Ready => return Ok(()),
            SetupState::Failed { reason, .. } => {
                return Err(browser_setup_error(failure_code, &reason));
            }
            SetupState::Unknown | SetupState::Installing => {}
        }
        tokio::select! {
            _ = cancellation.cancelled() => return Err("invocation cancelled".into()),
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) =>
                return Err(browser_setup_error("browser_installing", pending_message)),
            changed = updates.changed() => {
                if changed.is_err() {
                    return Err(browser_setup_error(failure_code, "installer stopped unexpectedly"));
                }
            }
        }
    }
}

fn supervisor_error_code(response: &Value) -> Option<&str> {
    response["code"]
        .as_str()
        .or_else(|| response.pointer("/error/code").and_then(Value::as_str))
}

enum RuntimeReadiness {
    Installing,
    Ready,
}

/// One tab belongs to each attached conversation at most once. Thread counts
/// represent tabs (not viewers) and do not require page.title() calls.
fn browser_presence(frames: &crate::browser_viewer::FrameChannels) -> Value {
    let mut conversations = std::collections::BTreeSet::<String>::new();
    let mut threads = std::collections::BTreeMap::<String, usize>::new();
    let entries = frames.lock().expect("browser frames");
    for entry in entries.values() {
        for scope in &entry.scopes {
            if let Some(id) = scope.strip_prefix("conversation:") {
                conversations.insert(id.to_owned());
            } else if let Some(id) = scope.strip_prefix("thread:") {
                *threads.entry(id.to_owned()).or_default() += 1;
            }
        }
    }
    json!({
        "conversations": conversations,
        "threads": threads.into_iter().map(|(id, count)| json!({"id":id,"count":count})).collect::<Vec<_>>()
    })
}

/// One tab lifecycle event updates the cache and notifies desktop subscribers.
fn apply_browser_tab_event(
    frames: &crate::browser_viewer::FrameChannels,
    desktop_events: &tokio::sync::broadcast::Sender<Arc<str>>,
    event: &str,
    value: &Value,
) {
    let Some(tab) = value["tab"].as_str().filter(|tab| !tab.is_empty()) else {
        return;
    };
    let scopes: Vec<String> = value["scopes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item.as_str().map(str::to_owned))
        .collect();
    {
        let mut active = frames.lock().expect("browser frames");
        if event == "tab_invalidated" {
            active.remove(tab); // Dropping the sender ends every active viewer.
        } else {
            // A delayed navigation event must not resurrect a closed tab.
            if event == "tab_updated" && !active.contains_key(tab) {
                return;
            }
            let entry = active
                .entry(tab.to_owned())
                .or_insert_with(crate::browser_viewer::TabFrames::new);
            if event == "tab_registered" {
                entry.scopes = scopes.iter().cloned().collect();
            } else {
                entry.scopes.extend(scopes.iter().cloned());
            }
        }
    }
    if desktop_events.receiver_count() > 0 {
        for scope in scopes {
            let message = json!({
                "type":"browser.tabs.changed",
                "scope":scope,
                "metadataOnly":event == "tab_updated",
            })
            .to_string();
            let _ = desktop_events.send(Arc::from(message));
        }
    }
}

struct Supervisor {
    stdin: AsyncMutex<Option<ChildStdin>>,
    child: Mutex<Child>,
    pending: PendingRequests,
    alive: Arc<AtomicBool>,
}

impl Supervisor {
    async fn spawn(
        squire_home: &Path,
        command_path: &OsString,
        browser_processes: BrowserProcesses,
        frames: crate::browser_viewer::FrameChannels,
        desktop_events: tokio::sync::broadcast::Sender<Arc<str>>,
    ) -> Result<Self> {
        cleanup_private_browser_artifacts(squire_home).map_err(anyhow::Error::msg)?;
        let driver = crate::wasm_runtime_assets::browser_driver_path(squire_home)?;
        let lock_helper = crate::wasm_runtime_assets::lock_helper_path()?;
        let node = crate::node_runtime::path(squire_home);
        let log_dir = squire_home.join("logs");
        std::fs::create_dir_all(&log_dir)?;
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("browser-supervisor.log"))?;
        let error_log = log.try_clone()?;
        let mut command = Command::new(node);
        crate::util::hide_console(command.as_std_mut());
        command
            .arg(driver)
            .arg("supervisor")
            .env("PATH", command_path)
            .env("SQUIRE_BROWSER_LOCK_HELPER", lock_helper)
            .env(
                "SQUIRE_MANAGED_CHROMIUM",
                crate::wasm_runtime_assets::managed_chromium_executable(squire_home)
                    .unwrap_or_default(),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(error_log));
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.as_std_mut().process_group(0);
        }
        let mut child = command
            .spawn()
            .context("failed to start browser supervisor")?;
        let supervisor_pid = child.id();
        let stdin = child
            .stdin
            .take()
            .context("browser supervisor stdin missing")?;
        let stdout = child
            .stdout
            .take()
            .context("browser supervisor stdout missing")?;
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let reader_pending = pending.clone();
        let reader_alive = alive.clone();
        let reader_processes = browser_processes;
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(event) = value.get("event").and_then(Value::as_str) {
                    if event == "viewer_frame" {
                        if let (Some(tab), Some(data), Some(width), Some(height)) = (
                            value["tab"].as_str(),
                            value["data"].as_str(),
                            value["viewport"]["width"].as_u64(),
                            value["viewport"]["height"].as_u64(),
                        ) {
                            // Only Node controls the encoded JPEG budget. Bad
                            // frames are skipped instead of closing subscribers.
                            use base64::Engine;
                            if let (Ok(w), Ok(h), Ok(jpeg)) = (
                                u32::try_from(width),
                                u32::try_from(height),
                                base64::engine::general_purpose::STANDARD.decode(data),
                            ) {
                                if w > 0 && h > 0 {
                                    let mut bytes = Vec::with_capacity(8 + jpeg.len());
                                    bytes.extend_from_slice(&w.to_be_bytes());
                                    bytes.extend_from_slice(&h.to_be_bytes());
                                    bytes.extend_from_slice(&jpeg);
                                    if let Some(entry) =
                                        frames.lock().expect("browser frames").get(tab)
                                    {
                                        entry.latest.send_replace(Some(Arc::new(bytes)));
                                    }
                                }
                            }
                        }
                        continue;
                    }
                    if matches!(
                        event,
                        "tab_registered" | "tab_scope_attached" | "tab_updated" | "tab_invalidated"
                    ) {
                        apply_browser_tab_event(&frames, &desktop_events, event, &value);
                        continue;
                    }
                    if let (Some(owner), Some(profile)) = (
                        value.get("owner").and_then(Value::as_str),
                        value.get("profile").and_then(Value::as_str),
                    ) {
                        let key = (owner.to_string(), profile.to_string());
                        if event == "profile_started" {
                            let processes = value
                                .get("processes")
                                .and_then(Value::as_array)
                                .into_iter()
                                .flatten()
                                .filter_map(|record| {
                                    Some(BrowserProcess {
                                        pid: u32::try_from(record.get("pid")?.as_u64()?).ok()?,
                                        identity: record.get("identity")?.as_str()?.to_string(),
                                    })
                                })
                                .collect::<Vec<_>>();
                            reader_processes.lock().unwrap().insert(key, processes);
                            continue;
                        }
                        if event == "profile_stopped" {
                            reader_processes.lock().unwrap().remove(&key);
                            continue;
                        }
                    }
                }
                let Some(id) = value.get("id").and_then(Value::as_u64) else {
                    continue;
                };
                if let Some(sender) = reader_pending.lock().unwrap().remove(&id) {
                    let _ = sender.send(Ok(value));
                }
            }
            // A supervisor crash invalidates every cached tab/stream and
            // wakes every subscriber, even if the old event queue was full.
            {
                let mut active = frames.lock().expect("browser frames");
                // None after an active subscription signals host failure, not a
                // user-closed tab. The reader distinguishes it from sender drop.
                for entry in active.values() {
                    entry.latest.send_replace(None);
                }
                active.clear();
            }
            if desktop_events.receiver_count() > 0 {
                let _ = desktop_events.send(Arc::from(r#"{"type":"browser.tabs.changed"}"#));
            }
            if let Some(pid) = supervisor_pid {
                kill_supervisor_tree(pid);
            }
            let _ = kill_verified_registry(&reader_processes, None);
            // Admit a replacement only after the predecessor's browsers have
            // stopped; its private directories can then be safely reclaimed.
            reader_alive.store(false, Ordering::Release);
            for (_, sender) in reader_pending.lock().unwrap().drain() {
                let _ = sender.send(Err(
                    "error=daemon_unavailable message=\"browser supervisor exited; action result may be unknown\""
                        .into(),
                ));
            }
        });
        Ok(Self {
            stdin: AsyncMutex::new(Some(stdin)),
            child: Mutex::new(child),
            pending,
            alive,
        })
    }

    async fn request(
        &self,
        request: Value,
        id: u64,
        deadline: std::time::Instant,
        cancellation: &CancellationToken,
    ) -> std::result::Result<Value, String> {
        if !self.alive.load(Ordering::Acquire) {
            return Err(
                "error=daemon_unavailable message=\"browser supervisor is not running\"".into(),
            );
        }
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, sender);
        if let Err(error) = self.write(&request).await {
            self.pending.lock().unwrap().remove(&id);
            return Err(error);
        }
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                self.pending.lock().unwrap().remove(&id);
                let _ = self.write(&json!({"cancel": id})).await;
                Err("invocation cancelled".into())
            }
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
                self.pending.lock().unwrap().remove(&id);
                let _ = self.write(&json!({"cancel": id})).await;
                Err("invocation deadline expired".into())
            }
            result = receiver => {
                result.map_err(|_| "error=daemon_unavailable message=\"browser supervisor response channel closed\"".to_string())?
            }
        }
    }

    async fn write(&self, value: &Value) -> std::result::Result<(), String> {
        let encoded = serde_json::to_vec(value).map_err(|error| error.to_string())?;
        let mut pipe = self.stdin.lock().await;
        let stdin = pipe.as_mut().ok_or_else(|| {
            "error=runtime_lost message=\"Browser supervisor stopped\"".to_string()
        })?;
        stdin
            .write_all(&encoded)
            .await
            .map_err(|error| format!("error=daemon_unavailable message=\"failed to write browser supervisor request: {error}\""))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|error| format!("error=daemon_unavailable message=\"failed to write browser supervisor request: {error}\""))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("error=daemon_unavailable message=\"failed to flush browser supervisor request: {error}\""))
    }

    fn kill(&self) {
        self.alive.store(false, Ordering::Release);
        let mut child = self.child.lock().unwrap();
        if let Some(pid) = child.id() {
            kill_supervisor_tree(pid);
        }
        let _ = child.start_kill();
    }
}

fn parse_supervisor_output(value: Value) -> std::result::Result<BrowserOutput, String> {
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("browser action failed")
            .to_string());
    }
    let output = value
        .get("output")
        .and_then(Value::as_object)
        .ok_or_else(|| "browser supervisor returned malformed output".to_string())?;
    let structured = output
        .get("structuredContent")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or_else(|| "browser supervisor returned malformed structuredContent".to_string())?;
    let attachments = output
        .get("attachments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|attachment| {
            Some((
                attachment.get("path")?.as_str()?.to_string(),
                attachment.get("mimeType")?.as_str()?.to_string(),
            ))
        })
        .collect();
    Ok(BrowserOutput {
        structured,
        attachments,
    })
}

fn validate_profile_name(profile: &str) -> std::result::Result<(), String> {
    if profile.is_empty()
        || profile.len() > PROFILE_MAX_LEN
        || matches!(profile, "." | "..")
        || !profile
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(
            "error=invalid_argument message=\"profile must match [A-Za-z0-9._-]{1,64}, excluding . and ..\""
                .into(),
        );
    }
    Ok(())
}

fn authorize_export(
    destination: &str,
    roots: &[String],
    data_dir: &Path,
    browser_dir: &Path,
) -> std::result::Result<(), String> {
    let destination = PathBuf::from(destination);
    if !destination.is_absolute() {
        return Err("error=invalid_argument message=\"destination must be absolute\"".into());
    }
    if destination.exists() {
        return Err("error=destination_exists message=\"destination already exists\"".into());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "destination has no parent".to_string())?
        .canonicalize()
        .map_err(|error| format!("destination parent is not accessible: {error}"))?;
    validate_allowed_location(
        &parent,
        &destination,
        roots,
        data_dir,
        browser_dir,
        "destination",
    )
}

fn validate_allowed_location(
    canonical: &Path,
    original: &Path,
    roots: &[String],
    data_dir: &Path,
    browser_dir: &Path,
    noun: &str,
) -> std::result::Result<(), String> {
    let browser = browser_dir.canonicalize().ok();
    if browser
        .as_ref()
        .is_some_and(|root| canonical.starts_with(root))
        || original.starts_with(browser_dir)
    {
        return Err(format!(
            "error=invalid_argument message=\"{noun} cannot be inside reserved .browser data\""
        ));
    }
    let data = data_dir.canonicalize().ok();
    let root_allowed = roots.iter().any(|root| {
        Path::new(root)
            .canonicalize()
            .ok()
            .is_some_and(|root| canonical.starts_with(root))
    });
    let data_allowed = data.is_some_and(|root| canonical.starts_with(root));
    if !root_allowed && !data_allowed {
        return Err(format!(
            "error=invalid_argument message=\"{noun} must be inside an enabled root or the calling Plugin data directory\""
        ));
    }
    Ok(())
}

fn authorize_upload_source(
    source: &str,
    roots: &[String],
    data_dir: &Path,
    browser_dir: &Path,
) -> std::result::Result<(), String> {
    let source = PathBuf::from(source);
    if !source.is_absolute() {
        return Err("error=invalid_argument message=\"path must be absolute\"".into());
    }
    let metadata = std::fs::symlink_metadata(&source)
        .map_err(|error| format!("upload source is not accessible: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err(
            "error=invalid_argument message=\"upload source must not be a symlink\"".into(),
        );
    }
    if !metadata.is_file() {
        return Err("error=invalid_argument message=\"upload source must be a file\"".into());
    }
    if metadata.len() > MAX_UPLOAD_BYTES {
        return Err(format!(
            "error=upload_too_large message=\"upload source exceeds the maximum size of {MAX_UPLOAD_BYTES} bytes\""
        ));
    }
    let canonical = source
        .canonicalize()
        .map_err(|error| format!("upload source is not accessible: {error}"))?;
    validate_allowed_location(
        &canonical,
        &source,
        roots,
        data_dir,
        browser_dir,
        "upload source",
    )
}

fn snapshot_upload_source(
    source: &str,
    roots: &[String],
    data_dir: &Path,
    browser_dir: &Path,
    staging_dir: &Path,
) -> std::result::Result<PathBuf, String> {
    authorize_upload_source(source, roots, data_dir, browser_dir)?;
    let source_path = PathBuf::from(source);
    let mut input = std::fs::File::open(&source_path)
        .map_err(|error| format!("upload source is not accessible: {error}"))?;
    // Re-check the open file, then stream a bounded private copy so a later
    // replacement of the source pathname cannot change what is uploaded.
    let opened = input
        .metadata()
        .map_err(|error| format!("upload source is not accessible: {error}"))?;
    if !opened.is_file() {
        return Err("error=invalid_argument message=\"upload source must be a file\"".into());
    }
    if opened.len() > MAX_UPLOAD_BYTES {
        return Err(format!(
            "error=upload_too_large message=\"upload source exceeds the maximum size of {MAX_UPLOAD_BYTES} bytes\""
        ));
    }
    std::fs::create_dir_all(staging_dir)
        .map_err(|error| format!("upload staging is unavailable: {error}"))?;
    let basename = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .unwrap_or("upload");
    let safe_basename: String = basename
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | ' ') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let token: u64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0)
        .wrapping_add(std::process::id() as u64);
    let candidate = staging_dir.join(format!("upload-{token:x}-{safe_basename}"));
    let mut output = std::fs::File::create_new(&candidate)
        .map_err(|error| format!("upload staging is unavailable: {error}"))?;
    let mut remaining = MAX_UPLOAD_BYTES;
    let mut buffer = [0u8; 8192];
    loop {
        use std::io::Read;
        let read = input
            .read(&mut buffer)
            .map_err(|error| format!("upload source is not accessible: {error}"))?;
        if read == 0 {
            break;
        }
        if (read as u64) > remaining {
            drop(output);
            let _ = std::fs::remove_file(&candidate);
            return Err(format!(
                "error=upload_too_large message=\"upload source exceeds the maximum size of {MAX_UPLOAD_BYTES} bytes\""
            ));
        }
        use std::io::Write;
        output
            .write_all(&buffer[..read])
            .map_err(|error| format!("upload staging is unavailable: {error}"))?;
        remaining -= read as u64;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o600));
    }
    Ok(candidate)
}

fn validate_browser_namespace(
    data_dir: &Path,
    owner_dir: &Path,
    profiles_dir: &Path,
    profile_dir: Option<&Path>,
) -> std::result::Result<(), String> {
    fn reject_symlink(path: &Path) -> std::result::Result<(), String> {
        match std::fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
                "error=invalid_argument message=\"reserved browser path {} must not be a symlink\"",
                path.display()
            )),
            Ok(_) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("failed to inspect {}: {error}", path.display())),
        }
    }

    reject_symlink(data_dir)?;
    reject_symlink(owner_dir)?;
    reject_symlink(profiles_dir)?;
    if let Some(profile_dir) = profile_dir {
        reject_symlink(profile_dir)?;
    }

    Ok(())
}

fn reject_browser_symlink(path: &Path) -> Result<()> {
    if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        anyhow::bail!("browser storage must not be a symlink: {}", path.display());
    }
    Ok(())
}

fn migrate_browser_profiles(squire_home: &Path) -> std::result::Result<(), String> {
    (|| -> Result<()> {
        let data = squire_home.join("plugin-data/browser");
        let browser = data.join(".browser");
        let profiles = browser.join("profiles");
        let archive = browser.join("legacy");
        let marker = browser.join("shared-session-v2");
        let layouts = [
            (data.join("profiles"), "plugin-profiles"),
            (profiles.clone(), "host-profiles"),
        ];
        for path in [&data, &browser, &profiles, &archive, &marker, &layouts[0].0] {
            reject_browser_symlink(path)?;
        }
        if std::fs::read_to_string(&marker).ok().as_deref() == Some("2\n") {
            return Ok(());
        }
        let authenticated = profiles.join("authenticated");
        let mut candidates = Vec::new();
        for (root, layout) in &layouts {
            if !root.exists() {
                continue;
            }
            for entry in std::fs::read_dir(root)? {
                let entry = entry?;
                reject_browser_symlink(&entry.path())?;
                if !entry.file_type()?.is_dir() {
                    continue;
                }
                let path = entry.path();
                reject_browser_symlink(&path.join("profile.json"))?;
                let metadata = std::fs::read(path.join("profile.json"))
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
                let valid = metadata.as_ref().is_some_and(|value| {
                    value["schemaVersion"] == 1
                        && value["browser"].is_object()
                        && value["viewport"].is_object()
                });
                let last_used = metadata
                    .as_ref()
                    .and_then(|value| value["lastUsed"].as_str())
                    .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                    .map(|value| value.timestamp_millis())
                    .unwrap_or(i64::MIN);
                candidates.push((path, *layout, valid, last_used));
            }
        }
        if !authenticated.exists() {
            if let Some((selected, _, _, _)) = candidates
                .iter()
                .filter(|(_, _, valid, _)| *valid)
                .max_by(|a, b| a.3.cmp(&b.3).then_with(|| a.0.cmp(&b.0)))
            {
                std::fs::create_dir_all(&profiles)?;
                std::fs::rename(selected, &authenticated)?;
            }
        }
        if authenticated.exists() {
            let file = authenticated.join("profile.json");
            let backup = authenticated.join("profile.pre-shared.json");
            reject_browser_symlink(&backup)?;
            // Keep the original metadata too, so the adopted directory can be restored.
            if !backup.exists() {
                std::fs::copy(&file, &backup)?;
            }
            let mut metadata: Value = serde_json::from_slice(&std::fs::read(&backup)?)?;
            metadata["profile"] = json!("authenticated");
            if let Some(executable) = metadata
                .pointer("/browser/executablePath")
                .or_else(|| metadata.pointer("/browser/canonicalPath"))
                .and_then(Value::as_str)
                .map(str::to_owned)
            {
                metadata["executable"] = json!(executable);
            }
            metadata
                .as_object_mut()
                .context("invalid profile metadata")?
                .remove("tabs");
            crate::wasm_runtime_assets::atomic_write(&file, &serde_json::to_vec(&metadata)?)?;
            let settings = browser.join("settings.json");
            reject_browser_symlink(&settings)?;
            if !settings.exists() {
                if let Some(executable) = metadata
                    .pointer("/browser/executablePath")
                    .or_else(|| metadata.pointer("/browser/canonicalPath"))
                    .and_then(Value::as_str)
                {
                    crate::wasm_runtime_assets::atomic_write(
                        &settings,
                        &serde_json::to_vec(&json!({"executable":executable}))?,
                    )?;
                }
            }
        }
        for (source, layout, _, _) in candidates {
            if !source.exists() || source.canonicalize().ok() == authenticated.canonicalize().ok() {
                continue;
            }
            let directory = archive.join(layout);
            reject_browser_symlink(&directory)?;
            std::fs::create_dir_all(&directory)?;
            let destination = directory.join(source.file_name().context("profile name missing")?);
            if destination.exists() {
                anyhow::bail!("legacy archive already exists: {}", destination.display());
            }
            std::fs::rename(source, destination)?;
        }
        crate::wasm_runtime_assets::atomic_write(&marker, b"2\n")?;
        Ok(())
    })()
    .map_err(|error| format!("browser migration failed: {error:#}"))
}

// Runs once before every supervisor spawn, after its predecessor is fully stopped.
// This is the only owner of crash cleanup; Node only removes live contexts' artifacts.
fn cleanup_private_browser_artifacts(squire_home: &Path) -> std::result::Result<(), String> {
    (|| -> Result<()> {
        let data = squire_home.join("plugin-data/browser");
        let browser = data.join(".browser");
        let artifacts = browser.join("private-artifacts");
        for path in [&data, &browser, &artifacts] {
            reject_browser_symlink(path)?;
        }
        if artifacts.exists() {
            std::fs::remove_dir_all(&artifacts)?;
        }
        Ok(())
    })()
    .map_err(|error| format!("private browser cleanup failed: {error:#}"))
}

fn remove_orphan_browser_data(
    squire_home: &Path,
    store: &crate::store::Store,
) -> std::result::Result<(), String> {
    let installed = store
        .read_blocking(|db| {
            Ok(db
                .prepare("SELECT id FROM plugins")?
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .map_err(|e| e.to_string())?;
    if installed.is_empty()
        && !store
            .read_blocking(|db| {
                Ok(db
                    .prepare("SELECT 1 FROM meta WHERE key='plugin_index_initialized'")?
                    .exists([])?)
            })
            .map_err(|e| e.to_string())?
    {
        return Ok(());
    }
    let data_root = squire_home.join("plugin-data");
    let entries = match std::fs::read_dir(&data_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("failed to inspect Plugin data: {error}")),
    };
    for entry in entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
    {
        let owner = entry.file_name().to_string_lossy().into_owned();
        if owner != "browser" && !installed.contains(&owner) {
            let browser = entry.path().join(".browser");
            match std::fs::symlink_metadata(&browser) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    std::fs::remove_file(&browser).map_err(|error| {
                        format!("failed to remove orphan browser symlink: {error}")
                    })?;
                }
                Ok(_) => {
                    std::fs::remove_dir_all(&browser).map_err(|error| {
                        format!("failed to remove orphan browser data: {error}")
                    })?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!("failed to inspect orphan browser data: {error}"))
                }
            }
        }
    }
    Ok(())
}

/// Old browser versions recorded daemon/browser PIDs together with a process
/// start identity. On first browser use after upgrade, kill only a PID whose
/// current identity exactly matches the recorded value. A live PID whose
/// identity cannot be read is left untouched and blocks startup rather than
/// risking signaling a reused PID.
fn sweep_legacy_runtime_files(squire_home: &Path) -> std::result::Result<(), String> {
    let data_root = squire_home.join("plugin-data");
    let owners = match std::fs::read_dir(data_root) {
        Ok(owners) => owners,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("failed to inspect legacy browser state: {error}")),
    };
    for owner in owners
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
    {
        let owner_path = owner.path();
        let browser = owner_path.join(".browser");
        let mut profile_roots = vec![browser.join("profiles")];
        // Before the core migration, only the built-in Browser plugin used the
        // legacy `plugin-data/browser/profiles` location. Sweep it in place so
        // a live legacy daemon is stopped before that directory is renamed.
        if owner.file_name() == "browser" {
            profile_roots.push(owner_path.join("profiles"));
        }

        for profiles in profile_roots {
            if [&browser, &profiles].iter().any(|path| {
                std::fs::symlink_metadata(path)
                    .is_ok_and(|metadata| metadata.file_type().is_symlink())
            }) {
                continue;
            }
            let entries = match std::fs::read_dir(&profiles) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(format!(
                        "failed to inspect legacy browser profiles: {error}"
                    ))
                }
            };
            for profile in entries
                .flatten()
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            {
                for file in ["runtime.json", "runtime.lock"] {
                    let path = profile.path().join(file);
                    let record = match std::fs::read_to_string(&path) {
                        Ok(text) => serde_json::from_str::<Value>(&text).map_err(|error| {
                            format!("failed to parse {}: {error}", path.display())
                        })?,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(error) => {
                            return Err(format!("failed to read {}: {error}", path.display()))
                        }
                    };
                    for (pid_field, identity_field) in [
                        ("daemonPid", "daemonProcessStartIdentity"),
                        ("browserPid", "browserProcessStartIdentity"),
                        ("launcherPid", "launcherProcessStartIdentity"),
                    ] {
                        let Some(pid) = record.get(pid_field).and_then(Value::as_u64) else {
                            continue;
                        };
                        let Ok(pid) = u32::try_from(pid) else {
                            continue;
                        };
                        let Some(expected) = record.get(identity_field).and_then(Value::as_str)
                        else {
                            if process_alive(pid) {
                                return Err(format!(
                                    "legacy browser process {pid} is live but has no verifiable start identity"
                                ));
                            }
                            continue;
                        };
                        match process_identity(pid)? {
                            ProcessIdentity::Dead => {}
                            ProcessIdentity::Known(actual) if same_identity(&actual, expected) => {
                                kill_owned_process_tree(pid)
                            }
                            ProcessIdentity::Known(_) => {
                                // PID reuse: the recorded process is gone. Never
                                // signal the unrelated current process.
                            }
                            ProcessIdentity::Unknown => {
                                return Err(format!(
                                    "legacy browser process {pid} is live but its start identity could not be verified"
                                ));
                            }
                        }
                    }
                    std::fs::remove_file(&path)
                        .map_err(|error| format!("failed to remove {}: {error}", path.display()))?;
                }
            }
        }
    }
    Ok(())
}

fn kill_verified_registry(
    registry: &BrowserProcesses,
    owner: Option<&str>,
) -> std::result::Result<(), String> {
    let selected = {
        let registry = registry.lock().unwrap();
        registry
            .iter()
            .filter(|((candidate, _), _)| owner.is_none_or(|owner| candidate == owner))
            .map(|(key, records)| (key.clone(), records.clone()))
            .collect::<Vec<_>>()
    };
    for (_, records) in &selected {
        for record in records {
            match process_identity(record.pid)? {
                ProcessIdentity::Dead => {}
                ProcessIdentity::Known(actual) if same_identity(&actual, &record.identity) => {
                    kill_owned_process_tree(record.pid)
                }
                ProcessIdentity::Known(_) => {
                    // PID reuse. The recorded browser process is gone; never
                    // signal the unrelated current process.
                }
                ProcessIdentity::Unknown => {
                    // Never signal an unverifiable PID. Registry cleanup is
                    // best-effort; the server-level ownership lock prevents a
                    // second Squire process from claiming this runtime.
                }
            }
        }
    }
    let mut registry = registry.lock().unwrap();
    for (key, _) in selected {
        registry.remove(&key);
    }
    Ok(())
}

/// Whether `actual`, read now, is the process the browser runtime recorded as
/// `recorded`. Elsewhere both come from the same `ps` output; on Windows the
/// runtime records `seconds|exe` through PowerShell and Squire reads it
/// through sysinfo, so paths compare as Windows does, without case.
fn same_identity(actual: &str, recorded: &str) -> bool {
    if cfg!(windows) {
        same_windows_identity(actual, recorded)
    } else {
        actual == recorded
    }
}

/// Two `seconds|exe` identities ([`system_process`]) name the same process:
/// the same creation second and executable. Both sides floor the creation
/// time Windows keeps for the process, so the seconds match exactly; a PID
/// reused within that second by the same executable is the one case left.
/// Two `seconds|exe` identities name a process started in the same second. With
/// the PID that already identifies it; the path is left out because it changes
/// under a running program: the Windows installer renames the running
/// `squire.exe` to `squire.old.exe` during an update, and Windows then reports
/// the new name.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn same_process_start(actual: &str, recorded: &str) -> bool {
    let start = |identity: &str| {
        identity
            .trim()
            .split('|')
            .next()?
            .trim()
            .parse::<u64>()
            .ok()
    };
    matches!((start(actual), start(recorded)), (Some(a), Some(b)) if a == b)
}

pub(crate) fn same_windows_identity(actual: &str, recorded: &str) -> bool {
    let parse = |identity: &str| {
        let (seconds, exe) = identity.trim().split_once('|')?;
        let seconds = seconds.trim().parse::<u64>().ok()?;
        let exe = exe.trim();
        (!exe.is_empty()).then(|| (seconds, exe.to_string()))
    };
    match (parse(actual), parse(recorded)) {
        (Some((actual_start, actual_exe)), Some((recorded_start, recorded_exe))) => {
            actual_start == recorded_start && actual_exe.eq_ignore_ascii_case(&recorded_exe)
        }
        _ => false,
    }
}

#[derive(Debug)]
enum ProcessIdentity {
    Dead,
    Known(String),
    /// Alive, but `ps` could not say what it is. Windows reads every process
    /// directly, so there it is never unknown.
    #[cfg_attr(windows, allow(dead_code))]
    Unknown,
}

fn process_identity(pid: u32) -> std::result::Result<ProcessIdentity, String> {
    #[cfg(windows)]
    return Ok(match system_process(pid) {
        Some(identity) => ProcessIdentity::Known(identity),
        None => ProcessIdentity::Dead,
    });
    #[cfg(not(windows))]
    unix_process_identity(pid)
}

#[cfg(not(windows))]
fn unix_process_identity(pid: u32) -> std::result::Result<ProcessIdentity, String> {
    if !process_alive(pid) {
        return Ok(ProcessIdentity::Dead);
    }
    #[cfg(unix)]
    let output = std::process::Command::new(procps_tool("/bin", "ps"))
        .args(["-p", &pid.to_string(), "-o", "lstart=", "-o", "comm="])
        .output();
    #[cfg(not(unix))]
    let output: std::io::Result<std::process::Output> = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "process identity unsupported",
    ));

    match output {
        Ok(output) if output.status.success() => {
            let identity = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if identity.is_empty() {
                Ok(ProcessIdentity::Unknown)
            } else {
                Ok(ProcessIdentity::Known(identity))
            }
        }
        Ok(_) if !process_alive(pid) => Ok(ProcessIdentity::Dead),
        Ok(_) | Err(_) => Ok(ProcessIdentity::Unknown),
    }
}

fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let Ok(pid) = i32::try_from(pid) else {
            return false;
        };
        unsafe {
            if libc::kill(pid, 0) == 0 {
                return true;
            }
            std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
        }
    }
    #[cfg(windows)]
    {
        system_process(pid).is_some()
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        false
    }
}

/// A running process's start time and executable, read directly from the
/// system rather than by starting PowerShell for every check. `None` once it
/// has exited.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn system_process(pid: u32) -> Option<String> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::Always),
    );
    let process = system.process(pid)?;
    Some(format!(
        "{}|{}",
        process.start_time(),
        process
            .exe()
            .map(|exe| exe.display().to_string())
            .unwrap_or_default()
    ))
}

fn kill_supervisor_tree(pid: u32) {
    #[cfg(windows)]
    crate::wasm_processes::kill_tree_now(pid);
    #[cfg(unix)]
    {
        // Walk the live parent/child tree instead of assuming Chromium remains
        // in the supervisor's process group. Playwright may launch it detached.
        kill_owned_process_tree(pid);
    }
}

fn kill_owned_process_tree(pid: u32) {
    #[cfg(windows)]
    crate::wasm_processes::kill_tree_now(pid);
    #[cfg(unix)]
    {
        for child in unix_child_pids(pid) {
            kill_owned_process_tree(child);
        }
        if let Ok(pid) = i32::try_from(pid) {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
    }
}

/// A procps tool by its usual directory. Android has no `/bin` or `/usr/bin`;
/// Termux installs procps under its prefix.
#[cfg(unix)]
#[cfg_attr(target_os = "android", allow(unused_variables))]
fn procps_tool(directory: &str, name: &str) -> PathBuf {
    #[cfg(target_os = "android")]
    return crate::util::termux_prefix().join("bin").join(name);
    #[cfg(not(target_os = "android"))]
    Path::new(directory).join(name)
}

#[cfg(unix)]
fn unix_child_pids(pid: u32) -> Vec<u32> {
    let output = std::process::Command::new(procps_tool("/usr/bin", "pgrep"))
        .args(["-P", &pid.to_string()])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .filter_map(|value| value.parse::<u32>().ok())
        .collect()
}
