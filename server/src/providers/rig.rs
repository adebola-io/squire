//! Rig Core is responsible for provider wire formats, streaming and signed replay.
//! Squire owns its conversation schema, tool execution and model discovery.
use super::catalog::ModelCatalog;
use super::types::{
    ContentPart, Message, ModelEvent, ModelProvider, ModelRequest, ModelStream, ProviderHttpError,
    Role, StopReason, Usage,
};
use super::wire;
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use futures_util::StreamExt;
use rig_core::{
    completion::{
        options::{Effort, Reasoning},
        CompletionRequest, FinishReason, ToolDefinition,
    },
    http_client::{middleware::HttpMiddleware, DynHttpClient, HeaderMap, Method, Uri},
    message::{
        AssistantContent, AssistantMessage, CallId, Message as RigMessage, MimeType, ToolFunction,
        ToolName, ToolResult, ToolResultContent, UserContent,
    },
    providers::{
        anthropic::AnthropicConfig,
        chatgpt,
        gemini::GeminiConfig,
        openai::{wire::Route, OpenAIConfig},
    },
    streaming::{Item, StreamEvent},
};
use serde_json::Value;
use std::{collections::HashMap, future::Future, pin::Pin, sync::Arc};
use tokio_util::sync::CancellationToken;

// OpenCode Go serves vision-capable DeepSeek models, while Rig's direct-DeepSeek
// dialect unconditionally converts images to placeholders. Keep DeepSeek's
// reasoning field without its text-only body restriction on gateway routes.
const DEEPSEEK_GATEWAY: rig_core::providers::openai::wire::Dialect = {
    let mut dialect = rig_core::providers::openai::wire::DEEPSEEK;
    dialect.name = "squire-deepseek-gateway";
    dialect.quirks.rewrite = rig_core::providers::openai::wire::BodyRewrite::None;
    dialect
};

#[derive(Clone, Copy)]
enum Wire {
    Anthropic,
    Gemini,
    Responses,
    Chat,
    DeepSeek,
    ChatGpt,
}

pub struct RigProvider {
    wire: Wire,
    base_url: String,
    api_key: String,
    model_catalog: Option<(Arc<ModelCatalog>, &'static str)>,
    chatgpt_account_id: Option<String>,
    deepseek_gateway: bool,
    session_header: Option<reqwest::header::HeaderName>,
    http: DynHttpClient,
}

impl RigProvider {
    pub fn new(
        base_url: &str,
        api_key: Option<String>,
        kind: &str,
        session_header: Option<&str>,
    ) -> Result<Self> {
        let wire = match kind {
            "anthropic" => Wire::Anthropic,
            "google" => Wire::Gemini,
            "responses" => Wire::Responses,
            "chatgpt" => Wire::ChatGpt,
            "deepseek" => Wire::DeepSeek,
            _ => Wire::Chat,
        };
        let base_url = base_url.trim_end_matches('/').to_string();
        let key = wire::api_key(api_key).unwrap_or_default();
        Ok(Self {
            wire,
            base_url,
            session_header: wire::session_header(session_header)?,
            http: DynHttpClient::new(rig_reqwest::ReqwestClient::from(wire::client()?)),
            api_key: key,
            model_catalog: None,
            chatgpt_account_id: None,
            deepseek_gateway: false,
        })
    }

    pub fn with_model_catalog(
        mut self,
        catalog: Option<Arc<ModelCatalog>>,
        kind: &'static str,
    ) -> Self {
        self.model_catalog = catalog.map(|catalog| (catalog, kind));
        self
    }

    /// OpenCode's Chat Completions gateway can serve image-capable DeepSeek models.
    pub fn with_deepseek_gateway(mut self) -> Self {
        self.deepseek_gateway = true;
        self
    }

    pub fn with_zen_gemini(mut self) -> Self {
        self.http = DynHttpClient::new(ZenGeminiTransport(self.http));
        self
    }

    pub fn with_chatgpt_account_id(mut self, account_id: Option<String>) -> Self {
        self.chatgpt_account_id = account_id;
        self
    }

