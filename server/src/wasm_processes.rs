//! Managed background processes for WASM plugins.
//!
//! Foreground [`crate::wasm`] commands wait for exit. This module spawns
//! detached process-group leaders whose stdout/stderr drain into capped
//! per-process ring buffers while the invocation returns.
//!
//! Guarantees:
//!
//! * managed-process isolation: handles are namespaced by plugin id and a
//!   caller can only control processes it spawned itself; read-only listener
//!   discovery is explicitly system-wide;
//! * working-directory validation (absolute, existing directory);
//! * `PATH` replaced by the invocation path, then explicit overrides;
//! * process groups so stop signals the whole tree;
//! * capped ring-buffer logs with truncation flags;
//! * quotas: max records per plugin / total, max output bytes, max lifetime;
//! * a process is signalled only while it is still running;
//! * graceful stop (`SIGTERM`, grace period, `SIGKILL`) then record removal;
//! * cleanup on plugin deletion and server shutdown.

#[cfg(unix)]
use std::fs;
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    ffi::OsString,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

/// Max managed process records per installed plugin.
pub const MAX_PROCESSES_PER_PLUGIN: usize = 8;
/// Buffered logs plus liveness for one managed process.
pub type ProcessLogsSnapshot = (String, String, bool, bool, bool, Option<i32>);
/// Max managed process records across all plugins.
pub const MAX_PROCESSES_TOTAL: usize = 64;
/// Retained log bytes per stream (ring buffer, trailing bytes kept).
pub const MAX_LOG_BYTES_PER_STREAM: usize = 512 * 1024;
/// Max age of a managed process before it is reaped.
pub const MAX_PROCESS_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);

/// Read-only metadata for a system TCP listener in a requested directory.
#[derive(Debug)]
pub struct ListeningProcessInfo {
    pub pid: u32,
    pub lifecycle_event: Option<String>,
    pub environment: Vec<(String, String)>,
    pub ports: Vec<u16>,
}

#[derive(Debug)]
pub struct ProcessSpawnResult {
    pub process: ManagedProcessInfo,
    pub reused: bool,
}

pub struct ProcessSpawnSpec<'a> {
    pub key: Option<&'a str>,
    pub program: &'a str,
    pub arguments: &'a [String],
    pub working_directory: Option<&'a str>,
    pub environment: &'a [(String, String)],
}

#[derive(Debug)]
pub struct ManagedProcessInfo {
    pub id: String,
    pub pid: u32,
    pub key: Option<String>,
    pub program: String,
    pub arguments: Vec<String>,
    pub working_directory: Option<String>,
    pub environment: Vec<(String, String)>,
}
/// Grace period between `SIGTERM` and `SIGKILL` on stop.
#[cfg(unix)]
const STOP_GRACE: Duration = Duration::from_secs(2);
/// Settle time after `SIGKILL` before giving up.
#[cfg(unix)]
const KILL_SETTLE: Duration = Duration::from_secs(1);

#[derive(Debug, Default)]
struct LogBuffer {
    bytes: VecDeque<u8>,
    truncated: bool,
}

impl LogBuffer {
    fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend(chunk);
        let overflow = self.bytes.len().saturating_sub(MAX_LOG_BYTES_PER_STREAM);
        if overflow > 0 {
            self.bytes.drain(..overflow);
            self.truncated = true;
        }
    }
}

struct SharedState {
    running: AtomicBool,
    exit_code: Mutex<Option<i32>>,
}

impl SharedState {
    fn running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }
}

struct ManagedProcess {
    id: String,
    plugin_id: String,
    key: Option<String>,
    program: String,
    arguments: Vec<String>,
    working_directory: Option<String>,
    environment: Vec<(String, String)>,
    pid: u32,
    started_at: Instant,
    shared: Arc<SharedState>,
    stdout: Arc<Mutex<LogBuffer>>,
    stderr: Arc<Mutex<LogBuffer>>,
}

impl ManagedProcess {
    fn key(plugin_id: &str, id: &str) -> String {
        format!("{plugin_id}\0{id}")
    }

    fn info(&self) -> ManagedProcessInfo {
        ManagedProcessInfo {
            id: self.id.clone(),
            pid: self.pid,
            key: self.key.clone(),
            program: self.program.clone(),
            arguments: self.arguments.clone(),
            working_directory: self.working_directory.clone(),
            environment: self.environment.clone(),
        }
    }
}

