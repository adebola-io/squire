use serde_json::{json, Map, Value};

pub const START_THREAD_TITLE_MAX_LENGTH: usize = 120;
pub const START_THREAD_DESCRIPTION_MAX_LENGTH: usize = 600;
pub const TREE_MAX_DEPTH_MIN: usize = 1;
pub const TREE_MAX_DEPTH_MAX: usize = 4;
pub const TREE_MAX_RESULTS_MIN: usize = 1;
pub const TREE_MAX_RESULTS_MAX: usize = 1000;
pub const SEARCH_MAX_RESULTS_MIN: usize = 1;
pub const SEARCH_MAX_RESULTS_MAX: usize = 200;
pub const ACTIONS_LIMIT_MIN: usize = 1;
pub const ACTIONS_LIMIT_MAX: usize = 50;
pub const ACTIONS_KEYWORDS_MIN_ITEMS: usize = 1;
pub const ACTIONS_KEYWORDS_MAX_ITEMS: usize = 8;
pub const ACTIONS_KEYWORD_MIN_LEN: usize = 1;
pub const ACTIONS_KEYWORD_MAX_LEN: usize = 64;
pub const WEB_QUERY_MAX_LEN: usize = 600;
pub const WEB_QUERY_MAX_WORDS: usize = 75;
pub const WEB_IMAGES_QUERY_MAX_LEN: usize = 400;
pub const WEB_IMAGES_QUERY_MAX_WORDS: usize = 50;
pub const WEB_SEARCH_MAX_RESULTS_MIN: usize = 1;
pub const WEB_SEARCH_MAX_RESULTS_MAX: usize = 20;
pub const WEB_SEARCH_MAX_RESULTS_DEFAULT: usize = 10;
pub const WEB_IMAGES_MAX_RESULTS_MAX: usize = 12;
pub const WEB_IMAGES_MAX_RESULTS_DEFAULT: usize = 6;
pub const WEB_OUTPUT_BYTES_MIN: usize = 64;
pub const WEB_OUTPUT_BYTES_MAX: usize = 524_288;
pub const WEB_OUTPUT_BYTES_DEFAULT: usize = 64 * 1024;

/** Longest model-written call summary accepted in tool schemas. */
pub const SUMMARY_MAX_LENGTH: usize = 50;
pub const FILES_MAX_RESULTS_DEFAULT: usize = 50;

#[derive(Clone, Copy)]
pub struct ToolDefinition {
    pub name: &'static str,
    pub description: &'static str,
    pub mutative: bool,
}

impl ToolDefinition {
    /// Whether the tool reaches beyond this computer's own resources.
    pub fn open_world(&self) -> bool {
        matches!(self.name, "web_search" | "web_search_images" | "fetch_page")
    }

    pub fn input_schema(&self) -> Map<String, Value> {
        let mut schema = base_schema(self.name);
        if self.name != "start_thread" {
            schema["properties"]
                .as_object_mut()
                .expect("properties must be object")
                .insert("thread_id".into(), string());
            schema["required"]
                .as_array_mut()
                .expect("required must be array")
                .push(json!("thread_id"));
        }
        schema
    }

    /// Schema for Squire's own agent: no `thread_id`, because the executor
    /// receives the Conversation context directly (plan 008).
    pub fn agent_schema(&self) -> Map<String, Value> {
        base_schema(self.name)
    }
}

