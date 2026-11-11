//! Built-in provider directory. These are code-defined: display name, wire
//! kind, default base URL, key guidance and docs. They are materialized
//! into the providers table on startup (definitions refresh on directory
//! upgrades, secrets are never touched); nothing is seeded from settings.
//!
//! Wire rule: `anthropic` uses Messages, `responses` uses the Responses API,
//! `google` uses its own adapter, `opencode` routes each model to the format
//! OpenCode Go serves it on (see `opencode`), and the rest use Chat
//! Completions.

/// Bumped when a built-in definition changes, so existing installs pick up
/// the new base URL, name or kind. Secrets are never migrated.
pub const DIRECTORY_VERSION: u32 = 3;

pub struct BuiltinProvider {
    pub id: &'static str,
    pub display_name: &'static str,
    /// Adapter selector and catalog key: Anthropic Messages, OpenAI Responses,
    /// Google, or OpenAI-compatible Chat Completions.
    pub kind: &'static str,
    pub base_url: &'static str,
    pub session_header: Option<&'static str>,
    /// Short label for the key field, e.g. `"API key"`.
    pub key_label: &'static str,
    pub key_placeholder: &'static str,
    pub doc_url: &'static str,
    /// Icon name in the shared set.
    pub icon: &'static str,
}

pub const BUILTINS: &[BuiltinProvider] = &[
    BuiltinProvider {
        id: "anthropic",
        display_name: "Anthropic",
        kind: "anthropic",
        base_url: "https://api.anthropic.com",
        session_header: None,
        key_label: "API key",
        key_placeholder: "sk-ant-…",
        doc_url: "https://console.anthropic.com",
        icon: "anthropic",
    },
    BuiltinProvider {
        id: "openai",
        display_name: "OpenAI",
        kind: "openai",
        base_url: "https://api.openai.com/v1",
        session_header: None,
        key_label: "API key",
        key_placeholder: "sk-…",
        doc_url: "https://platform.openai.com",
        icon: "openai",
    },
    BuiltinProvider {
        id: "chatgpt",
        display_name: "ChatGPT",
        kind: "chatgpt",
        base_url: "https://chatgpt.com/backend-api/codex",
        session_header: None,
        key_label: "ChatGPT account",
        key_placeholder: "",
        doc_url: "https://chatgpt.com",
        icon: "openai",
    },
    BuiltinProvider {
        id: "openai-responses",
        display_name: "OpenAI Responses",
        kind: "responses",
        base_url: "https://api.openai.com/v1",
        session_header: None,
        key_label: "API key",
        key_placeholder: "sk-…",
        doc_url: "https://platform.openai.com",
        icon: "openai",
    },
    BuiltinProvider {
        id: "google",
        display_name: "Google",
        kind: "google",
        base_url: "https://generativelanguage.googleapis.com",
        session_header: None,
        key_label: "AI Studio API key",
        key_placeholder: "AIza…",
        doc_url: "https://ai.google.dev",
        icon: "google",
    },
    BuiltinProvider {
        id: "xai",
        display_name: "xAI",
        kind: "xai",
        base_url: "https://api.x.ai/v1",
        session_header: None,
        key_label: "API key",
        key_placeholder: "xai-…",
        doc_url: "https://docs.x.ai",
        icon: "xai",
    },
    BuiltinProvider {
        id: "deepseek",
        display_name: "DeepSeek",
        kind: "deepseek",
        base_url: "https://api.deepseek.com",
        session_header: None,
        key_label: "API key",
        key_placeholder: "sk-…",
        doc_url: "https://platform.deepseek.com",
        icon: "deepseek",
    },
    BuiltinProvider {
        id: "zai",
        display_name: "ZAI",
        kind: "glm",
        base_url: "https://api.z.ai/api/paas/v4",
        session_header: None,
        key_label: "API key",
        key_placeholder: "…",
        doc_url: "https://docs.z.ai",
        icon: "zai",
    },
    BuiltinProvider {
        id: "meta",
        display_name: "Meta",
        kind: "meta",
        base_url: "https://api.meta.ai/v1",
        session_header: None,
        key_label: "API key",
        key_placeholder: "…",
        doc_url: "https://dev.meta.ai/docs",
        icon: "meta",
    },
    BuiltinProvider {
        id: "openrouter",
        display_name: "OpenRouter",
        kind: "openrouter",
        base_url: "https://openrouter.ai/api/v1",
        session_header: None,
        key_label: "API key",
        key_placeholder: "sk-or-…",
        doc_url: "https://openrouter.ai",
        icon: "openrouter",
    },
    BuiltinProvider {
        id: "opencode-zen",
        display_name: "OpenCode Zen",
        kind: "opencode-zen",
        base_url: "https://opencode.ai/zen/v1",
        session_header: None,
        key_label: "API key",
        key_placeholder: "oc_sk_…",
        doc_url: "https://opencode.ai/docs/zen",
        icon: "opencode",
    },
    BuiltinProvider {
        id: "opencode-go",
        display_name: "OpenCode Go",
        kind: "opencode",
        base_url: "https://opencode.ai/zen/go/v1",
        session_header: Some("x-opencode-session"),
        key_label: "API key",
        key_placeholder: "oc_sk_…",
        doc_url: "https://opencode.ai",
        icon: "opencode",
    },
];
