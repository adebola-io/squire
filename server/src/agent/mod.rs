//! Squire's own agent runtime (plan 008). Owns the active execution per
//! Conversation; many Conversations may execute at once, each at most one.
//!
//! Model responses stream display-only previews and are committed atomically. Tool
//! calls run through the native tool layer and are recorded on the
//! Conversation. Same-model Messages sent while an execution runs are queued
//! and drained as soon as the tool call they arrived during finishes, or
//! early with `Send now`.

mod background_compaction;
pub mod context;
mod execution;
mod switching;
pub use switching::{branch_with_compaction, send_with_switch};

pub mod tools;

use crate::{
    conversations::{self, events, Consumed, StoreError, StoredMessage},
    providers::{
        catalog::{ModelCatalog, ModelMetadata},
        store::{ModelInfo, ModelPrefs, ProfileInput},
        types::{ModelProvider, ModelRef},
        ProfileInfo, ProviderRegistry,
    },
    state::AppState,
};
use anyhow::Result;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, RwLock, RwLockReadGuard, RwLockWriteGuard},
    time::{Duration, Instant},
};

/// How long a provider's model list is reused before discovery asks the
/// provider again. Searching and paging the list hit this cache, not the
/// provider, on every keystroke.
const DISCOVERY_TTL: Duration = Duration::from_secs(60);
use tokio_util::sync::CancellationToken;

/// Request errors a client can fix (mapped to HTTP 400).
#[derive(Debug, PartialEq, Eq)]
pub enum AgentError {
    EmptyMessage,
    NoModelConfigured,
    UnknownProfile(String),
    /// A send that changes the model is disabled while an execution runs.
    ModelChangeWhileRunning,
    QueueEmpty,
    ContextTooLarge,
}

impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentError::EmptyMessage => write!(f, "empty_message"),
            AgentError::NoModelConfigured => write!(
                f,
                "No model is configured. Add a provider profile and choose a model."
            ),
            AgentError::UnknownProfile(id) => write!(f, "Unknown provider profile: {id}"),
            AgentError::ModelChangeWhileRunning => write!(
                f,
                "Wait for Squire to finish, or stop it, before sending with a different model."
            ),
            AgentError::ContextTooLarge => write!(f, "This chat no longer fits the model's context window. If the model supports more, raise its context window in Settings → Providers; otherwise choose a larger model or start a new chat."),
            AgentError::QueueEmpty => write!(f, "There are no queued messages to send."),
        }
    }
}

impl std::error::Error for AgentError {}

/// Runtime handle for the one active execution of a Conversation.
#[derive(Clone)]
pub(crate) struct ExecutionHandle {
    /// Stop: cancels model generation and skips calls that have not started.
    cancel: CancellationToken,
    /// `Send now`: fired once per request and replaced after each drain.
    send_now: Arc<Mutex<CancellationToken>>,
    /// Fired when the execution has fully ended and released the
    /// Conversation, including any started tool call.
    finished: CancellationToken,
}

impl ExecutionHandle {
    fn new() -> Self {
        Self {
            cancel: CancellationToken::new(),
            send_now: Arc::new(Mutex::new(CancellationToken::new())),
            finished: CancellationToken::new(),
        }
    }

    fn send_now_token(&self) -> CancellationToken {
        self.send_now.lock().unwrap().clone()
    }

    fn reset_send_now(&self) {
        *self.send_now.lock().unwrap() = CancellationToken::new();
    }
}

#[derive(Default)]
struct Activity {
    executions: HashMap<String, ExecutionHandle>,
    /// Conversations being deleted: no execution may start or continue.
    deleting: HashSet<String>,
    switching: HashSet<String>,
}

impl Activity {
    /// Edits and branches need a Conversation that exists and is not running.
    fn ensure_idle(&self, conversation_id: &str) -> Result<()> {
        if self.deleting.contains(conversation_id) {
            return Err(StoreError::NotFound.into());
        }
        if self.executions.contains_key(conversation_id) {
            return Err(StoreError::Busy.into());
        }
        Ok(())
    }

