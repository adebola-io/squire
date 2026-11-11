//! Request-local compaction for a switch to a smaller model. Nothing is
//! committed until the summary, model switch and submitted message can commit together.
use super::*;
use crate::providers::types::{ContentPart, Message, ModelEvent, ModelRequest, Role};
use anyhow::{bail, Context};
use futures_util::StreamExt;

pub(crate) fn estimate(system: &str, messages: &[Message]) -> usize {
    let mut bytes = system.len();
    let mut images = 0;
    for message in messages {
        for part in &message.parts {
            match part {
                ContentPart::Image { .. } => images += 1,
                ContentPart::Text { text } => bytes += text.len(),
                ContentPart::ToolResult { content, .. } => bytes += content.len(),
                ContentPart::ToolCall { args, name, .. } => {
                    bytes += args.to_string().len() + name.len()
                }
                ContentPart::ProviderState { data } => bytes += data.to_string().len(),
                // Reasoning without provider state (DeepSeek's, say) is
                // shown to the reader but never sent back to the model.
                ContentPart::Reasoning { opaque, .. } if opaque.is_null() => {}
                ContentPart::Reasoning { text, opaque } => {
                    bytes += text.as_ref().map_or(0, String::len) + opaque.to_string().len()
                }
            }
        }
    }
    bytes.div_ceil(3) + images * 2048 + messages.len() * 16
}

fn input_cost(
    text: &str,
    attachments: &[conversations::remember::NewAttachment],
    vision: bool,
) -> usize {
    text.len().div_ceil(3)
        + attachments
            .iter()
            .map(|attachment| attachment_cost(&attachment.mime_type, attachment.data.len(), vision))
            .sum::<usize>()
}

fn attachment_cost(mime: &str, bytes: usize, vision: bool) -> usize {
    if mime.starts_with("image/") && vision {
        2048
    } else if conversations::is_text_like(mime) {
        bytes.min(400_000).div_ceil(3) + 128
    } else {
        128
    }
}

pub(super) fn queued_cost(state: &AppState, id: &str, vision: bool) -> Result<usize> {
    Ok(conversations::queued(state, id)?
        .into_iter()
        .map(|message| {
            let attachments: usize = message
                .attachments
                .iter()
                .map(|attachment| attachment_cost(&attachment.mime_type, attachment.bytes, vision))
                .sum();
            estimate(
                "",
                &[Message {
                    role: Role::User,
                    parts: message.parts,
                }],
            ) + attachments
        })
        .sum())
}

// Reserve a practical response budget, not the provider's maximum possible
// generation. Some long-context models advertise hundreds of thousands of
// output tokens; subtracting all of those from every input needlessly forces
// compaction long before the actual context window is approached.
const RESPONSE_TOKEN_RESERVE: u32 = 32_768;

pub(crate) fn budget(
    state: &AppState,
    target: &ModelRef,
    text: &str,
    attachments: &[conversations::remember::NewAttachment],
) -> Result<usize> {
    let metadata = budget_metadata(state, target)?;
    let tools = if metadata.tools {
        tools::specs_estimated_tokens()
    } else {
        0
    };
    let overhead = tools + input_cost(text, attachments, metadata.vision) + 256;
    Ok((metadata
        .context_window
        .saturating_sub(metadata.max_output.min(RESPONSE_TOKEN_RESERVE)) as usize)
        .saturating_sub(overhead))
}

pub(crate) fn fits(
    state: &AppState,
    id: &str,
    target: &ModelRef,
    text: &str,
    attachments: &[conversations::remember::NewAttachment],
) -> Result<bool> {
    let conversation = conversations::get(state, id)?.ok_or(StoreError::NotFound)?;
    if conversation.current_model.is_none() {
        return Ok(estimate(&context::system_prompt(state, text)?, &[])
            <= budget(state, target, text, attachments)?);
    }
    let metadata = state.agent.metadata(target)?;
    // Sizing only: a tool call still running must not fail the check, or a
    // message sent while Squire works could never be queued.
    let context = conversations::estimate_context(state, id, Some(target), metadata.vision)?;
    Ok(estimate(&context.system_prompt, &context.messages)
        + queued_cost(state, id, metadata.vision)?
        <= budget(state, target, text, attachments)?)
}

