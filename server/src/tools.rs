pub(crate) mod args;
mod filesystem;
mod gitignore;
pub(crate) mod recorder;
pub mod registry;
mod search;
mod web;

use crate::{connections, plugins, roots, skills, state::AppState, util};
use anyhow::{bail, Context, Result};
use recorder::{ThreadRecorder, ToolCallRecorder};
use serde_json::{json, Value};
use std::{fmt::Write as _, future::Future, path::PathBuf, pin::Pin};
use tokio_util::sync::CancellationToken;

pub use registry::{definition, definitions, schema, ToolDefinition};

#[derive(Debug)]
pub struct RunAttachment {
    pub mime: String,
    pub data: Vec<u8>,
}

#[derive(Debug)]
pub struct RunResult {
    pub activity_id: String,
    pub result: Value,
    /// Snapshotted attachment bytes in result order; sizes are `data.len()`.
    pub attachments: Vec<RunAttachment>,
}

/// One attachment slot owns both its staging directory (for fresh results)
/// and its trusted bytes (for replays), so the two can never drift apart.
#[derive(Clone, Default)]
pub(crate) struct AttachmentSlot {
    pub staging: Option<PathBuf>,
    pub bytes: Option<Vec<u8>>,
}

#[derive(Clone)]
pub(crate) struct ProducedResult {
    pub result: Value,
    pub attachments: Vec<AttachmentSlot>,
    /// The action worker owns this activity row, including while it is running.
    pub recorded: bool,
}

impl ProducedResult {
    pub fn new(result: Value, staging: Vec<Option<PathBuf>>) -> Self {
        Self {
            result,
            attachments: staging
                .into_iter()
                .map(|staging| AttachmentSlot {
                    staging,
                    bytes: None,
                })
                .collect(),
            recorded: false,
        }
    }
    pub fn success(value: Value) -> Self {
        Self::new(
            json!({ "structuredContent": if value.is_object() { value } else { json!({ "result": value }) } }),
            Vec::new(),
        )
    }
    pub fn error(error: impl ToString) -> Self {
        Self::new(connections::error_result(error), Vec::new())
    }
}

#[derive(Clone)]
pub(crate) struct CallContext {
    pub source: String,
    pub activity_id: Option<String>,
    pub owner: crate::jobs::JobOwner,
    pub cancellation: CancellationToken,
}

/// The thread a tool call is recorded under.
enum ThreadTarget {
    Existing(String),
    New { title: String, client: String },
}

fn success(value: Value) -> ProducedResult {
    ProducedResult::success(value)
}
fn error(error: impl ToString) -> ProducedResult {
    ProducedResult::error(error)
}

pub async fn run(state: &AppState, name: &str, args: Value) -> Result<RunResult> {
    run_with_source(state, name, args, "internal").await
}

pub async fn run_with_source(
    state: &AppState,
    name: &str,
    args: Value,
    source: &str,
) -> Result<RunResult> {
    if name == "start_thread" {
        bail!("Missing thread client");
    }
    run_with_source_and_client(state, name, args, source, "").await
}

pub async fn run_with_source_and_client(
    state: &AppState,
    name: &str,
    args: Value,
    source: &str,
    client: &str,
) -> Result<RunResult> {
    run_with_source_and_client_cancellable(
        state,
        name,
        args,
        source,
        client,
        CancellationToken::new(),
    )
    .await
}