    fn release(&mut self, conversation_id: &str) {
        self.switching.remove(conversation_id);
        if let Some(handle) = self.executions.remove(conversation_id) {
            handle.finished.cancel();
        }
    }
}

pub struct AgentRuntime {
    providers: RwLock<ProviderRegistry>,
    activity: Mutex<Activity>,
    /// Per model: the largest request it has served, loaded once from the
    /// transcript and raised as new usage arrives.
    served: Mutex<HashMap<(String, String), u64>>,
    /// Per profile: the model IDs its provider last listed, and when.
    discovered: Mutex<HashMap<String, (Instant, Vec<String>)>>,
    /// One speculative, not-yet-applied compaction per conversation.
    precomputed: Mutex<HashMap<String, background_compaction::Pending>>,
}

impl AgentRuntime {
    pub fn new(providers: ProviderRegistry) -> Self {
        Self {
            providers: RwLock::new(providers),
            activity: Mutex::new(Activity::default()),
            served: Mutex::default(),
            discovered: Mutex::default(),
            precomputed: Mutex::default(),
        }
    }

    fn registry(&self) -> RwLockReadGuard<'_, ProviderRegistry> {
        self.providers.read().expect("provider registry")
    }

    fn registry_mut(&self) -> RwLockWriteGuard<'_, ProviderRegistry> {
        self.providers.write().expect("provider registry")
    }

    fn forget_discovery(&self, id: &str) {
        self.discovered.lock().expect("discovery cache").remove(id);
    }

    fn served(&self, state: &AppState, model: &ModelRef) -> Result<u64> {
        let key = (model.profile_id.clone(), model.model_id.clone());
        if let Some(tokens) = self.served.lock().expect("served").get(&key) {
            return Ok(*tokens);
        }
        let stored = conversations::largest_request(state, model)?;
        let mut served = self.served.lock().expect("served");
        let tokens = served.entry(key).or_default();
        *tokens = (*tokens).max(stored);
        Ok(*tokens)
    }

    /// Records a request the model just served. Unloaded models read it
    /// from the transcript on first use instead.
    pub(crate) fn note_served(&self, model: &ModelRef, tokens: u64) {
        let key = (model.profile_id.clone(), model.model_id.clone());
        if let Some(served) = self.served.lock().expect("served").get_mut(&key) {
            *served = (*served).max(tokens);
        }
    }

    pub fn profiles(&self) -> Vec<ProfileInfo> {
        self.registry().profiles()
    }

    pub fn default_model(&self) -> Option<ModelRef> {
        self.registry().default_model()
    }

    pub fn chatgpt(&self) -> Result<Arc<crate::chatgpt::Manager>> {
        self.registry()
            .chatgpt()
            .ok_or_else(|| anyhow::anyhow!("ChatGPT authentication is unavailable"))
    }

    pub fn metadata(&self, model: &ModelRef) -> Result<ModelMetadata> {
        self.registry().metadata(model)
    }

    pub fn model_prefs(&self, model: &ModelRef) -> Result<ModelPrefs> {
        self.registry().prefs(model)
    }

    pub fn save_profile(&self, id: Option<&str>, input: ProfileInput) -> Result<ProfileInfo> {
        let saved = self.registry_mut().save_profile(id, input)?;
        // A new key or endpoint can change what the provider lists.
        self.forget_discovery(&saved.id);
        Ok(saved)
    }

    pub fn delete_profile(&self, id: &str) -> Result<()> {
        self.registry_mut().delete_profile(id)?;
        self.forget_discovery(id);
        Ok(())
    }

    pub fn save_model_prefs(&self, model: &ModelRef, prefs: &ModelPrefs) -> Result<()> {
        self.registry().save_prefs(model, prefs)
    }

    /// Every model a profile offers. The provider's own list is reused for
    /// `DISCOVERY_TTL` unless `fresh` asks for a new one (the Refresh button).
    pub async fn discover_models(&self, id: &str, fresh: bool) -> Result<Vec<ModelInfo>> {
        let provider = self
            .provider(id)
            .ok_or_else(|| AgentError::UnknownProfile(id.into()))?;
        // The catalog is cached and already refreshed in the background at
        // startup; discovery returns provider results promptly using existing
        // metadata while a refresh happens independently. Every kind uses the
        // catalog: gateways match models by name. No registry lock is held
        // during either network request.
        spawn_catalog_refresh(self.registry().catalog.clone());
        let cached = if fresh {
            None
        } else {
            self.discovered
                .lock()
                .expect("discovery cache")
                .get(id)
                .filter(|(at, _)| at.elapsed() < DISCOVERY_TTL)
                .map(|(_, ids)| ids.clone())
        };
        let discovery = match cached {
            Some(ids) => Ok(ids),
            None => {
                let listed = provider.list_models().await;
                if let Ok(ids) = &listed {
                    self.discovered
                        .lock()
                        .expect("discovery cache")
                        .insert(id.to_string(), (Instant::now(), ids.clone()));
                }
                listed
            }
        };
        let registry = self.registry();
        // Account-specific and protocol-routed providers have authoritative
        // discovery lists. Saved IDs must not reintroduce unavailable models.
        let kind = registry
            .profile_kind(id)
            .ok_or_else(|| AgentError::UnknownProfile(id.into()))?;
        let mut ids = if matches!(kind, "chatgpt" | "opencode" | "opencode-zen") {
            Vec::new()
        } else {
            registry.saved_models(id)?
        };
        match discovery {
            Ok(discovered) => ids.extend(discovered),
            Err(error) if ids.is_empty() => return Err(error),
            Err(_) => {}
        }
        ids.sort();
        ids.dedup();
        registry.model_infos(id, ids)
    }

    /// Warm the disk cache after startup without delaying the HTTP server.
    pub fn schedule_catalog_refresh(&self) {
        let registry = self.registry();
        if !registry.profiles().is_empty() {
            spawn_catalog_refresh(registry.catalog.clone());
        }
    }

    pub fn remember_model(&self, model: &ModelRef, options: &Value) -> Result<()> {
        self.registry_mut().remember(model, options)
    }

    fn provider(&self, profile_id: &str) -> Option<Arc<dyn ModelProvider>> {
        self.registry().get(profile_id)
    }

    pub fn is_active(&self, conversation_id: &str) -> bool {
        self.activity
            .lock()
            .unwrap()
            .executions
            .contains_key(conversation_id)
    }

    /// Requests that the active foreground execution stop. Incomplete model
    /// output is discarded, calls that have not started are skipped, and
    /// queued Messages stay queued. A started native tool call still runs to
    /// completion; the execution ends after it.
    pub fn stop(&self, conversation_id: &str) -> bool {
        match self
            .activity
            .lock()
            .unwrap()
            .executions
            .get(conversation_id)
        {
            Some(handle) => {
                handle.cancel.cancel();
                true
            }
            None => false,
        }
    }

    fn release(&self, conversation_id: &str) {
        self.activity.lock().unwrap().release(conversation_id);
    }
}