const DEFINITIONS: &[ToolDefinition] = &[
    tool("start_thread", "Start a Squire thread. Called only once, not before each tool call. `description` should summarize the task at hand; it is used to surface relevant Plugin Action sets.", false),
    tool("ping", "Simple test tool to confirm the server is working.", false),
    tool("multi_tool_use_parallel", "Run multiple Squire tools in parallel. Each call may include an arguments object for that tool's parameters.", true),
    tool("edit_files", "Apply exact text replacements across existing files.", true),
    tool("write_files", "Write complete UTF-8 content to one or more files.", true),
    tool(
        "delete",
        "Move existing files or directories to the system trash (the Recycle Bin on Windows), \
         where they can be restored. On Android, which has no trash, they are deleted permanently.",
        true,
    ),
    tool("mkdir", "Create directories.", true),
    tool("read_files", "Read UTF-8 text files from Squire roots. Files exceeding the configured read budget return a marked, truncated prefix rather than an error. Optionally pass start and end line numbers (1-indexed, inclusive) to select a range.", false),
    tool("search_files", "Search visible path names across Squire roots. Optionally narrow with an `in` path.", false),
    tool("search_file_contents", "Search file contents (source code, config, docs) across Squire roots with case-insensitive regex. Use this to find where a symbol, string, or pattern appears in the codebase. Optionally narrow with an `in` path.", false),
    tool("search_actions", "Search installed Plugin Actions by plain-text keywords. Returns the best `limit` matches (default 10) plus the `total` that matched. `args` is a TypeScript-style argument signature: `name:type!` is required, `\"a\"|\"b\"` is a literal union, `{ … }` is a nested object, `T[]` is an array, and a trailing `…` marks a signature cut for length.", false),
    tool("use_action", "Use an installed Plugin Action by fully qualified action name, summary and JSON args. Long-running actions are promoted to background jobs.", true),
    tool("check_job", "Check on a background job. Returns its result if it has finished, waiting briefly for it to finish if it is still running. use_action promotes an action to a background job when it runs longer than the foreground wait.", false),
    tool("cancel_job", "Stop a running background job.", true),
    tool("get_file_tree", "Get a capped directory tree for a visible directory. Defaults to depth 2.", false),
    tool("use_skills", "Expand skills into agent-ready context.", false),
    tool("read_skill_resources", "Read files inside skill directories.", false),
    tool("web_search", "Search the public web. Returns result titles, URLs, and snippets.", false),
    tool("web_search_images", "Search the public web for images. Returns the fetched images, their URLs and their source pages.", false),
    tool("fetch_page", "Fetch a public HTTPS page and return its readable text. Does not execute page scripts or open a visible browser.", false),
];

const fn tool(name: &'static str, description: &'static str, mutative: bool) -> ToolDefinition {
    ToolDefinition {
        name,
        description,
        mutative,
    }
}

pub fn definitions() -> &'static [ToolDefinition] {
    DEFINITIONS
}

pub fn definition(name: &str) -> Option<ToolDefinition> {
    DEFINITIONS
        .iter()
        .copied()
        .find(|definition| definition.name == name)
}

pub fn schema(name: &str) -> Map<String, Value> {
    definition(name)
        .map(|definition| definition.input_schema())
        .unwrap_or_else(|| object([], []))
}

