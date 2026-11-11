//! The model-facing tool surface for Squire's own agent (plan 008).
//!
//! Native tools are offered as JSON Schema without `thread_id`. Results go
//! back to the model as text. Per-tool `render_for_model` layouts are still
//! an open decision (plan 008, "Model-Facing Surface"); until then a result
//! is its compact structured content.

use crate::{
    providers::types::ToolSpec,
    state::AppState,
    tools::{definition, registry::SUMMARY_MAX_LENGTH, AGENT_NATIVE_TOOLS},
};
use serde_json::Value;
use std::{path::Path, sync::OnceLock};

/// Model-facing tool specs are process-static: definitions only change on
/// build. Cache them instead of rebuilding + re-serializing per model call
/// and per budget check.
static CACHED_SPECS: OnceLock<Vec<ToolSpec>> = OnceLock::new();
static CACHED_SPECS_TOKENS: OnceLock<usize> = OnceLock::new();

fn build_specs() -> Vec<ToolSpec> {
    AGENT_NATIVE_TOOLS
        .iter()
        .filter_map(|name| definition(name))
        .map(|tool| ToolSpec {
            name: tool.name.to_string(),
            description: tool.description.to_string(),
            input_schema: Value::Object(tool.agent_schema()),
        })
        .collect()
}

pub fn specs() -> Vec<ToolSpec> {
    CACHED_SPECS.get_or_init(build_specs).clone()
}

/// Rough token size of the cached tool specs, computed once.
pub fn specs_estimated_tokens() -> usize {
    *CACHED_SPECS_TOKENS.get_or_init(|| {
        let specs = CACHED_SPECS.get_or_init(build_specs);
        serde_json::to_vec(specs)
            .map(|bytes| bytes.len().div_ceil(3))
            .unwrap_or(0)
    })
}

/// A call's status label and whether it writes. Mutation affects ordering
/// and audit, never authorization.
pub fn metadata(state: &AppState, name: &str, args: &Value) -> (String, bool) {
    let action = if name == "use_action" {
        args.get("action").and_then(Value::as_str)
    } else {
        definition(name).is_none().then_some(name)
    };
    let mutative = if let Some(action) = action {
        // Unavailable Actions fail at dispatch; until then treat them as writes
        // so they never cross a write boundary.
        crate::plugins::action_is_mutative(state, action).unwrap_or(true)
    } else {
        definition(name).is_some_and(|tool| tool.mutative)
    };
    (label(name, args), mutative)
}

