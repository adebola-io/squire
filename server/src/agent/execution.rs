//! One execution: model call → tool batch → model call … until the model
//! answers without tool calls (plan 008, "The loop"). Messages queued while
//! a tool call runs join context as soon as that batch ends.
//!
//! Each model response is committed atomically; transient text previews stream
//! independently and never enter history or model context. Tool
//! calls are durable records; their results reach the model as text. Every
//! write here defines execution state, so a storage failure ends the
//! execution with an error rather than being skipped.

use super::{context, finish_or_drain, tools, ExecutionHandle};
use crate::{
    conversations::{
        self, events, ExecutionStatus, NewToolCall, StoredMessage, ToolCallRecord, ToolCallStatus,
    },
    providers::types::{
        ContentPart, Message, ModelEvent, ModelProvider, ModelRef, Role, StopReason, Usage,
    },
    state::AppState,
};
use anyhow::{bail, Result};
use futures_util::{future::join_all, StreamExt};
use serde_json::Value;
use std::{sync::Arc, time::Instant};
use tokio_util::sync::CancellationToken;

const SKIPPED_AFTER_FAILURE: &str =
    "Not run: an earlier call in this batch failed, so later calls were skipped.";
const SKIPPED_AFTER_STOP: &str = "Not run: the user stopped Squire before this call started.";
const SKIPPED_FOR_NEW_MESSAGE: &str =
    "Not run: the user sent a new message before this call started.";
const INVALID_ARGUMENTS: &str = "Tool arguments were not valid JSON.";

/// Why model generation was abandoned. Either way the incomplete response is
/// discarded; after `Send now` the queue joins context before the next call.
#[derive(Debug, PartialEq)]
enum Interrupt {
    Stopped,
    Preempted,
}

impl std::fmt::Display for Interrupt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Interrupt::Stopped => "stopped",
            Interrupt::Preempted => "preempted by queued messages",
        })
    }
}

impl std::error::Error for Interrupt {}

fn interrupted(error: &anyhow::Error, kind: Interrupt) -> bool {
    error.downcast_ref() == Some(&kind)
}

struct Step {
    message: StoredMessage,
    stop_reason: StopReason,
    usage: Option<Usage>,
}

struct Finished {
    stop_reason: StopReason,
    usage: Usage,
}

pub(super) async fn run(
    state: AppState,
    conversation_id: String,
    model: ModelRef,
    provider: Arc<dyn ModelProvider>,
    mut native_options: Value,
    handle: ExecutionHandle,
) {
    let id = conversation_id.as_str();
    loop {
        // New user input can name an untitled conversation before the reply.
        crate::auto_title::schedule(&state, id);
        let outcome = execute(
            &state,
            id,
            &model,
            provider.clone(),
            &mut native_options,
            &handle,
        )
        .await;
        let drained = outcome
            .and_then(|finished| finish_or_drain(&state, id, &model).map(|next| (finished, next)));
        let next = match drained {
            Ok((finished, next)) => {
                events::execution_finished(
                    &state,
                    id,
                    "completed",
                    Some(stop_reason_name(&finished.stop_reason)),
                    Some(finished.usage),
                    None,
                );
                next
            }
            Err(error) if interrupted(&error, Interrupt::Stopped) => {
                conclude(&state, id, ExecutionStatus::Stopped, None);
                None
            }
            Err(error) => {
                let message = format!("{error:#}");
                conclude(&state, id, ExecutionStatus::Error, Some(&message));
                None
            }
        };
        // Queued Messages drain together into one new execution.
        let Some(consumed) = next else { break };
        native_options = consumed.native_options;
        for message in &consumed.messages {
            events::message_appended(&state, id, &message.id, "user");
        }
        events::queue_updated(&state, id);
        events::conversation_updated(&state, id);
        events::execution_started(&state, id, &model);
    }
    events::conversation_updated(&state, id);
}

