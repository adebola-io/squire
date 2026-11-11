//! Speculative compaction. Near the context threshold one summary is prepared
//! in the background, kept out of the active prompt, and used only when a
//! later send actually needs compaction. The epoch commit stays atomic with
//! that send.
use super::*;
use crate::conversations::remember::PreparedCompaction;
use crate::providers::types::ModelRef;
use anyhow::Context;
use std::{
    collections::hash_map::Entry,
    sync::atomic::{AtomicU64, Ordering},
};

const PRECOMPUTE_RATIO_PERCENT: usize = 85;
const PRECOMPUTE_MIN_TOKENS: usize = 64_000;

/// Tells attempts apart, so a failed one removes only its own entry.
static ATTEMPTS: AtomicU64 = AtomicU64::new(0);

/// The task owns an immutable transcript snapshot. A newer turn can keep using
/// the original prefix; only the messages since `cut_seq` need to fit beside it.
pub(super) struct Pending {
    model: ModelRef,
    attempt: u64,
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<Result<PreparedCompaction>>,
}

// Dropping a speculative result cancels provider work and the task, including
// when the waiting HTTP request disappears before it finishes.
impl Drop for Pending {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.task.abort();
    }
}

pub(super) fn discard(state: &AppState, id: &str) {
    state.agent.precomputed.lock().unwrap().remove(id);
}

/// Called after a completed model response or tool batch, never during a
/// partially written tool call. The caller does not wait for the summary.
/// A summary that is never used still costs model tokens; switching::prepare
/// records them in the model-call ledger unless the attempt is abandoned
/// mid-call.
pub(super) fn schedule(state: &AppState, id: &str, model: &ModelRef, estimated: usize) {
    if estimated < PRECOMPUTE_MIN_TOKENS || state.agent.precomputed.lock().unwrap().contains_key(id)
    {
        return;
    }
    let should_start = (|| -> Result<bool> {
        let limit = switching::budget(state, model, "", &[])?;
        Ok(estimated < limit
            && estimated.saturating_mul(100) >= limit.saturating_mul(PRECOMPUTE_RATIO_PERCENT))
    })();
    match should_start {
        Ok(true) => {}
        Ok(false) => return,
        Err(error) => {
            tracing::debug!(conversation = id, %error, "Could not estimate background compaction");
            return;
        }
    }
    let mut pending = state.agent.precomputed.lock().unwrap();
    let Entry::Vacant(slot) = pending.entry(id.to_owned()) else {
        return;
    };
    // Spawned under the lock, so an attempt that fails at once still finds
    // its entry to remove.
    let attempt = ATTEMPTS.fetch_add(1, Ordering::Relaxed);
    let state_clone = state.clone();
    let id_owned = id.to_owned();
    let task_model = model.clone();
    let cancel = CancellationToken::new();
    let task_cancel = cancel.clone();
    let task = tokio::spawn(async move {
        let result =
            switching::prepare(&state_clone, &id_owned, &task_model, "", &[], &task_cancel).await;
        if result.is_err() {
            // Otherwise the failed attempt would hold the slot, and nothing
            // would be prepared until the conversation's next send.
            forget(&state_clone, &id_owned, attempt);
        }
        result
    });
    slot.insert(Pending {
        model: model.clone(),
        attempt,
        cancel,
        task,
    });
    tracing::debug!(
        conversation = id,
        estimated,
        "Started background compaction"
    );
}

/// Removes `attempt`'s entry, leaving any newer one in place.
fn forget(state: &AppState, id: &str, attempt: u64) {
    let mut pending = state.agent.precomputed.lock().unwrap();
    let removed = pending
        .get(id)
        .is_some_and(|held| held.attempt == attempt)
        .then(|| pending.remove(id));
    drop(pending);
    drop(removed);
}

/// Consume a held result, or return None so the normal (fresh) compaction
/// runs. Never use a summary for a changed epoch/model or an oversized tail.
pub(super) async fn take(
    state: &AppState,
    id: &str,
    target: &ModelRef,
    text: &str,
    attachments: &[conversations::remember::NewAttachment],
    cancel: &CancellationToken,
) -> Option<PreparedCompaction> {
    let mut pending = state.agent.precomputed.lock().unwrap().remove(id)?;
    if pending.model != *target {
        return None;
    }
    let result = tokio::select! {
        _ = cancel.cancelled() => return None,
        result = &mut pending.task => result,
    };
    let mut prepared = match result {
        Ok(Ok(prepared)) => prepared,
        Ok(Err(error)) => {
            tracing::debug!(conversation = id, %error, "Background compaction failed");
            return None;
        }
        Err(error) => {
            tracing::debug!(conversation = id, %error, "Background compaction was interrupted");
            return None;
        }
    };
    let usable = (|| -> Result<bool> {
        let conversation = conversations::get(state, id)?.ok_or(StoreError::NotFound)?;
        if conversation.current_model.as_ref() != Some(target) || prepared.model != *target {
            return Ok(false);
        }
        let stored = conversations::context_messages(state, id)?;
        let Some(last) = stored.last() else {
            return Ok(false);
        };
        if last.epoch_id.as_deref() != Some(prepared.epoch_id.as_str())
            || last.seq.unwrap_or(0) < prepared.expected_seq
            || prepared.cut_seq >= prepared.expected_seq
        {
            return Ok(false);
        }
        // The prefix was frozen when the background task began. Later
        // messages stay verbatim if they fit. Edits explicitly discard the
        // cache, and epoch changes fail the check above.
        let metadata = state.agent.metadata(target)?;
        let tail = conversations::context_since(
            state,
            id,
            Some(target),
            metadata.vision,
            prepared.cut_seq,
            conversations::UnfinishedCalls::Omit,
        )?;
        let available = switching::budget(state, target, text, attachments)?
            .saturating_sub(switching::queued_cost(state, id, metadata.vision)?);
        let tail_tokens = switching::estimate("", &tail.messages);
        // A long tail since the summary is better summarized fresh than kept
        // verbatim beside an already old checkpoint.
        let tail_limit = 30_000_usize.min(available / 4);
        let used = switching::estimate(&tail.system_prompt, &tail.messages)
            + prepared.summary.len().div_ceil(3)
            + 128;
        if tail_tokens > tail_limit || used > available {
            return Ok(false);
        }
        prepared.expected_seq = last.seq.context("Missing sequence")?;
        Ok(true)
    })();
    match usable {
        Ok(true) if !cancel.is_cancelled() => {
            tracing::debug!(conversation = id, "Reusing background compaction");
            Some(prepared)
        }
        Ok(_) => None,
        Err(error) => {
            tracing::debug!(conversation = id, %error, "Could not reuse background compaction");
            None
        }
    }
}
