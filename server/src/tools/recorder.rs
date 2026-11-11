//! The persistence owner of a call. Dispatch never creates an Activity session
//! for a Conversation; both recorders share result validation and snapshots.
use crate::{
    connections,
    conversations::{self, ToolCallRecord},
    state::AppState,
    tools::ProducedResult,
};
use anyhow::Result;

pub(crate) trait ToolCallRecorder {
    fn record_id(&self) -> &str;
    fn start(&self, state: &AppState) -> Result<()>;
    /// Validate and snapshot the whole attachment batch before recording it.
    fn store_attachment(
        &self,
        state: &AppState,
        produced: ProducedResult,
    ) -> Result<connections::PreparedResult> {
        let prepared = connections::prepare_result(
            state,
            self.record_id(),
            produced.result,
            &produced.attachments,
        );
        clean_staging(&produced.attachments);
        prepared
    }
    fn finish(
        &self,
        state: &AppState,
        result: ProducedResult,
        duration_ms: i64,
    ) -> Result<connections::PreparedResult>;
}

pub(crate) struct ThreadRecorder<'a> {
    pub id: &'a str,
    pub thread: &'a str,
    pub pending: Option<&'a connections::PendingStart>,
}

impl ToolCallRecorder for ThreadRecorder<'_> {
    fn record_id(&self) -> &str {
        self.id
    }
    fn start(&self, state: &AppState) -> Result<()> {
        connections::insert_start(
            state,
            self.thread,
            self.pending.expect("prepared activity start"),
        )
    }

    fn finish(
        &self,
        state: &AppState,
        produced: ProducedResult,
        _duration_ms: i64,
    ) -> Result<connections::PreparedResult> {
        let prepared = self.store_attachment(state, produced)?;
        connections::finish_prepared(state, self.id, prepared)
    }
}

pub(crate) struct ConversationRecorder<'a> {
    pub conversation: &'a str,
    pub call: &'a ToolCallRecord,
}

impl ToolCallRecorder for ConversationRecorder<'_> {
    fn record_id(&self) -> &str {
        &self.call.id
    }
    fn start(&self, state: &AppState) -> Result<()> {
        conversations::start_tool_call(state, &self.call.id)
    }

    fn finish(
        &self,
        state: &AppState,
        produced: ProducedResult,
        duration_ms: i64,
    ) -> Result<connections::PreparedResult> {
        let prepared = self.store_attachment(state, produced)?;
        let prepared =
            conversations::finish_prepared_tool_call(state, &self.call.id, prepared, duration_ms)?;
        conversations::events::tool_finished(state, self.conversation, self.call);
        Ok(prepared)
    }
}

pub(crate) fn clean_staging(slots: &[crate::tools::AttachmentSlot]) {
    for slot in slots {
        if let Some(directory) = &slot.staging {
            let _ = std::fs::remove_dir_all(directory);
        }
    }
}