    fn http_for(&self, conversation_id: &str) -> Result<DynHttpClient> {
        let Some(name) = &self.session_header else {
            return Ok(self.http.clone());
        };
        let value = conversation_id
            .parse()
            .context("Invalid model session ID header")?;
        Ok(self.http.clone().with_middleware(SessionHeader {
            name: name.clone(),
            value,
        }))
    }

    fn start(
        &self,
        model: &str,
        request: CompletionRequest,
        http: DynHttpClient,
    ) -> Result<rig_core::streaming::CompletionStream> {
        let result = match self.wire {
            Wire::Anthropic => AnthropicConfig::new(self.api_key.clone())
                .with_base_url(&self.base_url)
                .connect(http)
                .completion(model)
                .stream(request),
            Wire::Gemini => GeminiConfig::new(self.api_key.clone())
                .with_base_url(&self.base_url)
                .connect(http)
                .completion(model)
                .stream(request),
            Wire::Responses => OpenAIConfig::new(self.api_key.clone())
                .with_base_url(&self.base_url)
                .with_route(Route::Responses)
                .connect(http)
                .completion(model)
                .stream(request),
            Wire::Chat | Wire::DeepSeek => {
                let config = if serves_deepseek(self.wire, model) {
                    let dialect = if self.deepseek_gateway {
                        &DEEPSEEK_GATEWAY
                    } else {
                        &rig_core::providers::openai::wire::DEEPSEEK
                    };
                    OpenAIConfig::with_key(dialect, self.api_key.clone())
                } else {
                    OpenAIConfig::new(self.api_key.clone())
                };
                config
                    .with_base_url(&self.base_url)
                    .with_route(Route::Chat)
                    .connect(http)
                    .completion(model)
                    .stream(request)
            }
            Wire::ChatGpt => {
                let mut config = OpenAIConfig::with_key(&chatgpt::DIALECT, self.api_key.clone())
                    .with_base_url(&self.base_url);
                config.account_id.clone_from(&self.chatgpt_account_id);
                // Squire supplies the complete system prompt.
                config.instructions = None;
                config.connect(http).completion(model).stream(request)
            }
        };
        result.map_err(provider_error)
    }
}

/// Whether a request goes out in DeepSeek's dialect: DeepSeek's own API, or a
/// DeepSeek model behind any Chat Completions gateway.
fn serves_deepseek(wire: Wire, model: &str) -> bool {
    match wire {
        Wire::DeepSeek => true,
        Wire::Chat => model
            .rsplit('/')
            .next()
            .is_some_and(|name| name.to_ascii_lowercase().starts_with("deepseek")),
        _ => false,
    }
}

/// OpenCode's Gemini gateway exposes /models, while Rig's native Gemini wire
/// builds /v1beta/models and authenticates with a key query parameter.
#[derive(Clone)]
struct ZenGeminiTransport(DynHttpClient);

impl ZenGeminiTransport {
    fn rewrite<T>(
        mut request: rig_core::http_client::Request<T>,
    ) -> rig_core::http_client::Result<rig_core::http_client::Request<T>> {
        use rig_core::http_client::{Error, HeaderValue};

        let mut url = url::Url::parse(&request.uri().to_string()).map_err(Error::instance)?;
        let path = url.path().to_owned();
        let (prefix, model) = path.rsplit_once("/v1beta/models/").ok_or_else(|| {
            Error::instance(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Unexpected Zen Gemini path",
            ))
        })?;
        url.set_path(&format!("{prefix}/models/{model}"));

        let mut key = None;
        let mut params = Vec::new();
        for (name, value) in url.query_pairs() {
            if name == "key" {
                key = Some(value.into_owned());
            } else {
                params.push((name.into_owned(), value.into_owned()));
            }
        }
        url.set_query(None);
        if !params.is_empty() {
            url.query_pairs_mut().extend_pairs(params);
        }
        if let Some(key) = key {
            request
                .headers_mut()
                .insert("x-goog-api-key", HeaderValue::from_str(&key)?);
        }
        *request.uri_mut() = url.as_str().parse().map_err(Error::instance)?;
        Ok(request)
    }
}