/// Records how an execution ended and releases the Conversation. If even
/// that write fails, the client is told the execution failed, with why;
/// restart recovery later marks the stale checkpoint `interrupted`.
fn conclude(state: &AppState, id: &str, status: ExecutionStatus, error: Option<&str>) {
    let persisted = conversations::set_execution(state, id, status, error);
    state.agent.release(id);
    match persisted {
        Ok(()) => {
            let name = match status {
                ExecutionStatus::Stopped => "stopped",
                _ => "error",
            };
            events::execution_finished(state, id, name, None, None, error);
        }
        Err(persist_error) => {
            let message = match error {
                Some(error) => format!("{error}; then failed to record it: {persist_error:#}"),
                None => format!("Failed to record how the execution ended: {persist_error:#}"),
            };
            events::execution_finished(state, id, "error", None, None, Some(&message));
        }
    }
}

fn stop_reason_name(reason: &StopReason) -> &str {
    match reason {
        StopReason::EndTurn => "end_turn",
        StopReason::ToolUse => "tool_use",
        StopReason::MaxTokens => "max_tokens",
        StopReason::ContentFilter => "content_filter",
        StopReason::Other(other) => other,
    }
}

fn add_usage(total: &mut Usage, step: Option<Usage>) {
    if let Some(step) = step {
        total.input += step.input;
        total.output += step.output;
        total.cached_read += step.cached_read;
        total.cached_write += step.cached_write;
    }
}

/// Consumes the queued Messages into the transcript at a tool boundary and
/// returns the native options to use from now on, or `None` when nothing was
/// queued. Called after every tool batch, so a Message sent while a call ran
/// joins the conversation as soon as that call finishes instead of waiting
/// for the turn to end; it also satisfies a `Send now` request. An oversized
/// accumulated queue is never consumed.
fn drain_queue(
    state: &AppState,
    conversation_id: &str,
    model: &ModelRef,
    handle: &ExecutionHandle,
) -> Result<Option<Value>> {
    handle.reset_send_now();
    if !conversations::has_queued(state, conversation_id)? {
        return Ok(None);
    }
    if !super::switching::fits(state, conversation_id, model, "", &[])? {
        return Err(super::AgentError::ContextTooLarge.into());
    }
    let consumed = conversations::consume_queue(state, conversation_id)?;
    if consumed.messages.is_empty() {
        // Removed between the check above and here: nothing joined context.
        return Ok(None);
    }
    for message in &consumed.messages {
        events::message_appended(state, conversation_id, &message.id, "user");
    }
    events::queue_updated(state, conversation_id);
    Ok(Some(consumed.native_options))
}

