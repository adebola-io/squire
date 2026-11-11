//! The tool catalog this build executes, reported to the hosted Worker in the
//! `hello` message on every connection. The Worker serves `tools/list` from
//! the catalog its device last reported, so nothing here is shared at build
//! time and the two sides can be released independently.

use crate::tools;
use serde_json::{json, Map, Value};

pub fn tools() -> Vec<Value> {
    tools::definitions()
        .iter()
        .map(|definition| {
            json!({
                "name": definition.name,
                "description": definition.description,
                "inputSchema": definition.input_schema(),
                "annotations": annotations(definition),
            })
        })
        .collect()
}

fn annotations(definition: &tools::ToolDefinition) -> Map<String, Value> {
    Map::from_iter([
        (
            "readOnlyHint".into(),
            Value::Bool(!definition.mutative && definition.name != "start_thread"),
        ),
        ("destructiveHint".into(), Value::Bool(definition.mutative)),
        (
            "idempotentHint".into(),
            Value::Bool(matches!(
                definition.name,
                "ping" | "read_files" | "get_file_tree" | "search_files" | "search_file_contents"
            )),
        ),
        ("openWorldHint".into(), Value::Bool(definition.open_world())),
    ])
}