impl rig_core::http_client::HttpClientExt for ZenGeminiTransport {
    fn send<T, U>(
        &self,
        request: rig_core::http_client::Request<T>,
    ) -> impl Future<
        Output = rig_core::http_client::Result<
            rig_core::http_client::Response<rig_core::http_client::LazyBody<U>>,
        >,
    > + Send
           + 'static
    where
        T: Into<axum::body::Bytes> + Send,
        U: From<axum::body::Bytes> + Send + 'static,
    {
        let client = self.0.clone();
        let request = Self::rewrite(request).map(|req| req.map(|body| body.into()));
        async move { client.send(request?).await }
    }

    fn send_multipart<U>(
        &self,
        request: rig_core::http_client::Request<rig_core::http_client::MultipartForm>,
    ) -> impl Future<
        Output = rig_core::http_client::Result<
            rig_core::http_client::Response<rig_core::http_client::LazyBody<U>>,
        >,
    > + Send
           + 'static
    where
        U: From<axum::body::Bytes> + Send + 'static,
    {
        let client = self.0.clone();
        async move { client.send_multipart(Self::rewrite(request)?).await }
    }

    fn send_streaming<T>(
        &self,
        request: rig_core::http_client::Request<T>,
    ) -> impl Future<Output = rig_core::http_client::Result<rig_core::http_client::StreamingResponse>>
           + Send
    where
        T: Into<axum::body::Bytes> + Send,
    {
        let client = self.0.clone();
        async move { client.send_streaming(Self::rewrite(request)?).await }
    }
}

/// Rig runs this hook against each outbound request while retaining the
/// provider's configured shared connection pool and transport settings.
struct SessionHeader {
    name: reqwest::header::HeaderName,
    value: reqwest::header::HeaderValue,
}

impl HttpMiddleware for SessionHeader {
    fn before_request_headers<'a>(
        &'a self,
        _method: &'a Method,
        _uri: &'a Uri,
        headers: &'a mut HeaderMap,
    ) -> Pin<Box<dyn Future<Output = rig_core::http_client::Result<()>> + Send + 'a>> {
        Box::pin(async move {
            headers.insert(self.name.clone(), self.value.clone());
            Ok(())
        })
    }
}

fn provider_error(error: rig_core::error::ProviderError) -> anyhow::Error {
    if let rig_core::error::ProviderError::ProviderResponse(reply) = &error {
        if let Some(status) = reply.status {
            return ProviderHttpError {
                status: status.as_u16(),
                body: reply.body.clone(),
            }
            .into();
        }
    }
    error.into()
}

fn image(url: &str) -> Result<UserContent> {
    if let Some(encoded) = url.strip_prefix("data:") {
        let (mime, base64) = encoded
            .split_once(";base64,")
            .context("Invalid image data URL")?;
        return Ok(UserContent::image_base64(
            base64.to_string(),
            rig_core::message::ImageMediaType::from_mime_type(mime),
            None,
        ));
    }
    Ok(UserContent::image_url(url.to_string(), None, None))
}

