//! Background action ownership, cancellation, and repeatable result retrieval.
use crate::{
    connections,
    conversations::{self, artifacts},
    plugins,
    state::AppState,
    tools::ProducedResult,
};
use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;

const MAX_RUNNING: usize = 16;
const RETENTION: Duration = Duration::from_secs(15 * 60);
const MAX_PROGRESS_BYTES: usize = 500;

/// What a running action last said it is doing. Shown in the promotion
/// notice and job checks so the agent knows why an action is still running.
#[derive(Clone, Default)]
pub struct ActionProgress(Arc<Mutex<Option<String>>>);

impl ActionProgress {
    /// Keeps one line of at most `MAX_PROGRESS_BYTES`; an empty message clears.
    pub fn report(&self, message: &str) {
        let line = message.split_whitespace().collect::<Vec<_>>().join(" ");
        let mut end = line.len().min(MAX_PROGRESS_BYTES);
        while !line.is_char_boundary(end) {
            end -= 1;
        }
        let line = &line[..end];
        *self.0.lock().expect("action progress") = (!line.is_empty()).then(|| line.to_string());
    }

    pub fn current(&self) -> Option<String> {
        self.0.lock().expect("action progress").clone()
    }
}

#[derive(Default)]
pub struct JobManager {
    entries: Mutex<HashMap<String, Arc<Job>>>,
    stopping: std::sync::atomic::AtomicBool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum JobOwner {
    Thread(String),
    Conversation(String),
}

impl JobOwner {
    fn emit(&self, state: &AppState) {
        match self {
            Self::Thread(id) => state.emit_thread_activity(id),
            Self::Conversation(id) => conversations::events::conversation_updated(state, id),
        }
    }

    fn can_access(&self, job: &JobOwner) -> bool {
        match (self, job) {
            (Self::Thread(_), Self::Thread(_)) => true,
            (Self::Conversation(left), Self::Conversation(right)) => left == right,
            _ => false,
        }
    }
}

struct Job {
    id: String,
    action: String,
    owner: JobOwner,
    started: Instant,
    /// The same instant as a wall clock, so a promoted Job can be timed from
    /// where its Action really began rather than from its promotion.
    started_at: i64,
    cancellation: CancellationToken,
    progress: ActionProgress,
    status: Mutex<Status>,
    changed: watch::Sender<bool>,
}

#[derive(Default)]
struct Status {
    promoted: bool,
    // Once claimed by completion, cancellation cannot replace the outcome.
    finishing: bool,
    reason: Option<String>,
    // False when the stop was a shutdown or an overflow, not a cancellation.
    cancelled: bool,
    result: Option<ProducedResult>,
    ended: Option<Instant>,
}

impl Job {
    fn response(&self, state: &str, promotion: bool) -> ProducedResult {
        let elapsed = self
            .status
            .lock()
            .expect("job status")
            .ended
            .unwrap_or_else(Instant::now)
            .duration_since(self.started)
            .as_millis();
        let mut value = json!({"job": {"id": self.id, "action": self.action, "state": state, "elapsedMs": elapsed}});
        if state == "running" {
            // The action's own account of why it is still running, if any.
            let progress = self.progress.current();
            let why = progress
                .as_deref()
                .map(|status| format!(" Status: {status}"))
                .unwrap_or_default();
            if let Some(status) = &progress {
                value["job"]["status"] = json!(status);
            }
            value["message"] = json!(if promotion {
                format!("{} is still running and was promoted to background job {}.{why} Call check_job to get its result, or cancel_job to stop it.", self.action, self.id)
            } else {
                format!(
                    "Job {} is still running.{why} Call check_job again, or cancel_job to stop it.",
                    self.id
                )
            });
        }
        ProducedResult::success(value)
    }

    fn cancel(&self, reason: String, cancelled: bool) -> Result<()> {
        let mut status = self.status.lock().expect("job status");
        if status.reason.is_some() {
            bail!("Job {} was already cancelled.", self.id);
        }
        if status.finishing {
            bail!(
                "Job {} already finished. Call check_job for its result.",
                self.id
            );
        }
        status.reason = Some(reason);
        status.cancelled = cancelled;
        self.cancellation.cancel();
        Ok(())
    }