fn spawn_catalog_refresh(catalog: Arc<ModelCatalog>) {
    tokio::spawn(async move {
        if let Err(error) = catalog.refresh().await {
            tracing::error!("Model catalog refresh failed: {error:#}");
        }
    });
}

/// The limits the context budget is planned with. Unless the user set them,
/// the context window never reads smaller than the largest request the model
/// has already served: a guessed window for an uncatalogued model must not
/// strand a chat the model itself handled.
pub(crate) fn budget_metadata(state: &AppState, model: &ModelRef) -> Result<ModelMetadata> {
    let mut metadata = state.agent.metadata(model)?;
    if state.agent.model_prefs(model)?.metadata.is_some() {
        return Ok(metadata);
    }
    let served = u32::try_from(state.agent.served(state, model)?).unwrap_or(u32::MAX);
    metadata.context_window = metadata.context_window.max(served);
    Ok(metadata)
}

fn resolve_provider(state: &AppState, model: &ModelRef) -> Result<Arc<dyn ModelProvider>> {
    state
        .agent
        .provider(&model.profile_id)
        .ok_or_else(|| AgentError::UnknownProfile(model.profile_id.clone()).into())
}

#[allow(clippy::too_many_arguments)]
fn send_prepared(
    state: &AppState,
    conversation_id: &str,
    text: &str,
    model: Option<ModelRef>,
    native_options: Value,
    attachments: &[conversations::remember::NewAttachment],
    client_message_id: Option<&str>,
    prepared: Option<(
        &conversations::remember::PreparedCompaction,
        ExecutionHandle,
    )>,
    fit_checked: bool,
) -> Result<StoredMessage> {
    let text = text.trim();
    if text.is_empty() && attachments.is_empty() {
        return Err(AgentError::EmptyMessage.into());
    }
    let conversation = conversations::get(state, conversation_id)?.ok_or(StoreError::NotFound)?;
    let requested = model.clone();
    let model = model
        .or_else(|| conversation.current_model.clone())
        .or_else(|| state.agent.default_model())
        .ok_or(AgentError::NoModelConfigured)?;
    if model.model_id.trim().is_empty() {
        anyhow::bail!("Model ID is required");
    }
    let provider = resolve_provider(state, &model)?;
    let native_options = if native_options.is_null() {
        state.agent.model_prefs(&model)?.native_options
    } else {
        native_options
    };
    if !native_options.is_null() && !native_options.is_object() {
        anyhow::bail!("Native options must be a JSON object");
    }
    // Context reconstruction can load attachments and query SQLite. Never do
    // it under the global activity mutex; the HTTP path may already have
    // checked it. Queued sends are always checked: `fits` includes
    // already-queued messages, preventing an unbounded queue from exceeding
    // the model's context window.
    if prepared.is_none()
        && (!fit_checked || state.agent.is_active(conversation_id))
        && !switching::fits(state, conversation_id, &model, text, attachments)?
    {
        return Err(AgentError::ContextTooLarge.into());
    }

    let handle = {
        let mut activity = state.agent.activity.lock().unwrap();
        if activity.deleting.contains(conversation_id) {
            return Err(StoreError::NotFound.into());
        }
        if activity.switching.contains(conversation_id) && prepared.is_none() {
            return Err(StoreError::Busy.into());
        }
        if prepared.is_none() && activity.executions.contains_key(conversation_id) {
            if requested.is_some() && requested != conversation.current_model {
                return Err(AgentError::ModelChangeWhileRunning.into());
            }
            // Enqueue under the lock so the finishing execution's drain
            // either sees this Message or has already released.
            let message = conversations::enqueue_with_attachments(
                state,
                conversation_id,
                text,
                &native_options,
                attachments,
                client_message_id,
            )?;
            drop(activity);
            events::queue_updated(state, conversation_id);
            return Ok(message);
        }
        let handle = prepared
            .as_ref()
            .map(|(_, handle)| handle.clone())
            .unwrap_or_else(ExecutionHandle::new);
        if handle.cancel.is_cancelled() {
            return Err(StoreError::Busy.into());
        }
        activity.switching.remove(conversation_id);
        activity
            .executions
            .insert(conversation_id.to_string(), handle.clone());
        handle
    };

    let turn = match (|| {
        // The last-used-model preference lives in the unified
        // database and must not turn an already-committed send into an
        // apparent failure. Record it before the transcript commits so a
        // preference-write failure leaves no committed message behind.
        state.agent.remember_model(&model, &native_options)?;
        conversations::begin_turn_with_compaction(
            state,
            conversation_id,
            text,
            &model,
            &native_options,
            attachments,
            prepared.as_ref().map(|(compaction, _)| *compaction),
            client_message_id,
            || context::system_prompt(state, text),
        )
    })() {
        Ok(turn) => turn,
        Err(error) => {
            state.agent.release(conversation_id);
            return Err(error);
        }
    };
    if !turn.earlier.is_empty() {
        for queued in &turn.earlier {
            events::message_appended(state, conversation_id, &queued.id, "user");
        }
        events::queue_updated(state, conversation_id);
    }
    events::message_appended(state, conversation_id, &turn.message.id, "user");
    events::conversation_updated(state, conversation_id);
    events::execution_started(state, conversation_id, &model);
    spawn_execution(
        state,
        conversation_id,
        model,
        provider,
        native_options,
        handle,
    );
    Ok(turn.message)
}