/// No step limit: the loop runs until the model stops calling tools, the
/// user presses Stop, or an error ends it (plan 008).
async fn execute(
    state: &AppState,
    conversation_id: &str,
    model: &ModelRef,
    provider: Arc<dyn ModelProvider>,
    native_options: &mut Value,
    handle: &ExecutionHandle,
) -> Result<Finished> {
    let cancel = &handle.cancel;
    let mut usage = Usage::default();
    let vision = state.agent.metadata(model)?.vision;
    let mut cached_context =
        conversations::active_context_for_model(state, conversation_id, Some(model), vision)?;
    let mut context_tokens =
        super::switching::estimate(&cached_context.system_prompt, &cached_context.messages);
    loop {
        let send_now = handle.send_now_token();
        let step = match model_step(
            state,
            conversation_id,
            model,
            provider.clone(),
            native_options.clone(),
            cancel,
            &send_now,
            &cached_context,
        )
        .await
        {
            Ok(step) => step,
            Err(error) if interrupted(&error, Interrupt::Preempted) => {
                if let Some(options) = drain_queue(state, conversation_id, model, handle)? {
                    *native_options = options;
                }
                let appended = conversations::context_since(
                    state,
                    conversation_id,
                    Some(model),
                    vision,
                    cached_context.last_seq,
                    conversations::UnfinishedCalls::Reject,
                )?;
                cached_context.last_seq = appended.last_seq;
                context_tokens += super::switching::estimate("", &appended.messages);
                cached_context.messages.extend(appended.messages);
                continue;
            }
            Err(error) => return Err(error),
        };
        add_usage(&mut usage, step.usage);
        events::message_appended(state, conversation_id, &step.message.id, "assistant");
        if step.message.tool_calls.is_empty() {
            let latest = Message {
                role: Role::Assistant,
                parts: step.message.parts.clone(),
            };
            super::background_compaction::schedule(
                state,
                conversation_id,
                model,
                context_tokens + super::switching::estimate("", &[latest]),
            );
            return Ok(Finished {
                stop_reason: step.stop_reason,
                usage,
            });
        }
        run_batch(
            state,
            conversation_id,
            &step.message.tool_calls,
            cancel,
            &send_now,
        )
        .await?;
        events::conversation_updated(state, conversation_id);
        if cancel.is_cancelled() {
            return Err(Interrupt::Stopped.into());
        }
        // Whatever was queued while this batch ran joins context now, before
        // the next model call, rather than waiting for the turn to end.
        if let Some(options) = drain_queue(state, conversation_id, model, handle)? {
            *native_options = options;
        }
        let appended = conversations::context_since(
            state,
            conversation_id,
            Some(model),
            vision,
            cached_context.last_seq,
            conversations::UnfinishedCalls::Reject,
        )?;
        cached_context.last_seq = appended.last_seq;
        context_tokens += super::switching::estimate("", &appended.messages);
        cached_context.messages.extend(appended.messages);
        super::background_compaction::schedule(state, conversation_id, model, context_tokens);
    }
}

struct Response {
    text: String,
    reasoning: String,
    reasoning_items: Vec<ContentPart>,
    provider_state: Option<Value>,
    usage: Option<Usage>,
    calls: Vec<(String, String, Value)>,
    stop_reason: StopReason,
}

/// Collects the provider response, forwarding reasoning deltas immediately.
/// Only a complete response is persisted; Stop, `Send now` and failures discard it.
async fn collect_response(
    provider: Arc<dyn ModelProvider>,
    request: crate::providers::types::ModelRequest,
    state: &AppState,
    conversation_id: &str,
    cancel: &CancellationToken,
    send_now: &CancellationToken,
    reported_usage: &mut Option<Usage>,
) -> Result<Response> {
    let mut stream = tokio::select! {
        _ = cancel.cancelled() => return Err(Interrupt::Stopped.into()),
        _ = send_now.cancelled() => return Err(Interrupt::Preempted.into()),
        stream = provider.stream(request, cancel.clone()) => stream?,
    };
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut reasoning_items = Vec::new();
    let mut provider_state = None;
    let mut calls = Vec::new();
    let stop_reason = loop {
        let next = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Interrupt::Stopped.into()),
            _ = send_now.cancelled() => return Err(Interrupt::Preempted.into()),
            next = stream.next() => next,
        };
        match next {
            Some(Ok(ModelEvent::TextDelta(delta))) => text.push_str(&delta),
            Some(Ok(ModelEvent::ReasoningDelta(delta))) => {
                reasoning.push_str(&delta);
                events::reasoning_delta(state, conversation_id, &delta);
            }
            Some(Ok(ModelEvent::ReasoningItem { opaque, text })) => {
                reasoning_items.push(ContentPart::Reasoning { opaque, text });
            }
            Some(Ok(ModelEvent::ProviderState(data))) => provider_state = Some(data),
            Some(Ok(ModelEvent::Usage(reported))) => *reported_usage = Some(reported),
            Some(Ok(ModelEvent::ToolCall { id, name, args })) => calls.push((id, name, args)),
            Some(Ok(ModelEvent::Done { stop_reason })) => break stop_reason,
            Some(Err(error)) => return Err(error),
            None => bail!("Provider stream ended before the model finished its response"),
        }
    };
    Ok(Response {
        text,
        reasoning,
        reasoning_items,
        provider_state,
        usage: *reported_usage,
        calls,
        stop_reason,
    })
}