pub(crate) async fn prepare(
    state: &AppState,
    id: &str,
    target: &ModelRef,
    text: &str,
    attachments: &[conversations::remember::NewAttachment],
    cancel: &CancellationToken,
) -> Result<conversations::remember::PreparedCompaction> {
    let conversation = conversations::get(state, id)?.ok_or(StoreError::NotFound)?;
    let current = conversation
        .current_model
        .context("Conversation has no current model")?;
    let metadata = budget_metadata(state, &current)?;
    let context =
        conversations::active_context_for_model(state, id, Some(&current), metadata.vision)?;
    let stored = conversations::context_messages(state, id)?;
    let last = stored.last().context("Conversation has no messages")?;
    let expected_seq = last.seq.context("Message has no sequence")?;
    let epoch = last.epoch_id.clone().context("Message has no epoch")?;
    // The context and the stored rows are separate reads, and a background
    // compaction runs while the conversation can still grow. If a message
    // landed between them, the cut below would drop the messages before it
    // from both the summary and the kept tail.
    anyhow::ensure!(
        context.last_seq == expected_seq,
        "Conversation changed while compaction was being prepared"
    );
    let target_budget = budget(state, target, text, attachments)?.saturating_sub(queued_cost(
        state,
        id,
        state.agent.metadata(target)?.vision,
    )?);
    let prompt_tokens = context.system_prompt.len().div_ceil(3);
    let active_messages: Vec<_> = stored
        .iter()
        .filter(|message| message.epoch_id.as_deref() == Some(&epoch))
        .collect();
    let last_user = active_messages
        .iter()
        .rposition(|message| message.role == Role::User)
        .unwrap_or(active_messages.len() - 1);
    let mut tail_index = context
        .messages
        .iter()
        .rposition(|message| {
            message.role == Role::User
                && message
                    .parts
                    .iter()
                    .any(|part| matches!(part, ContentPart::Text { .. }))
        })
        .unwrap_or(context.messages.len() - 1);
    let mut cut_seq = if last_user > 0 {
        active_messages[last_user - 1]
            .seq
            .context("Message has no sequence")?
    } else {
        expected_seq - 1
    };
    // Preserve the recent exchange when it fits; otherwise retain the latest
    // complete atomic message. Tool calls and results are one Message here.
    if last_user == 0 || estimate("", &context.messages[tail_index..]) > target_budget / 2 {
        tail_index = context
            .messages
            .iter()
            .rposition(|message| {
                message.role == last.role
                    && !message
                        .parts
                        .iter()
                        .all(|part| matches!(part, ContentPart::Image { .. }))
            })
            .context("No exact tail")?;
        cut_seq = expected_seq - 1;
    }
    if active_messages.len() == 1 {
        cut_seq = expected_seq;
        tail_index = context.messages.len();
    }
    let tail_tokens = estimate("", &context.messages[tail_index..]);
    if cut_seq < 1 || target_budget <= prompt_tokens + tail_tokens + 256 {
        return Err(AgentError::ContextTooLarge.into());
    }
    // Reasoning models spend part of this on thinking, so allow the model's
    // whole output limit; the summary's own size is checked after.
    let summary_tokens = (target_budget - prompt_tokens - tail_tokens)
        .saturating_sub(128)
        .min(metadata.max_output as usize) as u32;
    let prefix = context.messages[..tail_index].to_vec();
    let summary_prompt = concat!(
        "Summarize this conversation for continued work. ",
        "Preserve the objective, progress, decisions, constraints, important state, ",
        "outstanding work, relevant errors, ",
        "and identities of any running background jobs. ",
        "Do not perform actions. ",
        "Return only a concise portable summary with those section names where relevant.",
    );
    let tail_message = Message::text(Role::User, summary_prompt);
    let request = ModelRequest {
        conversation_id: id.into(),
        model: current.model_id.clone(),
        system: context.system_prompt,
        messages: prefix.into_iter().chain([tail_message]).collect(),
        tools: Vec::new(),
        native_options: state.agent.model_prefs(&current)?.native_options,
        max_output_tokens: Some(summary_tokens),
    };
    let provider = resolve_provider(state, &current)?;
    let started = chrono::Utc::now().timestamp_millis();
    let mut usage = None;
    let outcome = async {
        let mut stream = tokio::select! {
            _ = cancel.cancelled() => bail!("Model switch was cancelled"),
            result = provider.stream(request, cancel.child_token()) => result?,
        };
        let mut summary = String::new();
        let mut complete = false;
        loop {
            let event = tokio::select! {
                _ = cancel.cancelled() => bail!("Model switch was cancelled"),
                event = stream.next() => event,
            };
            let Some(event) = event else {
                break;
            };
            match event? {
                ModelEvent::TextDelta(text) => summary.push_str(&text),
                ModelEvent::Usage(reported) => usage = Some(reported),
                ModelEvent::Done {
                    stop_reason: crate::providers::types::StopReason::EndTurn,
                } => complete = true,
                ModelEvent::Done { .. } => bail!("Compaction did not finish successfully"),
                ModelEvent::ToolCall { .. } => bail!("Compaction returned a tool call"),
                _ => {}
            }
        }
        anyhow::ensure!(
            complete && !summary.trim().is_empty(),
            "Compaction returned an incomplete or empty summary"
        );
        if prompt_tokens + tail_tokens + summary.len().div_ceil(3) + 128 > target_budget {
            return Err(AgentError::ContextTooLarge.into());
        }
        Ok::<_, anyhow::Error>(summary)
    }
    .await;
    let status = if cancel.is_cancelled() {
        "cancelled"
    } else if outcome.is_ok() {
        "completed"
    } else {
        "error"
    };
    let error = outcome.as_ref().err().map(|e| format!("{e:#}"));
    let model_call_id = conversations::record_model_call(
        state,
        id,
        &current,
        "compaction",
        status,
        usage,
        error.as_deref(),
        started,
    )?;
    let summary = outcome?;
    Ok(conversations::remember::PreparedCompaction {
        epoch_id: epoch,
        expected_seq,
        cut_seq,
        summary,
        model: current,
        model_call_id,
    })
}