fn spawn_execution(
    state: &AppState,
    conversation_id: &str,
    model: ModelRef,
    provider: Arc<dyn ModelProvider>,
    native_options: Value,
    handle: ExecutionHandle,
) {
    tokio::spawn(execution::run(
        state.clone(),
        conversation_id.to_string(),
        model,
        provider,
        native_options,
        handle,
    ));
}

/// `Send now`: drain the whole queue early. While running, the execution
/// consumes it at the next safe boundary; when idle (after Stop or an
/// error), it starts a new execution from the queue with the native options
/// of its latest Message.
pub fn send_now(state: &AppState, conversation_id: &str) -> Result<()> {
    if !conversations::has_queued(state, conversation_id)? {
        return Err(AgentError::QueueEmpty.into());
    }
    let mut activity = state.agent.activity.lock().unwrap();
    if activity.deleting.contains(conversation_id) {
        return Err(StoreError::NotFound.into());
    }
    if activity.switching.contains(conversation_id) {
        return Err(StoreError::Busy.into());
    }
    if let Some(handle) = activity.executions.get(conversation_id) {
        handle.send_now_token().cancel();
        return Ok(());
    }
    let conversation = conversations::get(state, conversation_id)?.ok_or(StoreError::NotFound)?;
    let model = conversation
        .current_model
        .or_else(|| state.agent.default_model())
        .ok_or(AgentError::NoModelConfigured)?;
    let provider = resolve_provider(state, &model)?;
    // The queue may have grown while running; do not consume work that
    // cannot execute within the model's context budget.
    if !switching::fits(state, conversation_id, &model, "", &[])? {
        return Err(AgentError::ContextTooLarge.into());
    }
    let consumed =
        conversations::begin_from_queue(state, conversation_id)?.ok_or(AgentError::QueueEmpty)?;
    let handle = ExecutionHandle::new();
    activity
        .executions
        .insert(conversation_id.to_string(), handle.clone());
    drop(activity);
    for message in &consumed.messages {
        events::message_appended(state, conversation_id, &message.id, "user");
    }
    events::queue_updated(state, conversation_id);
    events::conversation_updated(state, conversation_id);
    events::execution_started(state, conversation_id, &model);
    spawn_execution(
        state,
        conversation_id,
        model,
        provider,
        consumed.native_options,
        handle,
    );
    Ok(())
}