#[derive(Default)]
pub struct ProcessManager {
    inner: Mutex<HashMap<String, ManagedProcess>>,
}

impl ProcessManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawns a process-group leader. When a key is set, the running
    /// process with the same plugin-scoped key is returned atomically.
    pub fn spawn(
        &self,
        plugin_id: &str,
        spec: ProcessSpawnSpec<'_>,
        command_path: &OsString,
    ) -> Result<ProcessSpawnResult, String> {
        let ProcessSpawnSpec {
            key,
            program,
            arguments: args,
            working_directory,
            environment,
        } = spec;
        if program.trim().is_empty() {
            return Err("process program must not be empty".to_string());
        }
        if key.is_some_and(|key| key.is_empty()) {
            return Err("process key must not be empty".to_string());
        }
        if let Some(dir) = working_directory {
            validate_working_directory(dir)?;
        }

        self.reap_expired();
        let environment = normalize_environment(environment);
        let working_directory = working_directory.map(str::to_string);
        let key = key.map(str::to_string);
        let mut inner = self.inner.lock().unwrap();

        if let Some(key) = key.as_deref() {
            let existing = inner
                .iter()
                .find(|(_, process)| {
                    process.plugin_id == plugin_id && process.key.as_deref() == Some(key)
                })
                .map(|(registry_key, process)| {
                    (
                        registry_key.clone(),
                        process.shared.running(),
                        process.info(),
                    )
                });
            if let Some((registry_key, running, process)) = existing {
                if running {
                    return Ok(ProcessSpawnResult {
                        process,
                        reused: true,
                    });
                }
                inner.remove(&registry_key);
            }
        }

        // Finished logs stay readable, but the oldest finished record must
        // never prevent a new process from starting. Keep retention bounded
        // by the same per-plugin and global record limits.
        let mut owned = inner
            .values()
            .filter(|process| process.plugin_id == plugin_id)
            .count();
        while owned >= MAX_PROCESSES_PER_PLUGIN || inner.len() >= MAX_PROCESSES_TOTAL {
            let own_records_full = owned >= MAX_PROCESSES_PER_PLUGIN;
            let oldest_finished = inner
                .iter()
                .filter(|(_, process)| {
                    !process.shared.running()
                        && (!own_records_full || process.plugin_id == plugin_id)
                })
                .min_by_key(|(_, process)| process.started_at)
                .map(|(key, _)| key.clone());
            let Some(key) = oldest_finished else { break };
            let removed = inner.remove(&key).expect("record selected from registry");
            if removed.plugin_id == plugin_id {
                owned -= 1;
            }
        }
        if owned >= MAX_PROCESSES_PER_PLUGIN {
            return Err(format!(
                "plugin `{plugin_id}` already tracks {owned} background processes (max {MAX_PROCESSES_PER_PLUGIN})"
            ));
        }
        let total = inner.len();
        if total >= MAX_PROCESSES_TOTAL {
            return Err(format!(
                "server already tracks {total} background processes (max {MAX_PROCESSES_TOTAL})"
            ));
        }

        let mut command = std::process::Command::new(crate::util::resolve_program(
            std::ffi::OsStr::new(program),
            Some(command_path),
        ));
        command.args(args);
        if let Some(dir) = working_directory.as_deref() {
            command.current_dir(Path::new(dir));
        }
        make_noninteractive(&mut command);
        command.env("PATH", command_path);
        for (name, value) in &environment {
            command.env(name, value);
        }
        command.stdin(std::process::Stdio::null());
        command.stdout(std::process::Stdio::piped());
        command.stderr(std::process::Stdio::piped());

        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to spawn `{program}`: {error}"))?;
        let pid = child.id();
        let stdout_pipe = child.stdout.take();
        let stderr_pipe = child.stderr.take();

        let id = uuid::Uuid::new_v4().to_string();
        let stdout_buf = Arc::new(Mutex::new(LogBuffer::default()));
        let stderr_buf = Arc::new(Mutex::new(LogBuffer::default()));
        let stdout_done = drain_stream(stdout_pipe, stdout_buf.clone());
        let stderr_done = drain_stream(stderr_pipe, stderr_buf.clone());

        let shared = Arc::new(SharedState {
            running: AtomicBool::new(true),
            exit_code: Mutex::new(None),
        });
        {
            let shared = shared.clone();
            std::thread::spawn(move || {
                let exit_code = child.wait().ok().map(|status| status.code().unwrap_or(-1));
                // An exited child can still have unread pipe data. Do not
                // publish its final status until its output is drained. A
                // descendant can keep a pipe open, so bound each wait.
                let _ = stdout_done.recv_timeout(Duration::from_millis(500));
                let _ = stderr_done.recv_timeout(Duration::from_millis(500));
                *shared.exit_code.lock().unwrap() = exit_code;
                shared.running.store(false, Ordering::Release);
            });
        }

        let process = ManagedProcess {
            id: id.clone(),
            plugin_id: plugin_id.to_string(),
            key,
            program: program.to_string(),
            arguments: args.to_vec(),
            working_directory,
            environment,
            pid,
            started_at: Instant::now(),
            shared,
            stdout: stdout_buf,
            stderr: stderr_buf,
        };
        let info = process.info();
        inner.insert(ManagedProcess::key(plugin_id, &id), process);
        Ok(ProcessSpawnResult {
            process: info,
            reused: false,
        })
    }

    pub fn list(&self, plugin_id: &str) -> Vec<ManagedProcessInfo> {
        self.reap_expired();
        self.inner
            .lock()
            .unwrap()
            .values()
            .filter(|process| process.plugin_id == plugin_id && process.shared.running())
            .map(ManagedProcess::info)
            .collect()
    }

    fn inspect<R>(
        &self,
        plugin_id: &str,
        id: &str,
        inspect: impl FnOnce(&mut ManagedProcess) -> R,
    ) -> Result<R, String> {
        self.reap_expired();
        self.inner
            .lock()
            .unwrap()
            .get_mut(&ManagedProcess::key(plugin_id, id))
            .map(inspect)
            .ok_or_else(|| format!("unknown background process `{id}`"))
    }

    pub fn status(&self, plugin_id: &str, id: &str) -> Result<(bool, Option<i32>, u32), String> {
        self.inspect(plugin_id, id, |proc| {
            let snapshot = snapshot_locked(proc);
            (snapshot.running, snapshot.exit_code, snapshot.pid)
        })
    }

    pub fn read(
        &self,
        plugin_id: &str,
        id: &str,
        max_bytes: usize,
    ) -> Result<ProcessLogsSnapshot, String> {
        let max_bytes = max_bytes.max(1);
        let (snapshot, stdout, stderr) = self.inspect(plugin_id, id, |proc| {
            (
                snapshot_locked(proc),
                proc.stdout.clone(),
                proc.stderr.clone(),
            )
        })?;
        let (stdout_text, stdout_truncated) = read_buffer(&stdout, max_bytes);
        let (stderr_text, stderr_truncated) = read_buffer(&stderr, max_bytes);
        Ok((
            stdout_text,
            stderr_text,
            stdout_truncated,
            stderr_truncated,
            snapshot.running,
            snapshot.exit_code,
        ))
    }

    /// Graceful stop then tree-kill while the process is still running.
    ///
    /// A finished record is forgotten without signalling anything.
    pub fn stop(&self, plugin_id: &str, id: &str) -> Result<String, String> {
        let pid = {
            let mut inner = self.inner.lock().unwrap();
            let key = ManagedProcess::key(plugin_id, id);
            let Some(proc) = inner.get_mut(&key) else {
                return Err(format!("unknown background process `{id}`"));
            };
            if !proc.shared.running() {
                inner.remove(&key);
                return Ok("stopped".to_string());
            }
            proc.pid
        };
        terminate_tree_graceful(pid);
        self.inner
            .lock()
            .unwrap()
            .remove(&ManagedProcess::key(plugin_id, id));
        Ok("stopped".to_string())
    }

    /// Forgets a finished record. Never signals. Errors while running.
    pub fn remove(&self, plugin_id: &str, id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let key = ManagedProcess::key(plugin_id, id);
        let Some(proc) = inner.get_mut(&key) else {
            return Err(format!("unknown background process `{id}`"));
        };
        if proc.shared.running() {
            return Err(format!("background process `{id}` is still running"));
        }
        inner.remove(&key);
        Ok(())
    }

    /// Tree-kills every running process owned by a plugin. Used on deletion.
    pub fn remove_plugin(&self, plugin_id: &str) {
        let running_pids: Vec<u32> = {
            let inner = self.inner.lock().unwrap();
            inner
                .values()
                .filter(|proc| proc.plugin_id == plugin_id && proc.shared.running())
                .map(|proc| proc.pid)
                .collect()
        };
        for pid in running_pids {
            kill_tree_now(pid);
        }
        self.inner
            .lock()
            .unwrap()
            .retain(|_, proc| proc.plugin_id != plugin_id);
    }

    /// Tree-kills every running process. Used on server shutdown.
    pub fn shutdown(&self) {
        let running_pids: Vec<u32> = {
            let inner = self.inner.lock().unwrap();
            inner
                .values()
                .filter(|proc| proc.shared.running())
                .map(|proc| proc.pid)
                .collect()
        };
        for pid in running_pids {
            kill_tree_now(pid);
        }
        self.inner.lock().unwrap().clear();
    }

    fn reap_expired(&self) {
        let expired: Vec<(String, u32, bool)> = {
            let inner = self.inner.lock().unwrap();
            inner
                .iter()
                .filter(|(_, proc)| proc.started_at.elapsed() > MAX_PROCESS_LIFETIME)
                .map(|(key, proc)| (key.clone(), proc.pid, proc.shared.running()))
                .collect()
        };
        for (key, pid, running) in expired {
            if running {
                kill_tree_now(pid);
            }
            self.inner.lock().unwrap().remove(&key);
        }
    }
}