fn messages(messages: &[Message], system: &str) -> Result<Vec<RigMessage>> {
    let mut out = Vec::new();
    if !system.is_empty() {
        out.push(RigMessage::system(system));
    }
    for message in messages {
        let mut user = Vec::new();
        let mut assistant = Vec::new();
        let mut results = Vec::new();
        let names: HashMap<&str, &str> = message
            .parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::ToolCall { id, name, .. } => Some((id.as_str(), name.as_str())),
                _ => None,
            })
            .collect();
        let state = message.parts.iter().find_map(|part| match part {
            ContentPart::ProviderState { data } => Some(data),
            _ => None,
        });
        // ProviderState is Rig's serialized, complete assistant message.
        // Replaying it verbatim keeps all signed fields and provider IDs.
        let original: Option<AssistantMessage> = state
            .map(|data| serde_json::from_value(data.clone()))
            .transpose()
            .context("Invalid stored Rig assistant message")?;
        for part in &message.parts {
            match part {
                ContentPart::Text { text } if !text.is_empty() => match message.role {
                    Role::System => out.push(RigMessage::system(text)),
                    Role::User => user.push(UserContent::text(text)),
                    Role::Assistant if original.is_none() => {
                        assistant.push(AssistantContent::text(text))
                    }
                    Role::Assistant => {}
                },
                ContentPart::Image { url } if message.role == Role::User => user.push(image(url)?),
                ContentPart::ToolCall { id, name, args }
                    if message.role == Role::Assistant && original.is_none() =>
                {
                    let function = ToolFunction::new(ToolName::new(name.clone())?, args.clone());
                    assistant.push(AssistantContent::ToolCall(
                        rig_core::message::ToolCall::from_wire(id.clone(), function),
                    ));
                }
                ContentPart::ToolResult {
                    call_id,
                    content,
                    is_error,
                } => {
                    let (call, name) = match original.as_ref() {
                        Some(original) => {
                            let source = original
                                .tool_calls()
                                .find(|call| call.id.to_string() == *call_id)
                                .context("Stored tool result has no original Rig call")?;
                            (source.id.clone(), source.function.name.clone())
                        }
                        None => (
                            CallId::from_wire(call_id.clone()),
                            ToolName::new(
                                names
                                    .get(call_id.as_str())
                                    .context("Missing original tool call name")?
                                    .to_string(),
                            )?,
                        ),
                    };
                    results.push(ToolResult {
                        call,
                        name,
                        content: vec![ToolResultContent::text(content)],
                        is_error: *is_error,
                    });
                }
                _ => {}
            }
        }
        if !user.is_empty() {
            out.push(RigMessage::User { content: user });
        }
        if let Some(original) = original {
            out.push(RigMessage::Assistant(original));
        } else if !assistant.is_empty() {
            out.push(RigMessage::Assistant(AssistantMessage::new(assistant)));
        }
        if !results.is_empty() {
            out.push(RigMessage::tool_results(results));
        }
    }
    Ok(out)
}