/// `fetch_pull_request_context` → `Fetch pull request context`. Action names
/// are identifiers, not verbs that can be conjugated, so the label is the
/// Action itself in sentence case; the Plugin's icon shows whose it is.
/// Words written entirely in capitals (`PR`, `URL`) keep their case.
fn humanize_identifier(identifier: &str) -> String {
    let mut words = vec![String::new()];
    let mut previous_lower = false;
    for c in identifier.chars() {
        let separator = c == '_' || c == '-' || c.is_whitespace();
        // Split camelCase at each lower-to-upper boundary.
        if separator || c.is_uppercase() && previous_lower {
            words.push(String::new());
        }
        previous_lower = c.is_lowercase() || c.is_ascii_digit();
        if !separator {
            words.last_mut().expect("words is never empty").push(c);
        }
    }
    let label = words
        .into_iter()
        .filter(|word| !word.is_empty())
        .map(|word| match word.chars().all(|c| !c.is_lowercase()) {
            true => word,
            false => word.to_lowercase(),
        })
        .collect::<Vec<_>>()
        .join(" ");
    let mut chars = label.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

fn file_name(path: &str) -> &str {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
}

/// `Read foo.ts` for one item, `Read 3 files` for several.
fn items_label(args: &Value, array: &str, field: Option<&str>, verb: &str, noun: &str) -> String {
    let items = args.get(array).and_then(Value::as_array);
    match items.map(Vec::len) {
        Some(1) => {
            let item = &items.unwrap()[0];
            let path = match field {
                Some(field) => item.get(field).and_then(Value::as_str),
                None => item.as_str(),
            };
            match path {
                Some(path) => format!("{verb} {}", file_name(path)),
                None => format!("{verb} 1 {noun}"),
            }
        }
        Some(count) if count > 1 => format!("{verb} {count} {noun}s"),
        _ => format!("{verb} {noun}s"),
    }
}

fn quoted(args: &Value, field: &str) -> String {
    args.get(field)
        .and_then(Value::as_str)
        .map(|value| {
            let short: String = value.chars().take(40).collect();
            format!(" for “{short}”")
        })
        .unwrap_or_default()
}

/// The human-readable live status line for a running call ("Editing
/// notes.md"), produced server-side so every client shows the same thing
/// (plan 008 event contract).
pub fn label(name: &str, args: &Value) -> String {
    match name {
        "read_files" => items_label(args, "files", Some("path"), "Reading", "file"),
        "edit_files" => items_label(args, "edits", Some("path"), "Editing", "file"),
        "write_files" => items_label(args, "files", Some("path"), "Writing", "file"),
        "delete" => items_label(args, "paths", None, "Deleting", "item"),
        "mkdir" => items_label(args, "paths", None, "Creating", "folder"),
        "get_file_tree" => match args.get("path").and_then(Value::as_str) {
            Some(path) => format!("Listing {}", file_name(path)),
            None => "Listing files".into(),
        },
        "search_files" => format!("Searching file names{}", quoted(args, "query")),
        "search_file_contents" => format!("Searching files{}", quoted(args, "regex")),
        "use_skills" => items_label(args, "skills", Some("skill"), "Using", "skill"),
        "read_skill_resources" => "Reading skill resources".into(),
        "search_actions" => "Searching Plugin Actions".into(),
        "use_action" => summary_text(args).unwrap_or_else(|| {
            args.get("action")
                .and_then(Value::as_str)
                .map(|action| {
                    humanize_identifier(action.split_once('.').map_or(action, |(_, name)| name))
                })
                .filter(|label| !label.is_empty())
                .unwrap_or_else(|| "Running Plugin Action".into())
        }),
        "check_job" => "Checking background job".into(),
        "cancel_job" => "Cancelling background job".into(),
        "web_search" => format!("Searching the web{}", quoted(args, "query")),
        "web_search_images" => format!("Searching images{}", quoted(args, "query")),
        "fetch_page" => "Fetching page".into(),
        other if other.contains('.') => humanize_identifier(other.split_once('.').unwrap().1),
        other => format!("Using {other}"),
    }
}

/// The model's own annotation of what a call does, if it provided one.
/// Empty, missing and non-string values fall back to the derived label at
/// the call site; overlong text is cut with an ellipsis.
fn summary_text(args: &Value) -> Option<String> {
    let text = args.get("summary")?.as_str()?;
    let collapsed: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    if collapsed.chars().count() <= SUMMARY_MAX_LENGTH {
        return Some(collapsed);
    }
    let mut short: String = collapsed.chars().take(SUMMARY_MAX_LENGTH - 1).collect();
    short.push('…');
    Some(short)
}

/// Turns a canonical tool result into the text the model sees.
///
/// The returned text is persisted as `model_text` and resent on every later
/// step, so it must stay complete and valid: no universal truncation here.
/// Per-tool output limits (file-size caps, output-byte caps, tree limits)
/// and explicit pagination at the tool boundary are the token controls.
/// A blind string cutoff would split JSON mid-object, silently drop
/// requested file content, and strand side-effecting action results.
pub fn render_for_model(result: &Value) -> String {
    if let Some(message) = crate::connections::result_error(result) {
        return message.to_string();
    }
    let content = result.get("structuredContent").unwrap_or(result);
    match content.get("result") {
        Some(Value::String(text)) if content.as_object().is_some_and(|map| map.len() == 1) => {
            text.clone()
        }
        _ => serde_json::to_string(content).unwrap_or_default(),
    }
}
