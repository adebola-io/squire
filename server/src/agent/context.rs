//! Builds the frozen system prompt and model requests (plan 008).
//!
//! The behavioural core lives in `prompts/system.md` and
//! `prompts/rich-markdown.md`, embedded at compile time. The environment
//! sections below (OS, workspace trees, skills, plugins) are captured at
//! the start of a Conversation and frozen for prompt caching.
//! Paths in the tree are hints, never authorization:
//! native tools check the live roots at dispatch.

use super::tools;
use crate::{
    conversations::ActiveContext,
    plugins,
    providers::types::{ModelRef, ModelRequest},
    roots,
    state::AppState,
};
use anyhow::{Context, Result};
use serde_json::Value;

/// Behavioural core: the general-purpose system prompt and rich presentation guidance.
const STATIC_CORE: &str = concat!(
    include_str!("../../../prompts/system.md"),
    "\n\n",
    include_str!("../../../prompts/rich-markdown.md")
);

/// Builds the prompt that gets frozen into the Conversation. Failing to read
/// roots or skills is an error, never an empty list: a transient failure
/// must not become permanent conversation context.
pub fn system_prompt(state: &AppState, initial_task: &str) -> Result<String> {
    let roots = roots::workspace_trees_text(state).context("Could not read workspace folders")?;
    let mut skills = crate::tools::compact_skills().context("Could not read installed skills")?;
    if skills.is_empty() {
        skills = "(none installed)".into();
    }
    let (available_plugins, suggested_actions) =
        plugins::prompt_plugin_context(state, initial_task)
            .context("Could not read installed Plugins")?;
    let plugin_list = available_plugins.join("\n");
    let plugin_list = if plugin_list.is_empty() {
        "(none installed)".to_string()
    } else {
        plugin_list
    };
    let relevant_actions = plugins::initial_actions_text(&suggested_actions);
    let mut prompt = format!(
        "{STATIC_CORE}\n\n\
         Workspace trees (three levels; common generated folders omitted; large folders shortened):\n{roots}\n\n\
         Skills (expand with use_skills):\n{skills}\n\n\
         Plugins available to Squire:\n{plugin_list}\n\n\
         Squire finds plugin actions through search_actions and calls them using use_action \
         with a discovered `plugin.action` and its arguments.The user's goal can be achieved by combining \
         actions in one way or another.",
    );
    if !relevant_actions.is_empty() {
        prompt.push_str("\n\n");
        prompt.push_str(&relevant_actions);
    }
    Ok(prompt)
}

pub fn model_request(
    conversation_id: &str,
    context: &ActiveContext,
    model: &ModelRef,
    native_options: Value,
) -> ModelRequest {
    ModelRequest {
        conversation_id: conversation_id.to_string(),
        model: model.model_id.clone(),
        system: context.system_prompt.clone(),
        messages: context.messages.clone(),
        // Always the current build's definitions, not frozen (plan 008).
        tools: tools::specs(),
        native_options,
        max_output_tokens: None,
    }
}