fn build_request(
    request: &ModelRequest,
    wire: Wire,
    deepseek_gateway: bool,
) -> Result<CompletionRequest> {
    let mut messages = messages(&request.messages, &request.system)?;
    let last = messages
        .pop()
        .context("Model request contains no messages")?;
    let mut chat = CompletionRequest::new(last).messages(messages);
    if !request.tools.is_empty() {
        let tools = request
            .tools
            .iter()
            .map(|tool| {
                Ok(ToolDefinition::new(
                    ToolName::new(tool.name.clone())?,
                    tool.description.clone(),
                    tool.input_schema.clone(),
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        chat = chat.tools(tools);
    }
    if let Some(max) = request.max_output_tokens {
        chat = chat.max_tokens(max as u64);
    }
    let mut extra = match &request.native_options {
        Value::Null => serde_json::Map::new(),
        Value::Object(fields) => fields.clone(),
        _ => bail!("nativeOptions must be a JSON object"),
    };
    for name in [
        "model",
        "messages",
        "input",
        "tools",
        "stream",
        "system",
        "instructions",
        "store",
        "stream_options",
    ] {
        extra.remove(name);
    }
    // The composer selects a portable reasoning effort. Let Rig map it
    // to the selected wire format (reasoning.effort for Responses,
    // reasoning_effort for Chat Completions) rather than forwarding a
    // Chat Completions field to an incompatible endpoint.
    if let Some(effort) = extra.remove("reasoning_effort") {
        if effort == "none" && serves_deepseek(wire, &request.model) {
            // DeepSeek's off switch is its `thinking` toggle; its effort
            // values stop at low/high/max. A `thinking` the reader set in
            // their own native options wins.
            extra
                .entry("thinking")
                .or_insert_with(|| serde_json::json!({ "type": "disabled" }));
        } else if deepseek_gateway && serves_deepseek(wire, &request.model) {
            // The gateway dialect has no registered typed-option map.
            // Send OpenCode Go its native Chat Completions reasoning effort.
            let level: Effort =
                serde_json::from_value(effort).context("Invalid reasoning effort")?;
            extra.insert(
                "reasoning_effort".into(),
                Value::String(level.as_str().to_string()),
            );
        } else {
            let reasoning = if effort == "none" {
                Reasoning::Off
            } else {
                Reasoning::Effort(
                    serde_json::from_value::<Effort>(effort).context("Invalid reasoning effort")?,
                )
            };
            chat = chat.reasoning(reasoning);
        }
    }
    if let Some(max) = extra
        .remove("max_tokens")
        .or_else(|| extra.remove("max_output_tokens"))
        .or_else(|| extra.remove("max_completion_tokens"))
    {
        if request.max_output_tokens.is_none() {
            chat = chat.max_tokens(max.as_u64().context("Invalid max tokens setting")?);
        }
    }
    // Prompt-caching hints per wire format. Anthropic only caches
    // when asked; automatic caching uses one breakpoint slot and
    // keeps the frozen system prompt + stable tool order warm.
    // Responses uses a stable key per Conversation for the same.
    // User-supplied values always win over these defaults.
    if matches!(wire, Wire::Anthropic) && !extra.contains_key("cache_control") {
        extra.insert(
            "cache_control".to_string(),
            serde_json::json!({"type": "ephemeral"}),
        );
    }
    if matches!(wire, Wire::Responses) && !extra.contains_key("prompt_cache_key") {
        extra.insert(
            "prompt_cache_key".to_string(),
            Value::String(request.conversation_id.clone()),
        );
    }
    if !extra.is_empty() {
        chat = chat.additional_params(Some(Value::Object(extra)));
    }
    Ok(chat)
}

/// Canonical usage: `input` is total input tokens including cached tokens
/// (OpenAI semantics). Anthropic reports uncached input separately, so it is
/// summed here once. Every consumer (cost, `largest_request`, `note_served`)
/// then uses the same rule: ordinary = input - cached.
fn mapped_usage(usage: &rig_core::completion::Usage, wire: Wire) -> Usage {
    let cached_read = usage.cached_input_tokens.unwrap_or(0);
    let cached_write = usage.cache_creation_input_tokens.unwrap_or(0);
    let reported = usage.input_tokens.unwrap_or(0);
    let input = match wire {
        Wire::Anthropic => reported
            .saturating_add(cached_read)
            .saturating_add(cached_write),
        _ => reported,
    };
    Usage {
        input,
        output: usage.output_tokens.unwrap_or(0),
        cached_read,
        cached_write,
    }
}

fn mapped_stop(reason: Option<FinishReason>, has_tools: bool) -> StopReason {
    match reason {
        Some(FinishReason::Stop) if has_tools => StopReason::ToolUse,
        Some(FinishReason::Stop) => StopReason::EndTurn,
        Some(FinishReason::ToolCalls) => StopReason::ToolUse,
        Some(FinishReason::Length) => StopReason::MaxTokens,
        Some(FinishReason::ContentFilter) => StopReason::ContentFilter,
        Some(FinishReason::Other(reason)) => StopReason::Other(reason),
        Some(_) => StopReason::Other("unknown provider finish reason".into()),
        None if has_tools => StopReason::ToolUse,
        None => StopReason::EndTurn,
    }
}

#[async_trait]
impl ModelProvider for RigProvider {
    async fn list_models(&self) -> Result<Vec<String>> {
        let http = self.http.clone();
        let ids: Vec<String> = match self.wire {
            Wire::Anthropic => AnthropicConfig::new(self.api_key.clone())
                .with_base_url(&self.base_url)
                .connect(http)
                .list_models()
                .await?
                .data
                .into_iter()
                .map(|model| model.id)
                .collect(),
            Wire::Gemini => GeminiConfig::new(self.api_key.clone())
                .with_base_url(&self.base_url)
                .connect(http)
                .list_models()
                .await?
                .data
                .into_iter()
                .map(|model| model.id)
                .collect(),
            Wire::Responses | Wire::Chat | Wire::DeepSeek => {
                OpenAIConfig::new(self.api_key.clone())
                    .with_base_url(&self.base_url)
                    .connect(http)
                    .list_models()
                    .await?
                    .data
                    .into_iter()
                    .map(|model| model.id)
                    .collect()
            }
            Wire::ChatGpt => {
                let mut config = OpenAIConfig::with_key(&chatgpt::DIALECT, self.api_key.clone())
                    .with_base_url(&self.base_url);
                config.account_id.clone_from(&self.chatgpt_account_id);
                config
                    .connect(http)
                    .list_models()
                    .await?
                    .data
                    .into_iter()
                    .map(|model| model.id)
                    .collect()
            }
        };
        let mut ids = ids;
        ids.sort();
        ids.dedup();
        Ok(ids)
    }

    async fn stream(
        &self,
        request: ModelRequest,
        cancel: CancellationToken,
    ) -> Result<ModelStream> {
        let mut chat = build_request(&request, self.wire, self.deepseek_gateway)?;
        // Rig handles the mandatory Anthropic field. Its value comes from the
        // model's published maximum output capability, never a guessed limit.
        if matches!(self.wire, Wire::Anthropic) && chat.max_tokens.is_none() {
            let (catalog, kind) = self
                .model_catalog
                .as_ref()
                .context("Anthropic requires an explicit max_tokens or model catalog capability")?;
            let max = catalog
                .known_max_output(kind, &request.model)
                .with_context(|| {
                    format!(
                        "No published output limit for {} model {}",
                        kind, request.model
                    )
                })?;
            chat = chat.max_tokens(max as u64);
        }
        let http = self.http_for(&request.conversation_id)?;
        let mut reply = self.start(&request.model, chat, http)?;
        // Some gateways report wrong-wire errors in the first poll, not in
        // the construction of the lazy stream. Inspect it before route lock-in.
        let first = tokio::select! {
            _ = cancel.cancelled() => bail!("Model request was cancelled"),
            next = reply.next() => next,
        };
        let first = match first {
            Some(Err(error)) => return Err(provider_error(error)),
            other => other,
        };
        let wire = self.wire;
        let stream = async_stream::try_stream! {
            let mut first = first;
            let mut has_tools = false;
            loop {
                let next = if first.is_some() {
                    first.take()
                } else {
                    tokio::select! {
                        _ = cancel.cancelled() => None,
                        next = reply.next() => next,
                    }
                };
                if cancel.is_cancelled() { Err(anyhow::anyhow!("Model request was cancelled"))?; }
                let Some(item) = next else { break };
                match item.map_err(provider_error)? {
                    Item::Event(StreamEvent::Text { text, .. }) if !text.is_empty() => {
                        yield ModelEvent::TextDelta(text);
                    }
                    Item::Event(StreamEvent::Reasoning { text, .. }) if !text.is_empty() => {
                        yield ModelEvent::ReasoningDelta(text);
                    }
                    Item::Event(StreamEvent::End { content: AssistantContent::ToolCall(call), .. }) => {
                            has_tools = true;
                            yield ModelEvent::ToolCall {
                                id: call.id.to_string(),
                                name: call.function.name.to_string(),
                                args: Value::Object(call.function.arguments),
                            };
                    }
                    _ => {}
                }
            }
            let response = reply.finish().await.map_err(provider_error)?;
            // The complete SDK assistant message is the replay unit: never
            // reconstruct signed reasoning, tool identities or origin fields.
            let finish_reason = response.finish_reason();
            yield ModelEvent::ProviderState(serde_json::to_value(
                AssistantMessage::new(response.choice)
                    .with_origin(response.origin)
            )?);
            if response.usage.input_tokens.is_some() || response.usage.output_tokens.is_some() {
                yield ModelEvent::Usage(mapped_usage(&response.usage, wire));
            }
            yield ModelEvent::Done {
                stop_reason: mapped_stop(finish_reason, has_tools),
            };
        };
        Ok(Box::pin(stream))
    }
}