struct Snapshot {
    running: bool,
    exit_code: Option<i32>,
    pid: u32,
}

/// Reads cached liveness. The waiter thread owns the `Child` and reaps it, so
/// the shared `running` flag is authoritative until it flips false.
fn snapshot_locked(proc: &mut ManagedProcess) -> Snapshot {
    Snapshot {
        running: proc.shared.running(),
        exit_code: *proc.shared.exit_code.lock().unwrap(),
        pid: proc.pid,
    }
}

fn read_buffer(buffer: &Arc<Mutex<LogBuffer>>, max_bytes: usize) -> (String, bool) {
    let guard = buffer.lock().unwrap();
    let total = guard.bytes.len();
    let truncated = guard.truncated || total > max_bytes;
    let start = total.saturating_sub(max_bytes);
    let bytes: Vec<u8> = guard.bytes.iter().skip(start).copied().collect();
    (String::from_utf8_lossy(&bytes).into_owned(), truncated)
}

fn drain_stream<T: Read + Send + 'static>(
    pipe: Option<T>,
    buffer: Arc<Mutex<LogBuffer>>,
) -> std::sync::mpsc::Receiver<()> {
    let (done, finished) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        if let Some(mut pipe) = pipe {
            let mut chunk = [0u8; 8192];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => buffer.lock().unwrap().push(&chunk[..n]),
                    Err(_) => break,
                }
            }
        }
        let _ = done.send(());
    });
    finished
}