/// An empty model response is never accepted as a turn end: the model is
/// asked again with a repair nudge, and only after repeated empties does
/// the turn fail loudly instead of finishing idle with no answer.
const EMPTY_RESPONSE_RETRIES: usize = 2;
const EMPTY_RESPONSE_NUDGE: &str =
    "Your previous response was empty. Reply now with the answer as text.";

#[allow(clippy::too_many_arguments)]
async fn model_step(
    state: &AppState,
    conversation_id: &str,
    model: &ModelRef,
    provider: Arc<dyn ModelProvider>,
    native_options: Value,
    cancel: &CancellationToken,
    send_now: &CancellationToken,
    cached_context: &conversations::ActiveContext,
) -> Result<Step> {
    let metadata = state.agent.metadata(model)?;
    let mut request = context::model_request(
        conversation_id,
        cached_context,
        model,
        metadata.with_default_effort(native_options),
    );
    if !metadata.tools {
        request.tools.clear();
    }
    let model_started_at = Instant::now();
    let mut attempts: usize = 0;
    let (response, model_call) = loop {
        events::model_started(state, conversation_id, model);
        let started = chrono::Utc::now().timestamp_millis();
        let mut reported_usage = None;
        let response = collect_response(
            provider.clone(),
            request.clone(),
            state,
            conversation_id,
            cancel,
            send_now,
            &mut reported_usage,
        )
        .await;
        let accepted = response
            .as_ref()
            .is_ok_and(|r| !r.text.trim().is_empty() || !r.calls.is_empty());
        let status = match &response {
            Ok(_) if accepted => "completed",
            Ok(_) => "discarded",
            Err(error) if interrupted(error, Interrupt::Stopped) => "cancelled",
            Err(error) if interrupted(error, Interrupt::Preempted) => "discarded",
            Err(_) => "error",
        };
        let error = response.as_ref().err().map(|e| format!("{e:#}"));
        let call = conversations::record_model_call(
            state,
            conversation_id,
            model,
            "chat",
            status,
            reported_usage,
            error.as_deref(),
            started,
        )?;
        if accepted {
            break (response?, call);
        }
        events::model_finished(state, conversation_id, status, reported_usage, None, None);
        let response = response?;
        attempts += 1;
        if attempts > EMPTY_RESPONSE_RETRIES {
            if response.stop_reason == StopReason::MaxTokens {
                bail!("The model ran out of output tokens before answering. Try a shorter conversation or a model with a larger output budget.");
            }
            bail!("The model returned an empty response");
        }
        request
            .messages
            .push(Message::text(Role::User, EMPTY_RESPONSE_NUDGE));
    };

    let mut parts = Vec::new();
    if !response.reasoning.is_empty() {
        parts.push(ContentPart::Reasoning {
            opaque: Value::Null,
            text: Some(response.reasoning),
        });
    }
    parts.extend(response.reasoning_items);
    if let Some(data) = response.provider_state {
        parts.push(ContentPart::ProviderState { data });
    }
    if !response.text.is_empty() || response.calls.is_empty() {
        parts.push(ContentPart::Text {
            text: response.text,
        });
    }
    // Tool calls are stored only as ToolCall records; the provider-facing
    // parts are synthesized from them when building later requests.
    let new_calls: Vec<NewToolCall> = response
        .calls
        .into_iter()
        .map(|(call_id, name, args)| {
            let (label, mutative) = tools::metadata(state, &name, &args);
            NewToolCall {
                call_id,
                label,
                mutative,
                tool: name,
                args,
            }
        })
        .collect();
    let message = conversations::append_assistant(
        state,
        conversation_id,
        model,
        &parts,
        response.usage,
        &new_calls,
        model_call,
    )?;
    if let Some(usage) = response.usage {
        // `Usage::input` already includes cached tokens (see
        // `rig::mapped_usage`), so total served is input + output.
        state
            .agent
            .note_served(model, usage.input.saturating_add(usage.output));
    }
    events::model_finished(
        state,
        conversation_id,
        "completed",
        response.usage,
        Some(model_started_at.elapsed().as_millis() as u64),
        response.usage.and_then(|usage| {
            (model.profile_id != "chatgpt")
                .then(|| metadata.estimated_cost_usd(usage))
                .flatten()
        }),
    );
    Ok(Step {
        message,
        stop_reason: response.stop_reason,
        usage: response.usage,
    })
}