/// Releases a pending switch if the HTTP request is abandoned while awaiting
/// the summary. Without this guard a dropped request leaves an in-memory
/// execution and compacting indicator behind indefinitely, so even Stop
/// cannot make the Conversation usable again.
struct PendingSwitch<'a> {
    state: &'a AppState,
    id: &'a str,
    finished: bool,
}

impl Drop for PendingSwitch<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.state.agent.release(self.id);
            events::compaction_updated(
                self.state,
                self.id,
                "error",
                Some("Compaction request was interrupted"),
            );
        }
    }
}

/// HTTP sends await target-sized compaction when needed. Same-model active sends
/// still use the normal queue path; another request cannot enter a pending switch.
pub async fn send_with_switch(
    state: &AppState,
    id: &str,
    text: &str,
    requested: Option<ModelRef>,
    options: Value,
    attachments: &[conversations::remember::NewAttachment],
    client_message_id: Option<&str>,
) -> Result<StoredMessage> {
    if text.trim().is_empty() && attachments.is_empty() {
        return Err(AgentError::EmptyMessage.into());
    }
    anyhow::ensure!(
        options.is_null() || options.is_object(),
        "Native options must be a JSON object"
    );
    // A retried send returns the Message the first attempt stored or queued.
    if let Some(client_message_id) = client_message_id {
        if let Some(existing) = conversations::find_by_client_id(state, id, client_message_id)? {
            return Ok(existing);
        }
    }
    let conversation = conversations::get(state, id)?.ok_or(StoreError::NotFound)?;
    let target = requested
        .clone()
        .or(conversation.current_model.clone())
        .or_else(|| state.agent.default_model())
        .ok_or(AgentError::NoModelConfigured)?;
    resolve_provider(state, &target)?;
    anyhow::ensure!(!target.model_id.trim().is_empty(), "Model ID is required");
    // A running execution handles this through its queue.
    if state.agent.is_active(id) || fits(state, id, &target, text, attachments)? {
        return send_prepared(
            state,
            id,
            text,
            requested,
            options,
            attachments,
            client_message_id,
            None,
            true,
        );
    }
    if conversation.current_model.is_none() {
        return Err(AgentError::ContextTooLarge.into());
    }
    let handle = {
        let mut activity = state.agent.activity.lock().expect("agent activity");
        activity.ensure_idle(id)?;
        let handle = ExecutionHandle::new();
        activity.switching.insert(id.into());
        activity.executions.insert(id.into(), handle.clone());
        handle
    };
    let mut pending = PendingSwitch {
        state,
        id,
        finished: false,
    };
    events::compaction_updated(state, id, "running", None);
    let cached =
        background_compaction::take(state, id, &target, text, attachments, &handle.cancel).await;
    let prepared = match cached {
        Some(prepared) => Ok(prepared),
        None => prepare(state, id, &target, text, attachments, &handle.cancel).await,
    };
    let result = match prepared {
        Ok(prepared) if !handle.cancel.is_cancelled() => send_prepared(
            state,
            id,
            text,
            Some(target),
            options,
            attachments,
            client_message_id,
            Some((&prepared, handle)),
            true,
        ),
        Ok(_) => Err(anyhow::anyhow!("Model switch was cancelled")),
        Err(error) => Err(error),
    };
    match &result {
        Ok(_) => events::compaction_updated(state, id, "completed", None),
        Err(error) => {
            state.agent.release(id);
            events::compaction_updated(state, id, "error", Some(&format!("{error:#}")));
        }
    }
    pending.finished = true;
    result
}