fn normalize_environment(environment: &[(String, String)]) -> Vec<(String, String)> {
    environment
        .iter()
        .cloned()
        .collect::<BTreeMap<_, _>>()
        .into_iter()
        .collect()
}

#[cfg(unix)]
pub async fn find_listeners(
    working_directory: &str,
    environment_keys: &[String],
    deadline: Instant,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<Vec<ListeningProcessInfo>, String> {
    let directory = validate_working_directory(working_directory)?;
    let directory = fs::canonicalize(&directory).map_err(|error| {
        format!(
            "failed to resolve working directory {}: {error}",
            directory.display()
        )
    })?;

    let listener_output = run_discovery_command(
        "lsof",
        &[
            "-nP".into(),
            "-iTCP".into(),
            "-sTCP:LISTEN".into(),
            "-Fpn".into(),
        ],
        deadline,
        cancellation,
    )
    .await?;
    let listeners = parse_lsof_listeners(&command_stdout("lsof listener scan", listener_output)?);
    if listeners.is_empty() {
        return Ok(Vec::new());
    }

    let environment_keys = environment_keys.to_vec();
    let timeout = deadline.saturating_duration_since(Instant::now());
    let task = tokio::task::spawn_blocking(move || {
        inspect_listener_processes(listeners, directory, &environment_keys)
    });
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err("invocation cancelled".into()),
        result = tokio::time::timeout(timeout, task) => {
            result
                .map_err(|_| "external process discovery exceeded the invocation deadline".to_string())?
                .map_err(|error| format!("failed to inspect listener processes: {error}"))
        }
    }
}