    async fn wait(&self) {
        let mut changed = self.changed.subscribe();
        while !*changed.borrow_and_update() {
            if changed.changed().await.is_err() {
                break;
            }
        }
    }
}

fn wait_blocking(job: &Job) {
    let wait = job.wait();
    // Called from blocking threads (plugin mutation, thread delete,
    // shutdown). Never block a Tokio worker without yielding it.
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(|| futures::executor::block_on(wait));
        }
        _ => futures::executor::block_on(wait),
    }
}

impl JobManager {
    fn cancel_matching(
        &self,
        matches: impl Fn(&Job) -> bool,
        reason: impl Fn(&Job) -> String,
        cancelled: bool,
    ) {
        let jobs: Vec<_> = self
            .entries
            .lock()
            .expect("jobs")
            .values()
            .filter(|job| matches(job))
            .cloned()
            .collect();
        for job in &jobs {
            let _ = job.cancel(reason(job), cancelled);
        }
        for job in jobs {
            wait_blocking(&job);
        }
    }

    /// Called on the blocking pool before replacing or deleting plugin files.
    pub fn cancel_plugin(&self, plugin: &str, change: &str) {
        self.cancel_matching(
            |job| {
                job.action
                    .split_once('.')
                    .is_some_and(|(id, _)| id == plugin)
            },
            |job| {
                format!(
                    "Job {} was cancelled because the {plugin} plugin was {change}.",
                    job.id
                )
            },
            true,
        );
    }

    pub fn delete_thread(&self, thread_id: &str) {
        self.cancel_matching(
            |job| job.owner == JobOwner::Thread(thread_id.to_string()),
            |job| {
                format!(
                    "Job {} was cancelled because its thread was deleted.",
                    job.id
                )
            },
            true,
        );
        self.entries
            .lock()
            .expect("jobs")
            .retain(|_, job| job.owner != JobOwner::Thread(thread_id.to_string()));
    }

    pub fn delete_conversation(&self, conversation: &str) {
        let owner = JobOwner::Conversation(conversation.to_string());
        self.cancel_matching(
            |job| job.owner == owner,
            |job| {
                format!(
                    "Job {} was cancelled because its conversation was deleted.",
                    job.id
                )
            },
            true,
        );
        self.entries
            .lock()
            .expect("jobs")
            .retain(|_, job| job.owner != owner);
    }

    pub fn shutdown(&self) {
        self.stopping
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.cancel_matching(
            |_| true,
            |job| format!("Job {} was interrupted because Squire restarted.", job.id),
            false,
        );
    }

    fn lookup(&self, id: &str) -> Option<Arc<Job>> {
        let mut entries = self.entries.lock().expect("jobs");
        entries.retain(|_, job| {
            job.status
                .lock()
                .expect("job status")
                .ended
                .is_none_or(|ended| ended.elapsed() < RETENTION)
        });
        entries
            .get(id)
            .filter(|job| job.status.lock().expect("job status").promoted)
            .cloned()
    }
}