fn base_schema(name: &str) -> Map<String, Value> {
    match name {
        "start_thread" => object(
            [
                (
                    "title",
                    json!({ "type": "string", "minLength": 1, "maxLength": START_THREAD_TITLE_MAX_LENGTH }),
                ),
                (
                    "description",
                    json!({ "type": "string", "minLength": 1, "maxLength": START_THREAD_DESCRIPTION_MAX_LENGTH }),
                ),
            ],
            ["title", "description"],
        ),
        "multi_tool_use_parallel" => object(
            [(
                "calls",
                json!({ "type": "array", "minItems": 1, "items": { "type": "object", "properties": { "tool": string(), "arguments": { "type": "object" } }, "required": ["tool"] } }),
            )],
            ["calls"],
        ),
        "edit_files" => object(
            [(
                "edits",
                json!({ "type": "array", "minItems": 1, "items": { "type": "object", "properties": { "path": string(), "find": string(), "replace": string() }, "required": ["path", "find", "replace"], "additionalProperties": false } }),
            )],
            ["edits"],
        ),
        "write_files" => object(
            [(
                "files",
                json!({ "type": "array", "minItems": 1, "items": { "type": "object", "properties": { "path": string(), "content": string() }, "required": ["path", "content"], "additionalProperties": false } }),
            )],
            ["files"],
        ),
        "delete" | "mkdir" => object(
            [(
                "paths",
                json!({ "type": "array", "minItems": 1, "items": string() }),
            )],
            ["paths"],
        ),
        "read_files" => object(
            [(
                "files",
                json!({ "type": "array", "minItems": 1, "items": { "type": "object", "properties": { "path": string(), "start": integer_min(1), "end": integer_min(1) }, "required": ["path"], "additionalProperties": false } }),
            )],
            ["files"],
        ),
        "search_files" => search_schema("query"),
        "search_file_contents" => search_schema("regex"),
        "search_actions" => object(
            [
                (
                    "keywords",
                    json!({ "type": "array", "minItems": ACTIONS_KEYWORDS_MIN_ITEMS, "maxItems": ACTIONS_KEYWORDS_MAX_ITEMS, "items": { "type": "string", "minLength": ACTIONS_KEYWORD_MIN_LEN, "maxLength": ACTIONS_KEYWORD_MAX_LEN } }),
                ),
                ("limit", integer_range(ACTIONS_LIMIT_MIN, ACTIONS_LIMIT_MAX)),
            ],
            ["keywords"],
        ),
        "use_action" => object(
            [
                (
                    "action",
                    json!({ "type": "string", "minLength": 1, "maxLength": 200 }),
                ),
                ("args", json!({ "type": "object" })),
                (
                    "summary",
                    json!({
                        "type": "string",
                        "minLength": 1,
                        "maxLength": SUMMARY_MAX_LENGTH,
                        "description": "Brief 2-4 word summary of what this action does, shown in the UI while it runs, e.g. \"Reading package.json\".",
                    }),
                ),
            ],
            ["action"],
        ),
        "check_job" | "cancel_job" => object([("job", string())], ["job"]),
        "get_file_tree" => object(
            [
                ("path", string()),
                (
                    "max_depth",
                    integer_range(TREE_MAX_DEPTH_MIN, TREE_MAX_DEPTH_MAX),
                ),
                (
                    "max_results",
                    integer_range(TREE_MAX_RESULTS_MIN, TREE_MAX_RESULTS_MAX),
                ),
            ],
            ["path"],
        ),
        "use_skills" => object(
            [(
                "skills",
                json!({ "type": "array", "minItems": 1, "items": { "type": "object", "properties": { "skill": string(), "include_resources": { "type": "boolean" } }, "required": ["skill"], "additionalProperties": false } }),
            )],
            ["skills"],
        ),
        "read_skill_resources" => object(
            [(
                "resources",
                json!({ "type": "array", "minItems": 1, "items": { "type": "object", "properties": { "skill": string(), "resource_path": string() }, "required": ["skill", "resource_path"], "additionalProperties": false } }),
            )],
            ["resources"],
        ),
        "web_search" => object(
            [
                (
                    "query",
                    json!({ "type": "string", "minLength": 1, "maxLength": WEB_QUERY_MAX_LEN, "description": format!("At most {WEB_QUERY_MAX_WORDS} whitespace-delimited words.") }),
                ),
                (
                    "region",
                    json!({ "type": "string", "pattern": "^[a-zA-Z]{2}-[a-zA-Z]{2}$", "description": "Optional country and search-language code, such as us-en or uk-en." }),
                ),
                (
                    "safe_search",
                    json!({ "type": "string", "enum": ["on", "moderate", "off"], "description": "Content filtering preference; defaults to moderate." }),
                ),
                (
                    "max_results",
                    integer_range(WEB_SEARCH_MAX_RESULTS_MIN, WEB_SEARCH_MAX_RESULTS_MAX),
                ),
                ("max_bytes", web_output_bytes_schema()),
            ],
            ["query"],
        ),
        "web_search_images" => object(
            [
                (
                    "query",
                    json!({ "type": "string", "minLength": 1, "maxLength": WEB_IMAGES_QUERY_MAX_LEN, "description": format!("At most {WEB_IMAGES_QUERY_MAX_WORDS} whitespace-delimited words.") }),
                ),
                (
                    "max_results",
                    integer_range(WEB_SEARCH_MAX_RESULTS_MIN, WEB_IMAGES_MAX_RESULTS_MAX),
                ),
                ("max_bytes", web_output_bytes_schema()),
            ],
            ["query"],
        ),
        "fetch_page" => object(
            [
                ("url", json!({ "type": "string", "minLength": 1 })),
                ("max_bytes", web_output_bytes_schema()),
            ],
            ["url"],
        ),
        _ => object([], []),
    }
}

fn search_schema(query: &'static str) -> Map<String, Value> {
    object(
        [
            (query, string()),
            (
                "max_results",
                integer_range(SEARCH_MAX_RESULTS_MIN, SEARCH_MAX_RESULTS_MAX),
            ),
            ("in", string()),
        ],
        [query],
    )
}

fn object<const P: usize, const R: usize>(
    properties: [(&str, Value); P],
    required: [&str; R],
) -> Map<String, Value> {
    Map::from_iter([
        ("type".into(), "object".into()),
        (
            "properties".into(),
            Value::Object(
                properties
                    .into_iter()
                    .map(|(key, value)| (key.to_owned(), value))
                    .collect(),
            ),
        ),
        (
            "required".into(),
            Value::Array(required.into_iter().map(Value::from).collect()),
        ),
    ])
}

fn string() -> Value {
    json!({ "type": "string" })
}

fn integer_min(minimum: usize) -> Value {
    json!({ "type": "integer", "minimum": minimum })
}

fn integer_range(minimum: usize, maximum: usize) -> Value {
    json!({ "type": "integer", "minimum": minimum, "maximum": maximum })
}

fn web_output_bytes_schema() -> Value {
    json!({
        "type": "integer",
        "minimum": WEB_OUTPUT_BYTES_MIN,
        "maximum": WEB_OUTPUT_BYTES_MAX,
        "description": "Maximum output bytes (64-524288; default 65536).",
    })
}