#[cfg(not(unix))]
pub async fn find_listeners(
    _working_directory: &str,
    _environment_keys: &[String],
    _deadline: Instant,
    _cancellation: &tokio_util::sync::CancellationToken,
) -> Result<Vec<ListeningProcessInfo>, String> {
    Err("external listener discovery is unsupported on this platform".into())
}

#[cfg(unix)]
fn refresh_external_processes(system: &mut sysinfo::System, pids: &[sysinfo::Pid]) {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, UpdateKind};

    if pids.is_empty() {
        return;
    }
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(pids),
        true,
        ProcessRefreshKind::nothing()
            .with_cwd(UpdateKind::Always)
            .with_environ(UpdateKind::Always),
    );
}

#[cfg(unix)]
fn process_environment(process: &sysinfo::Process) -> BTreeMap<String, String> {
    process
        .environ()
        .iter()
        .filter_map(|entry| {
            entry
                .to_string_lossy()
                .split_once('=')
                .map(|(key, value)| (key.to_string(), value.to_string()))
        })
        .collect()
}

#[cfg(unix)]
fn listener_metadata(
    system: &mut sysinfo::System,
    listener_pid: sysinfo::Pid,
    directory: &Path,
) -> Option<(BTreeMap<String, String>, Option<String>)> {
    let mut current = Some(listener_pid);
    let mut seen = Vec::new();
    let mut listener_environment = None;
    let mut lifecycle_event = None;

    while let Some(pid) = current {
        if seen.contains(&pid) {
            break;
        }
        seen.push(pid);

        if system.process(pid).is_none() {
            refresh_external_processes(system, &[pid]);
        }
        let Some(process) = system.process(pid) else {
            break;
        };
        let Some(cwd) = process.cwd() else {
            break;
        };
        let Ok(cwd) = fs::canonicalize(cwd) else {
            break;
        };
        if cwd != directory {
            break;
        }

        let environment = process_environment(process);
        if let Some(event) = environment
            .get("npm_lifecycle_event")
            .filter(|event| !event.is_empty())
        {
            // Nested package-manager wrappers overwrite this variable, so the
            // outermost process that is still inside the package owns the script identity.
            lifecycle_event = Some(event.clone());
        }
        if pid == listener_pid {
            listener_environment = Some(environment);
        }
        current = process.parent();
    }

    listener_environment.map(|environment| (environment, lifecycle_event))
}

#[cfg(unix)]
fn inspect_listener_processes(
    listeners: HashMap<u32, Vec<u16>>,
    directory: PathBuf,
    environment_keys: &[String],
) -> Vec<ListeningProcessInfo> {
    use sysinfo::{Pid, System};

    let pids = listeners
        .keys()
        .copied()
        .map(Pid::from_u32)
        .collect::<Vec<_>>();
    let mut system = System::new();
    refresh_external_processes(&mut system, &pids);

    let mut found = Vec::new();
    for (pid, ports) in listeners {
        let listener_pid = Pid::from_u32(pid);
        let Some((environment, lifecycle_event)) =
            listener_metadata(&mut system, listener_pid, &directory)
        else {
            continue;
        };
        let selected_environment = environment_keys
            .iter()
            .filter_map(|key| {
                environment
                    .get(key)
                    .map(|value| (key.clone(), value.clone()))
            })
            .collect();

        found.push(ListeningProcessInfo {
            pid,
            lifecycle_event,
            environment: selected_environment,
            ports,
        });
    }
    found.sort_by_key(|process| process.pid);
    found
}

#[cfg(unix)]
async fn run_discovery_command(
    program: &str,
    args: &[String],
    deadline: Instant,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<std::process::Output, String> {
    let timeout = deadline.saturating_duration_since(Instant::now());
    let mut command = tokio::process::Command::new(program);
    command.args(args).kill_on_drop(true);
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err("invocation cancelled".into()),
        result = tokio::time::timeout(timeout, command.output()) => {
            result
                .map_err(|_| "external process discovery exceeded the invocation deadline".to_string())?
                .map_err(|error| format!("failed to run {program} for external process discovery: {error}"))
        }
    }
}