/// At a terminal response: marks the Conversation idle, then either starts
/// the next execution from the queue (returning what it consumed) or
/// releases the Conversation. Done under the activity lock so a concurrent
/// send either lands in this drain or starts a fresh execution. A storage
/// failure releases the Conversation and is returned, never treated as an
/// empty queue. An oversized accumulated queue is never consumed: it stays
/// queued and the drain fails with `ContextTooLarge`.
fn finish_or_drain(
    state: &AppState,
    conversation_id: &str,
    model: &crate::providers::types::ModelRef,
) -> Result<Option<Consumed>> {
    // Check the accumulated budget before touching the activity lock; the
    // check includes all queued messages so individually valid messages
    // whose combination exceeds the window are not consumed.
    if conversations::has_queued(state, conversation_id)?
        && !switching::fits(state, conversation_id, model, "", &[])?
    {
        conversations::set_execution(
            state,
            conversation_id,
            conversations::ExecutionStatus::Error,
            Some(&AgentError::ContextTooLarge.to_string()),
        )?;
        state.agent.release(conversation_id);
        events::conversation_updated(state, conversation_id);
        return Err(AgentError::ContextTooLarge.into());
    }
    let mut activity = state.agent.activity.lock().unwrap();
    let drained = conversations::set_execution(
        state,
        conversation_id,
        conversations::ExecutionStatus::Idle,
        None,
    )
    .and_then(|()| {
        if activity.deleting.contains(conversation_id) {
            return Ok(None);
        }
        conversations::begin_from_queue(state, conversation_id)
    });
    match drained {
        Ok(Some(consumed)) => {
            if let Some(handle) = activity.executions.get(conversation_id) {
                handle.reset_send_now();
            }
            Ok(Some(consumed))
        }
        Ok(None) => {
            activity.release(conversation_id);
            Ok(None)
        }
        Err(error) => {
            activity.release(conversation_id);
            Err(error)
        }
    }
}