/// Reconstructed branch history may be larger than its inherited current model.
/// Compact only the new branch, reserving it until the summary is committed.
pub fn branch_with_compaction(
    state: &AppState,
    id: &str,
    mid: &str,
) -> Result<conversations::Conversation> {
    // Preflight everything that can fail without a branch id: unknown
    // profile, missing metadata, or missing parent. The branch inherits its
    // model from the parent, so these checks are identical before creation.
    let target = {
        let parent = conversations::get(state, id)?.ok_or(StoreError::NotFound)?;
        match parent.current_model.clone() {
            None => None,
            Some(target) => {
                state.agent.metadata(&target)?;
                resolve_provider(state, &target)?;
                Some(target)
            }
        }
    };
    let branch = super::branch_message(state, id, mid)?;
    let Some(target) = target else {
        return Ok(branch);
    };
    // Any synchronous failure after this point must not leave an orphan
    // branch behind: clean it up before returning the error. Asynchronous
    // compaction errors remain on the branch itself (Error status), which is
    // the intentional recoverable path.
    let branch_id = branch.id.clone();
    let cleanup = |error: anyhow::Error| -> anyhow::Error {
        if let Err(cleanup_error) = conversations::delete(state, &branch_id) {
            tracing::error!(
                "Failed to clean up branch {branch_id} after error {error:#}: {cleanup_error:#}"
            );
        }
        error
    };
    if fits(state, &branch.id, &target, "", &[]).map_err(cleanup)? {
        return Ok(branch);
    }
    let handle = {
        let mut activity = state.agent.activity.lock().expect("agent activity");
        if activity.deleting.contains(&branch.id) || activity.executions.contains_key(&branch.id) {
            return Err(cleanup(StoreError::Busy.into()));
        }
        let running = conversations::ExecutionStatus::Running;
        conversations::set_execution(state, &branch.id, running, None).map_err(cleanup)?;
        let handle = ExecutionHandle::new();
        activity.switching.insert(branch.id.clone());
        activity
            .executions
            .insert(branch.id.clone(), handle.clone());
        handle
    };
    events::conversation_updated(state, &branch.id);
    events::compaction_updated(state, &branch.id, "running", None);
    let branch = match conversations::get(state, &branch.id)? {
        Some(branch) => branch,
        None => return Err(cleanup(StoreError::NotFound.into())),
    };
    let state = state.clone();
    let branch_id = branch.id.clone();
    tokio::spawn(async move {
        let result = async {
            let prepared = prepare(&state, &branch_id, &target, "", &[], &handle.cancel).await?;
            anyhow::ensure!(
                !handle.cancel.is_cancelled(),
                "Branch compaction was cancelled"
            );
            conversations::remember::finish_branch_compaction(&state, &branch_id, &prepared)
        }
        .await;
        if let Err(error) = &result {
            let status = if handle.cancel.is_cancelled() {
                conversations::ExecutionStatus::Stopped
            } else {
                conversations::ExecutionStatus::Error
            };
            if let Err(checkpoint_error) = conversations::set_execution(
                &state,
                &branch_id,
                status,
                Some(&format!("{error:#}")),
            ) {
                tracing::error!("Failed to record branch compaction error: {checkpoint_error:#}");
            }
        }
        state.agent.release(&branch_id);
        events::transcript_replaced(&state, &branch_id);
        match result {
            Ok(()) => events::compaction_updated(&state, &branch_id, "completed", None),
            Err(error) => {
                events::compaction_updated(&state, &branch_id, "error", Some(&format!("{error:#}")))
            }
        }
    });
    Ok(branch)
}