/// Runs a tool with a caller-owned cancellation token. Actions and jobs honor
/// the token; blocking native work finishes on its blocking thread.
pub async fn run_with_source_and_client_cancellable(
    state: &AppState,
    name: &str,
    args: Value,
    source: &str,
    client: &str,
    cancellation: CancellationToken,
) -> Result<RunResult> {
    let is_start = name == "start_thread";
    let start_thread_args = if is_start {
        Some((
            start_thread_arg(&args, "title", registry::START_THREAD_TITLE_MAX_LENGTH)?,
            start_thread_arg(
                &args,
                "description",
                registry::START_THREAD_DESCRIPTION_MAX_LENGTH,
            )?,
        ))
    } else {
        None
    };
    let target = match &start_thread_args {
        Some((title, _)) => ThreadTarget::New {
            title: title.clone(),
            client: client.to_string(),
        },
        None => ThreadTarget::Existing(
            args.get("thread_id")
                .and_then(Value::as_str)
                .context("Missing thread_id.")?
                .to_string(),
        ),
    };
    // Serialize on this thread and hand owned rows to one blocking hop.
    let pending = connections::prepare_start(source, name, &args);
    let (thread_id, id) = blocking(state, move |state| {
        let thread_id = match target {
            ThreadTarget::Existing(thread_id) => thread_id,
            ThreadTarget::New { title, client } => {
                connections::create_thread(state, &title, &client)?
            }
        };
        let pending = match pending {
            Ok(pending) => pending,
            // Rare path: an unknown thread still wins over bad arguments.
            Err(error) => {
                if !connections::thread_exists(state, &thread_id)? {
                    bail!("Unknown thread_id.");
                }
                return Err(error);
            }
        };
        // The insert's foreign key is the thread check.
        ThreadRecorder {
            id: &pending.id,
            thread: &thread_id,
            pending: Some(&pending),
        }
        .start(state)?;
        Ok((thread_id, pending.id))
    })
    .await?;
    state.emit_thread_activity(&thread_id);
    let result = if let Some((title, description)) = &start_thread_args {
        let task = format!("{title}\n{description}");
        let (action_sets, ranked_actions) = plugins::thread_action_context(state, &task)?;
        let recommended = plugins::initial_actions_text(&ranked_actions);
        let action_summary = action_sets_summary_text(&action_sets);
        let actions = if recommended.is_empty() {
            action_summary
        } else {
            format!("{recommended}\n\n{action_summary}")
        };
        Ok(success(json!({
            "skills": compact_skills()?,
            "roots": roots::visible_paths_text(state)?,
            "thread_id": thread_id,
            "thread_guidance": "To avoid clutter, start_thread should not be called again. This thread_id can be reused for all subsequent Squire tool calls, even if the task or context changes. _One thread is enough_.",
            "actions": actions,
            "background_jobs": "Long-running Plugin Actions started with use_action are automatically promoted to background jobs after the foreground wait. Calling check_job waits briefly and may return running again. Calling cancel_job with that ID terminates the job. Long-running actions rely on Squire's background job management rather than rerunning the action, Python scripts, subprocesses, or polling loops.",
        })))
    } else {
        run_inner(
            state,
            name,
            args,
            CallContext {
                source: source.into(),
                activity_id: Some(id.clone()),
                owner: crate::jobs::JobOwner::Thread(thread_id.clone()),
                cancellation,
            },
        )
        .await
    };
    let produced = result.unwrap_or_else(error);
    if produced.recorded {
        let mimes = produced
            .result
            .get("attachments")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .map(|a| {
                        a.get("mimeType")
                            .and_then(Value::as_str)
                            .unwrap_or("application/octet-stream")
                            .to_string()
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let attachments = produced
            .attachments
            .into_iter()
            .enumerate()
            .filter_map(|(index, slot)| {
                slot.bytes.map(|data| RunAttachment {
                    mime: mimes.get(index).cloned().unwrap_or_default(),
                    data,
                })
            })
            .collect();
        return Ok(RunResult {
            activity_id: id,
            result: produced.result,
            attachments,
        });
    }
    // Result serialization, the database write and attachment snapshots are
    // all blocking work; keep them off the async workers.
    let finish_id = id.clone();
    let finished = blocking(state, move |state| {
        let recorder = ThreadRecorder {
            id: &finish_id,
            thread: "",
            pending: None,
        };
        recorder.finish(state, produced, 0)
    })
    .await?;
    state.emit_thread_activity(&thread_id);
    Ok(RunResult {
        activity_id: id,
        result: finished.result,
        attachments: finished
            .attachments
            .into_iter()
            .map(|a| RunAttachment {
                mime: a.mime,
                data: a.data,
            })
            .collect(),
    })
}

fn run_inner<'a>(
    state: &'a AppState,
    name: &'a str,
    args: Value,
    context: CallContext,
) -> Pin<Box<dyn Future<Output = Result<ProducedResult>> + Send + 'a>> {
    Box::pin(async move {
        let value = match name {
            "multi_tool_use_parallel" => return multi_tool(state, args, context).await,
            "use_action" => return crate::jobs::run(state, args, context).await,
            "check_job" => {
                return crate::jobs::check(
                    state,
                    util::arg_str(&args, "job")?,
                    &context.owner,
                    &context.cancellation,
                )
                .await
            }
            "cancel_job" => {
                return crate::jobs::cancel(state, util::arg_str(&args, "job")?, &context.owner)
                    .await
            }
            "ping" => Ok(json!("pong")),
            "read_files" => run_blocking(state, args, filesystem::read_files).await,
            "edit_files" => run_blocking(state, args, filesystem::edit_files).await,
            "write_files" => run_blocking(state, args, filesystem::write_files).await,
            "delete" => run_blocking(state, args, filesystem::delete).await,
            "mkdir" => run_blocking(state, args, filesystem::mkdir).await,
            "get_file_tree" => run_blocking(state, args, filesystem::file_tree).await,
            "search_files" => run_blocking(state, args, search::search_files).await,
            "search_file_contents" => search::search_file_contents(state, args).await,
            // A cold catalog reads and parses the plugin catalog, so stay off the
            // async workers.
            "search_actions" => run_blocking(state, args, search_actions).await,
            "use_skills" => {
                run_blocking(state, args, |_state, args| skills::use_skills(args)).await
            }
            "read_skill_resources" => {
                run_blocking(state, args, |_state, args| skills::read_resources(args)).await
            }
            "web_search" => web::search(state, args).await,
            "web_search_images" => return web::search_images(state, args).await,
            "fetch_page" => web::fetch_page(state, args).await,
            _ if plugins::action_exists(state, name) => {
                // Accept installed Action IDs directly, including parallel children.
                // Keep execution, validation and permissions on the use_action path.
                let mut action_args = args;
                if context.activity_id.is_some()
                    && matches!(&context.owner, crate::jobs::JobOwner::Thread(_))
                {
                    // Top-level Remote Access calls carry the routing thread_id,
                    // which is not an Action argument.
                    if let Some(args) = action_args.as_object_mut() {
                        args.remove("thread_id");
                    }
                }
                return crate::jobs::run(
                    state,
                    json!({ "action": name, "args": action_args }),
                    context,
                )
                .await;
            }
            _ => bail!("Unknown tool: {name}"),
        }?;
        Ok(success(value))
    })
}