/// Deletes a Conversation only after its execution has really ended.
///
/// Native tools cannot be interrupted mid-call, so a mutation that already
/// started (a `write_files`, say) finishes before the rows go. While this
/// waits, the Conversation accepts no new send, `Send now` or queue drain.
pub async fn delete_conversation(state: &AppState, conversation_id: &str) -> Result<bool> {
    let handle = {
        let mut activity = state.agent.activity.lock().unwrap();
        activity.deleting.insert(conversation_id.to_string());
        activity.executions.get(conversation_id).cloned()
    };
    if let Some(handle) = handle {
        handle.cancel.cancel();
        handle.finished.cancelled().await;
    }
    background_compaction::discard(state, conversation_id);
    let job_state = state.clone();
    let job_owner = conversation_id.to_string();
    let cancelled =
        tokio::task::spawn_blocking(move || job_state.jobs.delete_conversation(&job_owner)).await;
    let deleted = match cancelled {
        Ok(()) => conversations::delete(state, conversation_id),
        Err(error) => Err(error.into()),
    };
    state
        .agent
        .activity
        .lock()
        .unwrap()
        .deleting
        .remove(conversation_id);
    deleted
}

pub fn edit_message(state: &AppState, id: &str, mid: &str, text: &str) -> Result<StoredMessage> {
    let text = text.trim();
    if text.is_empty() {
        return Err(AgentError::EmptyMessage.into());
    }
    let mut activity = state.agent.activity.lock().expect("agent activity");
    activity.ensure_idle(id)?;
    let conversation = conversations::get(state, id)?.ok_or(StoreError::NotFound)?;
    let model = conversation
        .current_model
        .ok_or(AgentError::NoModelConfigured)?;
    let provider = resolve_provider(state, &model)?;
    let native_options = state.agent.model_prefs(&model)?.native_options;
    let message = conversations::remember::edit(state, id, mid, text)?;
    background_compaction::discard(state, id);
    let handle = ExecutionHandle::new();
    activity.executions.insert(id.to_string(), handle.clone());
    drop(activity);
    // Editing removes a transcript suffix, so every client refetches its snapshot.
    events::transcript_replaced(state, id);
    events::execution_started(state, id, &model);
    spawn_execution(state, id, model, provider, native_options, handle);
    Ok(message)
}

pub fn branch_message(
    state: &AppState,
    id: &str,
    mid: &str,
) -> Result<conversations::Conversation> {
    let activity = state.agent.activity.lock().expect("agent activity");
    activity.ensure_idle(id)?;
    let branch = conversations::remember::branch(state, id, mid)?;
    drop(activity);
    events::conversation_updated(state, &branch.id);
    Ok(branch)
}