pub(crate) async fn run(
    state: &AppState,
    mut args: Value,
    context: crate::tools::CallContext,
) -> Result<ProducedResult> {
    let crate::tools::CallContext {
        source,
        activity_id,
        owner,
        cancellation: foreground_cancel,
    } = context;
    // A top-level call already owns its activity row. Only a parallel child
    // prepares one, and inserts it only if it is promoted.
    let (id, pending) = match &activity_id {
        Some(id) => (id.clone(), None),
        None => {
            let pending = connections::prepare_start(&source, "use_action", &args)?;
            (pending.id.clone(), Some(pending))
        }
    };
    // Move the action arguments out of the owned request instead of cloning.
    let action_args = match args.as_object_mut().and_then(|args| args.remove("args")) {
        Some(Value::Object(action_args)) => action_args,
        None => Map::new(),
        Some(_) => bail!("args must be a JSON object"),
    };
    let action = crate::util::arg_str(&args, "action")?.to_string();
    let (changed, _) = watch::channel(false);
    let job = Arc::new(Job {
        id,
        action,
        owner,
        started: Instant::now(),
        started_at: chrono::Utc::now().timestamp_millis(),
        cancellation: CancellationToken::new(),
        progress: ActionProgress::default(),
        status: Mutex::new(Status::default()),
        changed,
    });
    let state = state.clone();
    let (reply, response) = oneshot::channel();
    tokio::spawn(async move {
        // Serialize registration with plugin file mutations. Never hold this lock
        // while executing the guest or waiting for its result.
        let registration_state = state.clone();
        let registration_job = job.clone();
        let registered = tokio::task::spawn_blocking(move || -> Result<()> {
            let _plugins = registration_state.plugins.lock().expect("plugins");
            let exists = match &registration_job.owner {
                JobOwner::Thread(id) => connections::thread_exists(&registration_state, id)?,
                JobOwner::Conversation(id) => {
                    conversations::get(&registration_state, id)?.is_some()
                }
            };
            if !exists {
                bail!("Unknown tool-call owner.");
            }
            if registration_state
                .jobs
                .stopping
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                bail!("Squire is shutting down.");
            }
            registration_state
                .jobs
                .entries
                .lock()
                .expect("jobs")
                .insert(registration_job.id.clone(), registration_job);
            Ok(())
        })
        .await
        .context("Job registration failed")
        .and_then(|result| result);
        if let Err(error) = registered {
            let _ = reply.send(ProducedResult::error(error));
            return;
        }
        let invocation = plugins::invoke_action(
            &state,
            &job.action,
            &action_args,
            job.cancellation.clone(),
            job.progress.clone(),
            match &job.owner {
                JobOwner::Thread(id) => format!("thread:{id}"),
                JobOwner::Conversation(id) => format!("conversation:{id}"),
            },
        );
        tokio::pin!(invocation);
        let mut reply = Some(reply);
        let mut has_row = matches!(job.owner, JobOwner::Thread(_)) && activity_id.is_some();
        let mut promoted = false;
        let foreground =
            Duration::from_millis(state.config.settings.limits.command_timeout_ms.get());
        let produced = tokio::select! {
            biased;
            result = &mut invocation => result,
            _ = foreground_cancel.cancelled() => {
                let _ = job.cancel("Foreground action was stopped.".into(), true);
                invocation.await
            }
            _ = tokio::time::sleep(foreground) => {
                let promotion = promote(&state, &job, pending).await;
                match promotion {
                    Ok(()) => {
                        promoted = true;
                        has_row = matches!(job.owner, JobOwner::Thread(_));
                        job.owner.emit(&state);
                        let mut result = job.response("running", true);
                        result.recorded = matches!(job.owner, JobOwner::Thread(_)) && activity_id.is_some();
                        let _ = reply.take().expect("foreground reply").send(result);
                    }
                    Err(error) => {
                        job.status.lock().expect("job status").promoted = false;
                        let _ = job.cancel(error.to_string(), false);
                    }
                }
                invocation.await
            }
        };
        let mut result = match produced {
            Ok(result) => ProducedResult::new(result.result, result.attachment_staging),
            Err(error) => ProducedResult::error(error),
        };
        let cancelled = {
            let mut status = job.status.lock().expect("job status");
            status.finishing = true;
            if let Some(reason) = &status.reason {
                result.result = connections::error_result(reason);
            }
            status.cancelled
        };
        if has_row {
            let finish_state = state.clone();
            let id = job.id.clone();
            result = tokio::task::spawn_blocking(move || {
                finish_activity(&finish_state, &id, result, cancelled)
            })
            .await
            .unwrap_or_else(ProducedResult::error);
            job.owner.emit(&state);
        }
        if promoted {
            if let JobOwner::Conversation(conversation) = &job.owner {
                let finish_state = state.clone();
                let conversation = conversation.clone();
                let id = job.id.clone();
                result = tokio::task::spawn_blocking(move || {
                    artifacts::finish(&finish_state, &conversation, &id, result, cancelled)
                })
                .await
                .context("Conversation job finalization failed")
                .and_then(|result| result)
                .unwrap_or_else(ProducedResult::error);
                job.owner.emit(&state);
            }
        }
        {
            let mut status = job.status.lock().expect("job status");
            status.result = Some(result.clone());
            status.ended = Some(Instant::now());
            job.changed.send_replace(true);
        }
        if let Some(reply) = reply {
            let _ = reply.send(result);
        }
        let promoted = job.status.lock().expect("job status").promoted;
        if !promoted {
            state.jobs.entries.lock().expect("jobs").remove(&job.id);
        } else {
            let manager = Arc::downgrade(&state.jobs);
            let id = job.id.clone();
            tokio::spawn(async move {
                tokio::time::sleep(RETENTION).await;
                if let Some(manager) = manager.upgrade() {
                    manager.entries.lock().expect("jobs").remove(&id);
                }
            });
        }
    });
    response.await.context("Action worker stopped")
}

