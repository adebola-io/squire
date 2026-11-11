//! Provider-neutral model request/response types (plan 008).
//!
//! These are the only shapes the agent runtime sees. Each wire-format adapter
//! translates them to and from its own protocol, so persistence never depends
//! on a provider's message format.

use anyhow::Result;
use async_trait::async_trait;
use futures_util::stream::BoxStream;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

/// Identifies one model behind one provider profile.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    pub profile_id: String,
    pub model_id: String,
}

crate::text_enum! {
    pub enum Role {
        User = "user",
        Assistant = "assistant",
        System = "system",
    }
}

/// One part of a durable Message. Tool results are not Messages; adapters
/// synthesize whatever tool-result shape their protocol needs from ToolCalls.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ContentPart {
    Image {
        url: String,
    },
    Text {
        text: String,
    },
    /// Kept opaque so providers that require replaying their reasoning blocks
    /// can do so. `text` is the readable form, when the provider exposes one.
    Reasoning {
        #[serde(default, skip_serializing_if = "Value::is_null")]
        opaque: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    /// SDK-owned context for signed tool-call and reasoning replay.
    ProviderState {
        data: Value,
    },
    ToolCall {
        id: String,
        name: String,
        args: Value,
    },
    ToolResult {
        call_id: String,
        content: String,
        is_error: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub parts: Vec<ContentPart>,
}

impl Message {
    pub fn text(role: Role, text: impl Into<String>) -> Self {
        Self {
            role,
            parts: vec![ContentPart::Text { text: text.into() }],
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Clone, Debug)]
pub struct ModelRequest {
    /// Stable for every request of one Conversation. Providers use it to
    /// route a conversation consistently and keep its prompt cache warm.
    pub conversation_id: String,
    pub model: String,
    pub system: String,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolSpec>,
    /// Provider-native knobs (reasoning effort and the like), passed through
    /// untouched. Must be a JSON object or null.
    pub native_options: Value,
    pub max_output_tokens: Option<u32>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cached_read: u64,
    pub cached_write: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    EndTurn,
    ToolUse,
    MaxTokens,
    ContentFilter,
    Other(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum ModelEvent {
    TextDelta(String),
    ReasoningDelta(String),
    /// A completed reasoning item whose encrypted state must survive replay.
    ReasoningItem {
        opaque: Value,
        text: Option<String>,
    },
    /// Exact Responses output items. Only committed after response.completed.
    ProviderState(Value),
    /// A complete tool call, emitted once its arguments have fully arrived.
    ToolCall {
        id: String,
        name: String,
        args: Value,
    },
    Usage(Usage),
    Done {
        stop_reason: StopReason,
    },
}

/// An error from the provider's HTTP API, kept structured so callers can
/// tell transient failures (429, 5xx) from permanent ones.
#[derive(Debug)]
pub struct ProviderHttpError {
    pub status: u16,
    pub body: String,
}

impl std::fmt::Display for ProviderHttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Provider returned HTTP {}: {}", self.status, self.body)
    }
}

impl std::error::Error for ProviderHttpError {}

pub type ModelStream = BoxStream<'static, Result<ModelEvent>>;

// `async_trait` adds `#[must_use]` to methods returning boxed futures.
#[allow(clippy::double_must_use)]
#[async_trait]
pub trait ModelProvider: Send + Sync {
    async fn list_models(&self) -> Result<Vec<String>> {
        anyhow::bail!("This provider does not support model discovery")
    }
    async fn stream(&self, request: ModelRequest, cancel: CancellationToken)
        -> Result<ModelStream>;
}