async fn run_blocking(
    state: &AppState,
    args: Value,
    f: impl FnOnce(&AppState, Value) -> Result<Value> + Send + 'static,
) -> Result<Value> {
    blocking(state, move |state| f(state, args)).await
}

/// Runs blocking work (SQLite, filesystem) on the blocking pool.
async fn blocking<T: Send + 'static>(
    state: &AppState,
    f: impl FnOnce(&AppState) -> Result<T> + Send + 'static,
) -> Result<T> {
    let state = state.clone();
    tokio::task::spawn_blocking(move || f(&state)).await?
}

/// The native tools Squire's own agent calls, without an activity thread.
/// Discovery and dispatch use the same live catalog as external clients.
pub const AGENT_NATIVE_TOOLS: &[&str] = &[
    "read_files",
    "edit_files",
    "write_files",
    "delete",
    "mkdir",
    "get_file_tree",
    "search_files",
    "search_file_contents",
    "use_skills",
    "read_skill_resources",
    "search_actions",
    "use_action",
    "check_job",
    "cancel_job",
    "web_search",
    "web_search_images",
    "fetch_page",
];

/// Runs one native tool without recording it anywhere; the caller owns the
/// durable record. Paths still resolve against the live roots at dispatch.
pub(crate) async fn execute(
    state: &AppState,
    owner: crate::jobs::JobOwner,
    call_id: &str,
    name: &str,
    args: Value,
    cancellation: CancellationToken,
) -> ProducedResult {
    if !AGENT_NATIVE_TOOLS.contains(&name) && !plugins::action_exists(state, name) {
        return error(format!("Unknown tool: {name}"));
    }
    let context = CallContext {
        source: "conversation".into(),
        activity_id: Some(call_id.to_string()),
        owner,
        cancellation,
    };
    run_inner(state, name, args, context)
        .await
        .unwrap_or_else(error)
}