#[cfg(unix)]
fn command_stdout(label: &str, output: std::process::Output) -> Result<String, String> {
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() || (!stdout.is_empty() && output.stderr.is_empty()) {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stdout.is_empty() && stderr.is_empty() {
        return Ok(String::new());
    }
    Err(format!(
        "{label} failed with status {}{}",
        output.status,
        if stderr.is_empty() {
            String::new()
        } else {
            format!(": {stderr}")
        }
    ))
}

#[cfg(unix)]
fn parse_lsof_listeners(stdout: &str) -> HashMap<u32, Vec<u16>> {
    let mut current_pid = None;
    let mut listeners = HashMap::<u32, Vec<u16>>::new();
    for line in stdout.lines() {
        if let Some(pid) = line.strip_prefix('p').and_then(|value| value.parse().ok()) {
            current_pid = Some(pid);
            continue;
        }
        let Some(endpoint) = line.strip_prefix('n') else {
            continue;
        };
        let Some(pid) = current_pid else {
            continue;
        };
        let Some(port) = endpoint
            .rsplit_once(':')
            .and_then(|(_, port)| port.parse::<u16>().ok())
        else {
            continue;
        };
        listeners.entry(pid).or_default().push(port);
    }
    for ports in listeners.values_mut() {
        ports.sort_unstable();
        ports.dedup();
    }
    listeners
}

/// Graceful tree stop: `SIGTERM`, grace period, then `SIGKILL`.
fn terminate_tree_graceful(pid: u32) {
    #[cfg(unix)]
    {
        let Ok(pgid) = i32::try_from(pid) else { return };
        if process_alive(pid) {
            unsafe {
                libc::kill(-pgid, libc::SIGTERM);
            }
            let deadline = Instant::now() + STOP_GRACE;
            while Instant::now() < deadline {
                if !process_alive(pid) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
        let deadline = Instant::now() + KILL_SETTLE;
        while Instant::now() < deadline {
            if !process_alive(pid) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    #[cfg(not(unix))]
    {
        kill_tree_now(pid);
    }
}

/// Kills `pid` and everything it started. On Unix the process leads its own
/// group (see [`make_noninteractive`]); Windows walks the tree with taskkill.
pub(crate) fn kill_tree_now(pid: u32) {
    #[cfg(unix)]
    {
        if let Ok(pgid) = i32::try_from(pid) {
            unsafe {
                libc::kill(-pgid, libc::SIGKILL);
            }
        }
    }
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("taskkill.exe");
        crate::util::hide_console(&mut command);
        let _ = command
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
    }
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    let Ok(pid_i32) = i32::try_from(pid) else {
        return false;
    };
    // kill(pid, 0) reports existence. ESRCH means gone; EPERM means alive but
    // not signalable by us, which still counts as alive.
    unsafe {
        if libc::kill(pid_i32, 0) == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

/// Environment that turns known interactive prompts into immediate failures.
/// `CI` is deliberately absent: it changes tool behavior beyond prompting
/// (pnpm, for one, defaults to a frozen lockfile under CI).
const NONINTERACTIVE_ENV: [(&str, &str); 5] = [
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GCM_INTERACTIVE", "never"),
    ("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0"),
    ("PIP_NO_INPUT", "1"),
    ("DEBIAN_FRONTEND", "noninteractive"),
];

/// Prepares a plugin command so it can never wait on a prompt nobody can
/// answer. Stdin is already null, so prompts that read stdin see EOF; this
/// also covers tools that open `/dev/tty` directly (git credentials, ssh
/// passphrases, pinentry) by starting the child in a new session with no
/// controlling terminal. The child leads its own process group too, so
/// `kill(-pid)` still reaches the whole tree.
///
/// Call before applying caller-supplied environment so callers can override.
pub fn make_noninteractive(command: &mut std::process::Command) {
    for (name, value) in NONINTERACTIVE_ENV {
        command.env(name, value);
    }
    crate::util::hide_console(command);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // `setsid` replaces `process_group(0)`: std applies the process group
        // before `pre_exec`, and `setsid` fails for a group leader.
        // SAFETY: setsid is async-signal-safe and runs in the child before exec.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
}

pub fn validate_working_directory(dir: &str) -> Result<PathBuf, String> {
    let path = Path::new(dir);
    if !path.is_absolute() {
        return Err(format!("working directory `{dir}` must be absolute"));
    }
    if !path.is_dir() {
        return Err(format!("working directory `{dir}` does not exist"));
    }
    Ok(path.to_path_buf())
}