/// Runs one model response's tool calls in model-emitted order. Adjacent
/// read-only calls run in parallel; mutative calls run one at a time and
/// nothing overtakes them. In a batch that contains a mutation, a failure
/// stops the batch: later calls that have not started are skipped. Started
/// calls always finish (native tools are not cancellable mid-call); Stop and
/// `Send now` skip whatever has not started yet. A storage failure ends the
/// batch with an error once the started calls have finished.
async fn run_batch(
    state: &AppState,
    conversation_id: &str,
    calls: &[ToolCallRecord],
    cancel: &CancellationToken,
    send_now: &CancellationToken,
) -> Result<()> {
    let has_mutation = calls.iter().any(|call| call.mutative);
    let mut halted: Option<&str> = None;
    let mut index = 0;
    while index < calls.len() {
        if halted.is_none() && cancel.is_cancelled() {
            halted = Some(SKIPPED_AFTER_STOP);
        }
        if halted.is_none() && send_now.is_cancelled() {
            halted = Some(SKIPPED_FOR_NEW_MESSAGE);
        }
        if let Some(reason) = halted {
            skip(state, conversation_id, &calls[index], reason)?;
            index += 1;
            continue;
        }
        let end = if calls[index].mutative {
            index + 1
        } else {
            index
                + calls[index..]
                    .iter()
                    .take_while(|call| !call.mutative)
                    .count()
        };
        let outcomes = join_all(
            calls[index..end]
                .iter()
                .map(|call| run_one(state, conversation_id, call, cancel)),
        )
        .await
        .into_iter()
        .collect::<Result<Vec<bool>>>()?;
        index = end;
        if has_mutation && outcomes.iter().any(|succeeded| !succeeded) {
            halted = Some(SKIPPED_AFTER_FAILURE);
        }
    }
    Ok(())
}

fn skip(
    state: &AppState,
    conversation_id: &str,
    call: &ToolCallRecord,
    reason: &str,
) -> Result<()> {
    conversations::finish_tool_call(
        state,
        &call.id,
        ToolCallStatus::Skipped,
        None,
        Some(reason),
        None,
    )?;
    events::tool_finished(state, conversation_id, call);
    Ok(())
}

/// Runs one call and returns whether it succeeded. The call runs only once
/// its start is durably recorded, so no side effect happens unrecorded.
async fn run_one(
    state: &AppState,
    conversation_id: &str,
    call: &ToolCallRecord,
    cancellation: &CancellationToken,
) -> Result<bool> {
    use crate::tools::recorder::{ConversationRecorder, ToolCallRecorder};
    let recorder = ConversationRecorder {
        conversation: conversation_id,
        call,
    };
    recorder.start(state)?;
    events::tool_started(state, conversation_id, call);
    let started = Instant::now();
    let produced = match &call.args {
        Value::Object(_) => {
            crate::tools::execute(
                state,
                crate::jobs::JobOwner::Conversation(conversation_id.to_string()),
                &call.id,
                &call.tool,
                call.args.clone(),
                cancellation.clone(),
            )
            .await
        }
        _ => crate::tools::ProducedResult::error(INVALID_ARGUMENTS),
    };
    let result = recorder.finish(state, produced, started.elapsed().as_millis() as i64)?;
    Ok(crate::connections::result_error(&result.result).is_none())
}