fn search_actions(state: &AppState, args: Value) -> Result<Value> {
    let (keywords, limit) = args::SearchActionsArgs::parse(&args)?;
    let keywords_ref: Vec<&str> = keywords.iter().map(String::as_str).collect();
    Ok(serde_json::to_value(plugins::search_actions(
        state,
        &keywords_ref,
        limit,
    )?)?)
}

fn start_thread_arg(args: &Value, name: &str, max_length: usize) -> Result<String> {
    let value = util::arg_str(args, name)?;
    if value.is_empty() {
        bail!("{name} must not be empty");
    }
    if value.chars().count() > max_length {
        bail!("{name} must be at most {max_length} characters");
    }
    Ok(value.to_string())
}

pub(crate) fn compact_skills() -> Result<String> {
    let mut output = String::new();
    for skill in skills::list()? {
        if !output.is_empty() {
            output.push('\n');
        }
        let _ = write!(
            output,
            "{} ({}) - {}",
            skill.name, skill.slug, skill.description
        );
    }
    Ok(output)
}

fn action_sets_summary_text(action_sets: &[String]) -> String {
    if action_sets.is_empty() {
        return "No Plugin Actions are installed.".to_string();
    }
    let names = action_sets.join(", ");
    format!(
        "Action sets available: {names}. If none of these match what you need, call search_actions with a few keywords."
    )
}

async fn multi_tool(
    state: &AppState,
    mut args: Value,
    context: CallContext,
) -> Result<ProducedResult> {
    let Some(Value::Array(calls)) = args.as_object_mut().and_then(|args| args.remove("calls"))
    else {
        bail!("Missing calls");
    };
    let mut tasks = Vec::with_capacity(calls.len());
    for call in calls {
        // Consume each call so its arguments move into the task.
        let mut call = match call {
            Value::Object(call) => call,
            _ => bail!("Missing tool"),
        };
        let tool = match call.remove("tool") {
            Some(Value::String(tool)) => tool,
            _ => bail!("Missing tool"),
        };
        let arguments = call.remove("arguments").unwrap_or(Value::Null);
        let task_tool = tool.clone();
        let state = state.clone();
        let context = CallContext {
            activity_id: None,
            ..context.clone()
        };
        let task = tokio::spawn(async move {
            run_inner(&state, &task_tool, arguments, context)
                .await
                .unwrap_or_else(error)
        });
        tasks.push((tool, task));
    }
    let mut results = Vec::with_capacity(tasks.len());
    let mut attachments = Vec::new();
    let mut slots = Vec::new();
    for (tool, task) in tasks {
        match task.await {
            Ok(ProducedResult {
                mut result,
                attachments: mut child_slots,
                ..
            }) => {
                if let Some(Value::Array(mut items)) = result
                    .as_object_mut()
                    .and_then(|result| result.remove("attachments"))
                {
                    if child_slots.len() != items.len() {
                        anyhow::bail!(
                            "Tool {tool} returned {} attachments but {} slots",
                            items.len(),
                            child_slots.len()
                        );
                    }
                    slots.append(&mut child_slots);
                    attachments.append(&mut items);
                } else if !child_slots.is_empty() {
                    anyhow::bail!("Tool {tool} returned slots without attachments");
                }
                result["tool"] = Value::String(tool);
                results.push(result);
            }
            Err(error) => results.push(json!({
                "tool": tool,
                "error": { "message": error.to_string() },
            })),
        }
    }
    let mut result = json!({ "structuredContent": { "results": results } });
    if !attachments.is_empty() {
        result["attachments"] = Value::Array(attachments);
    }
    Ok(ProducedResult {
        result,
        attachments: slots,
        recorded: false,
    })
}