/// Reserve a slot and persist the job before exposing its id to a client.
async fn promote(
    state: &AppState,
    job: &Arc<Job>,
    pending: Option<connections::PendingStart>,
) -> Result<()> {
    {
        let entries = state.jobs.entries.lock().expect("jobs");
        let running: Vec<_> = entries
            .values()
            .filter(|entry| {
                let status = entry.status.lock().expect("job status");
                status.promoted && status.ended.is_none()
            })
            .map(|entry| format!("{} ({})", entry.id, entry.action))
            .collect();
        if running.len() >= MAX_RUNNING {
            bail!("Action exceeded the foreground wait; at most {MAX_RUNNING} background jobs may run. Running jobs: {}", running.join(", "));
        }
        job.status.lock().expect("job status").promoted = true;
    }
    let state = state.clone();
    let job = job.clone();
    tokio::task::spawn_blocking(move || match &job.owner {
        JobOwner::Thread(thread_id) => {
            if let Some(pending) = &pending {
                connections::insert_start(&state, thread_id, pending)?;
            }
            connections::mark_job(&state, &job.id)
        }
        JobOwner::Conversation(conversation) => {
            artifacts::promote(&state, conversation, &job.id, &job.action, job.started_at)
        }
    })
    .await
    .context("Job promotion failed")?
}

fn finish_activity(
    state: &AppState,
    id: &str,
    produced: ProducedResult,
    cancelled: bool,
) -> ProducedResult {
    let staging = produced.attachments.clone();
    let finished = connections::finish(state, id, produced.result, &produced.attachments).and_then(
        |finished| {
            if cancelled {
                connections::mark_job_cancelled(state, id)?;
            }
            Ok(finished)
        },
    );
    for slot in &staging {
        if let Some(dir) = &slot.staging {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
    let result = finished.map(|finished| {
        // Reuse the in-memory snapshot bytes; no second read from SQLite/disk.
        let slots = finished
            .attachments
            .into_iter()
            .map(|a| crate::tools::AttachmentSlot {
                staging: None,
                bytes: Some(a.data),
            })
            .collect();
        ProducedResult {
            result: finished.result,
            attachments: slots,
            recorded: true,
        }
    });
    let mut result = result.unwrap_or_else(ProducedResult::error);
    result.recorded = true;
    result
}

async fn recorded(state: &AppState, id: &str, owner: &JobOwner) -> Result<ProducedResult> {
    if let JobOwner::Conversation(conversation) = owner {
        let state = state.clone();
        let conversation = conversation.clone();
        let id = id.to_string();
        return tokio::task::spawn_blocking(move || {
            artifacts::recorded(&state, &conversation, &id)
        })
        .await?;
    }
    let state = state.clone();
    let id = id.to_string();
    tokio::task::spawn_blocking(move || connections::recorded_job(&state, &id)).await?
}

pub(crate) async fn check(
    state: &AppState,
    id: &str,
    owner: &JobOwner,
    cancellation: &CancellationToken,
) -> Result<ProducedResult> {
    let Some(job) = state.jobs.lookup(id) else {
        return recorded(state, id, owner).await;
    };
    if !owner.can_access(&job.owner) {
        bail!("No job {id}.");
    }
    tokio::select! {
        _ = cancellation.cancelled() => bail!("Job check was stopped."),
        _ = tokio::time::timeout(Duration::from_millis(state.config.settings.limits.command_timeout_ms.get()), job.wait()) => {},
    }
    let result = job.status.lock().expect("job status").result.clone();
    Ok(match result {
        Some(mut result) => {
            result.recorded = false;
            result
        }
        None => job.response("running", false),
    })
}

pub(crate) async fn cancel(state: &AppState, id: &str, owner: &JobOwner) -> Result<ProducedResult> {
    let Some(job) = state.jobs.lookup(id) else {
        if let JobOwner::Conversation(conversation) = owner {
            let status = artifacts::state(state, conversation, id)?;
            bail!("Job {id} is {status}. Call check_job for its result.");
        }
        let lookup_state = state.clone();
        let lookup_id = id.to_string();
        let cancelled = tokio::task::spawn_blocking(move || {
            connections::job_cancelled(&lookup_state, &lookup_id)
        })
        .await??;
        match cancelled {
            None => bail!("No job {id}."),
            Some(true) => bail!("Job {id} was already cancelled."),
            Some(false) => bail!("Job {id} already finished. Call check_job for its result."),
        }
    };
    if !owner.can_access(&job.owner) {
        bail!("No job {id}.");
    }
    job.cancel(format!("Job {id} was cancelled."), true)?;
    job.wait().await;
    Ok(job.response("cancelled", false))
}
