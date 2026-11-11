use super::gitignore;
use crate::{roots, state::AppState, util};
use anyhow::{bail, Context, Result};
use ignore::WalkBuilder;
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
};

/// Upper bound on entries scanned for "did you mean" suggestions, so a typo
/// never costs a walk of an entire large root.
const SUGGESTION_SCAN_LIMIT: usize = 20_000;
/// Cap bytes scanned to reach late line ranges in very large files.
const READ_RANGE_SCAN_LIMIT: u64 = 32 * 1024 * 1024;

fn visible_path(state: &AppState, target: &str) -> Result<PathBuf> {
    let path = roots::resolve_safe(state, target)?;
    assert_not_git_ignored(&path)?;
    Ok(path)
}

fn readable_path(state: &AppState, target: &str) -> Result<PathBuf> {
    let path = roots::resolve_readable(state, target)?;
    assert_not_git_ignored(&path)?;
    Ok(path)
}

pub(crate) fn visible_existing_path(state: &AppState, target: &str) -> Result<PathBuf> {
    existing_path(state, target, false)
}

fn readable_existing_path(state: &AppState, target: &str) -> Result<PathBuf> {
    existing_path(state, target, true)
}

fn existing_path(state: &AppState, target: &str, readable: bool) -> Result<PathBuf> {
    let path = if readable {
        readable_path(state, target)?
    } else {
        visible_path(state, target)?
    };
    if !path.exists() {
        if path.starts_with(state.config.storage.attachments_dir()) {
            bail!("Path does not exist");
        }
        let name = path.file_name();
        let mut suggestions = Vec::new();
        let roots = roots::enabled(state)?;
        let root = roots
            .visible()
            .iter()
            .find(|root| path.starts_with(root))
            .context("Path escapes the allowed root directories")?;
        for entry in non_grep_walk_builder(root)
            .build()
            .take(SUGGESTION_SCAN_LIMIT)
        {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    tracing::debug!("suggestion scan skipped entry: {error}");
                    continue;
                }
            };
            if Some(entry.file_name()) == name {
                suggestions.push(entry.into_path());
                if suggestions.len() == 3 {
                    break;
                }
            }
        }
        if !suggestions.is_empty() {
            bail!(
                "Path does not exist. Did you mean one of these? {}",
                suggestions
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
        bail!("Path does not exist");
    }
    Ok(path)
}

pub(crate) fn visible_file_path(state: &AppState, target: &str) -> Result<PathBuf> {
    let path = readable_existing_path(state, target)?;
    if !path.is_file() {
        bail!("Not a file");
    }
    Ok(path)
}

pub(crate) fn visible_directory_path(state: &AppState, target: &str) -> Result<PathBuf> {
    let path = readable_existing_path(state, target)?;
    if !path.is_dir() {
        bail!("Not a directory");
    }
    Ok(path)
}

fn read_file(state: &AppState, args: &Value) -> Result<String> {
    let path = visible_file_path(state, util::arg_str(args, "path")?)?;
    // Parse once; reject wrong types instead of silently falling back.
    let start: Option<usize> = match args.get("start") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => Some(
            n.as_u64()
                .and_then(|v| usize::try_from(v).ok())
                .filter(|v| *v >= 1)
                .with_context(|| "start must be an integer >= 1")?,
        ),
        Some(_) => bail!("start must be an integer >= 1"),
    };
    let end: Option<usize> = match args.get("end") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => Some(
            n.as_u64()
                .and_then(|v| usize::try_from(v).ok())
                .filter(|v| *v >= 1)
                .with_context(|| "end must be an integer >= 1")?,
        ),
        Some(_) => bail!("end must be an integer >= 1"),
    };
    if start.zip(end).is_some_and(|(start, end)| end < start) {
        bail!("end must be greater than or equal to start");
    }
    let has_range = start.is_some() || end.is_some();
    let file = fs::File::open(&path)?;
    let len = file.metadata()?.len();
    let limit = if has_range {
        max_file_size(state)
    } else {
        max_read_file_size(state)
    };
    if has_range {
        read_text_range(file, len, limit, start.unwrap_or(1), end)
    } else {
        read_text_prefix(file, len, limit)
    }
}

/// Read only the allowed prefix rather than allocating the entire source.
fn read_text_prefix(file: fs::File, len: u64, limit: usize) -> Result<String> {
    let mut bytes = Vec::new();
    file.take((limit as u64).saturating_add(1))
        .read_to_end(&mut bytes)?;
    let truncated = len > limit as u64 || bytes.len() > limit;
    bytes.truncate(limit);
    let text = decode_read_text(&bytes, truncated)?;
    Ok(if truncated {
        marked_read_prefix(&text, limit, "file truncated; request a smaller range")
    } else {
        text
    })
}

/// Locate requested lines without keeping preceding lines in memory. Reading
/// beyond the output budget is allowed for locating a late range, but the
/// bounded scanner prevents a pathological request from walking a huge file.
fn read_text_range(
    file: fs::File,
    len: u64,
    limit: usize,
    start: usize,
    end: Option<usize>,
) -> Result<String> {
    read_text_range_bounded(file, len, limit, start, end, READ_RANGE_SCAN_LIMIT)
}

fn read_text_range_bounded(
    file: fs::File,
    len: u64,
    limit: usize,
    start: usize,
    end: Option<usize>,
    scan_limit: u64,
) -> Result<String> {
    let mut reader = BufReader::new(file.take(scan_limit));
    let mut selected = Vec::new();
    let mut line = Vec::new();
    let mut line_number = 1usize;
    let mut scanned = 0u64;
    let mut complete = false;
    let mut output_capped = false;

    loop {
        line.clear();
        let count = reader.read_until(b'\n', &mut line)?;
        if count == 0 {
            // EOF from Take may mean the scan cap, not the source file's EOF.
            complete = scanned >= len;
            break;
        }
        scanned += count as u64;
        let last_requested = end == Some(line_number);
        let line_complete = line.ends_with(b"\n") || scanned == len;
        if line_number >= start {
            let slice = if last_requested && line.ends_with(b"\n") {
                &line[..line.len() - 1]
            } else {
                &line[..]
            };
            let remaining = limit.saturating_sub(selected.len());
            if slice.len() > remaining {
                selected.extend_from_slice(&slice[..remaining]);
                output_capped = true;
                break;
            }
            selected.extend_from_slice(slice);
        }
        if last_requested {
            complete = line_complete;
            break;
        }
        line_number += 1;
    }

    let truncated = output_capped || !complete && scanned < len;
    let text = decode_read_text(&selected, truncated)?;
    Ok(if truncated {
        let reason = if output_capped {
            "file truncated at output limit; request a smaller range"
        } else {
            "file truncated at scan limit; request a smaller range"
        };
        marked_read_prefix(&text, limit, reason)
    } else {
        text
    })
}

fn decode_read_text(bytes: &[u8], truncated: bool) -> Result<String> {
    let valid_len = match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(error) if truncated && error.error_len().is_none() => error.valid_up_to(),
        Err(error) => return Err(error.into()),
    };
    Ok(String::from_utf8(bytes[..valid_len].to_vec())?)
}

/// Keep the truncation marker *inside* the output limit and on a UTF-8 boundary.
fn marked_read_prefix(text: &str, limit: usize, reason: &str) -> String {
    let detailed = format!("\n[{reason}]");
    let marker = if detailed.len() <= limit {
        detailed.as_str()
    } else if limit >= "\n[file truncated]".len() {
        "\n[file truncated]"
    } else {
        "\n[truncated]"
    };
    if marker.len() >= limit {
        return utf8_read_prefix(marker, limit).to_owned();
    }
    format!("{}{marker}", utf8_read_prefix(text, limit - marker.len()))
}

fn utf8_read_prefix(text: &str, limit: usize) -> &str {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

pub(crate) fn read_files(state: &AppState, args: Value) -> Result<Value> {
    let values = non_empty_array(&args, "files")?;
    let mut files = Vec::with_capacity(values.len());
    let mut errors = Vec::new();

    for file in values {
        let result = validate_object_fields(file, &["path", "start", "end"], "file")
            .and_then(|()| read_file(state, file));
        match result {
            Ok(content) => {
                let mut value = Map::new();
                for field in ["path", "start", "end"] {
                    if let Some(field_value) = file.get(field) {
                        value.insert(field.into(), field_value.clone());
                    }
                }
                value.insert("content".into(), Value::String(content));
                files.push(Value::Object(value));
            }
            Err(error) => errors.push(json!({
                "path": file.get("path"),
                "message": error.to_string(),
            })),
        }
    }

    Ok(json!({ "files": files, "errors": errors }))
}

pub(crate) fn edit_files(state: &AppState, args: Value) -> Result<Value> {
    let edits = non_empty_array(&args, "edits")?;
    let mut requests = Vec::with_capacity(edits.len());

    for edit in edits {
        validate_object_fields(edit, &["path", "find", "replace"], "edit")?;
        let path = visible_existing_file_for_mutation(state, required_str(edit, "path")?)?;
        let find = required_str(edit, "find")?;
        if find.is_empty() {
            bail!("find must not be empty");
        }
        requests.push(EditFileRequest {
            path,
            find,
            replace: required_str(edit, "replace")?,
        });
    }

    let mut files = Vec::<EditedFile>::new();
    let mut file_indexes = HashMap::<&Path, usize>::new();
    for request in &requests {
        if file_indexes.contains_key(request.path.as_path()) {
            continue;
        }
        let mut file = fs::File::open(&request.path)?;
        let len = file.metadata()?.len();
        if len as usize > max_file_size(state) {
            bail!("File too large");
        }
        let mut bytes = Vec::with_capacity(len as usize);
        file.read_to_end(&mut bytes)?;
        if is_binary(&bytes) {
            bail!("Binary files are not supported");
        }
        file_indexes.insert(&request.path, files.len());
        files.push(EditedFile {
            path: &request.path,
            content: String::from_utf8(bytes).context("Invalid UTF-8")?,
        });
    }

    for request in &requests {
        let file = &mut files[file_indexes[request.path.as_path()]];
        let mut matches = file
            .content
            .match_indices(request.find)
            .map(|(index, _)| index);
        let Some(index) = matches.next() else {
            bail!("Text not found in {}", request.path.display());
        };
        let others = matches.count();
        if others > 0 {
            bail!(
                "Text is ambiguous in {}: found {} matches",
                request.path.display(),
                others + 1
            );
        }
        file.content
            .replace_range(index..index + request.find.len(), request.replace);
    }

    for file in &files {
        if file.content.len() > max_file_size(state) {
            bail!("Updated file would be too large");
        }
    }
    for file in &files {
        fs::write(file.path, &file.content)?;
    }

    Ok(json!({
        "files": files.len(),
        "replacements": requests.len(),
    }))
}

/// Recover two unambiguous shapes emitted by some models while keeping
/// multi-file writes strict: a flat {path, content}, or a single file whose
/// path was placed alongside `files` instead of inside it.
fn normalize_write_files_args(mut args: Value) -> Value {
    let Some(object) = args.as_object_mut() else {
        return args;
    };

    if !object.contains_key("files") {
        if let (Some(path), Some(content)) = (
            object.get("path").and_then(Value::as_str),
            object.get("content").and_then(Value::as_str),
        ) {
            let files = json!([{ "path": path, "content": content }]);
            object.remove("path");
            object.remove("content");
            object.insert("files".into(), files);
        }
    } else if let Some(path) = object
        .get("path")
        .and_then(Value::as_str)
        .map(str::to_owned)
    {
        let mut moved = false;
        if let Some(files) = object.get_mut("files").and_then(Value::as_array_mut) {
            if files.len() == 1 {
                if let Some(file) = files[0].as_object_mut() {
                    if !file.contains_key("path") {
                        file.insert("path".into(), Value::String(path));
                        moved = true;
                    }
                }
            }
        }
        if moved {
            object.remove("path");
        }
    }

    args
}

pub(crate) fn write_files(state: &AppState, args: Value) -> Result<Value> {
    let args = normalize_write_files_args(args);
    let files = non_empty_array(&args, "files")?;
    let mut writes = Vec::with_capacity(files.len());

    for file in files {
        validate_object_fields(file, &["path", "content"], "file")?;
        let path = visible_write_path(state, required_str(file, "path")?)?;
        if path.is_dir() {
            bail!("Path is a directory");
        }
        let content = required_str(file, "content")?;
        if content.len() > max_file_size(state) {
            bail!("File content would be too large");
        }
        writes.push((path, content));
    }

    for (path, _) in &writes {
        fs::create_dir_all(path.parent().context("Missing parent")?)?;
    }
    for (path, content) in &writes {
        fs::write(path, content)?;
    }

    Ok(json!({ "files": writes.len() }))
}

pub(crate) fn delete(state: &AppState, args: Value) -> Result<Value> {
    mutate_paths(
        state,
        &args,
        true,
        |state, target| {
            let path = visible_path(state, target)?;
            if !path.exists() {
                bail!("Path does not exist");
            }
            Ok(path)
        },
        move_to_trash,
    )
}

/// Moves `path` to the system trash, the Recycle Bin on Windows, so a deletion can be undone.
/// A path that cannot be trashed is an error rather than a permanent deletion.
#[cfg(not(target_os = "android"))]
fn move_to_trash(path: &Path) -> Result<()> {
    #[allow(unused_mut)]
    let mut context = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        // The default asks Finder to delete, which needs permission to control Finder.
        context.set_delete_method(DeleteMethod::NsFileManager);
    }
    context
        .delete(path)
        .with_context(|| format!("Could not move {} to the trash", path.display()))
}

/// Android has no trash, so Termux deletes permanently.
#[cfg(target_os = "android")]
fn move_to_trash(path: &Path) -> Result<()> {
    if path.is_dir() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

pub(crate) fn mkdir(state: &AppState, args: Value) -> Result<Value> {
    mutate_paths(
        state,
        &args,
        false,
        |state, target| {
            let path = visible_write_path(state, target)?;
            if path.exists() && !path.is_dir() {
                bail!("Path exists and is not a directory");
            }
            Ok(path)
        },
        |path| fs::create_dir_all(path).map_err(Into::into),
    )
}

/// Prepares every path, then mutates them in order. With `disjoint`, no path may be inside
/// another: deleting a folder first would make a path inside it fail after the folder is gone.
/// A failure partway through leaves the earlier paths changed, and the error says how many.
fn mutate_paths(
    state: &AppState,
    args: &Value,
    disjoint: bool,
    prepare: impl Fn(&AppState, &str) -> Result<PathBuf>,
    mutate: impl Fn(&Path) -> Result<()>,
) -> Result<Value> {
    let values = non_empty_array(args, "paths")?;
    let mut paths = Vec::with_capacity(values.len());
    let mut seen = HashSet::with_capacity(values.len());
    for value in values {
        let path = prepare(state, value.as_str().context("Missing path")?)?;
        if !seen.insert(path.clone()) {
            bail!("Duplicate path");
        }
        paths.push(path);
    }
    if disjoint {
        ensure_disjoint(&paths)?;
    }
    for (done, path) in paths.iter().enumerate() {
        mutate(path).with_context(|| {
            format!(
                "{}: {done} of {} paths were already done",
                path.display(),
                paths.len()
            )
        })?;
    }
    Ok(json!({ "files": paths.len() }))
}

/// Fails when one path is inside another, before anything is changed.
fn ensure_disjoint(paths: &[PathBuf]) -> Result<()> {
    for outer in paths {
        if let Some(inner) = paths.iter().find(|p| *p != outer && p.starts_with(outer)) {
            bail!(
                "{} is inside {}; list only {}",
                inner.display(),
                outer.display(),
                outer.display()
            );
        }
    }
    Ok(())
}

struct EditFileRequest<'a> {
    path: PathBuf,
    find: &'a str,
    replace: &'a str,
}

struct EditedFile<'a> {
    path: &'a Path,
    content: String,
}

fn visible_write_path(state: &AppState, target: &str) -> Result<PathBuf> {
    let path = visible_path(state, target)?;
    // resolve_safe already canonicalized the nearest existing ancestor and
    // rejected escapes; only ensure the ancestor is a directory.
    let mut parent = path.parent().context("Missing parent")?;
    while !parent.exists() {
        parent = parent.parent().context("Missing parent")?;
    }
    if !parent.is_dir() {
        bail!("Parent is not a directory");
    }
    Ok(path)
}

fn visible_existing_file_for_mutation(state: &AppState, target: &str) -> Result<PathBuf> {
    let path = visible_path(state, target)?;
    if !path.exists() {
        bail!("Path does not exist");
    }
    if !path.is_file() {
        bail!("Not a file");
    }
    Ok(path)
}

fn non_empty_array<'a>(args: &'a Value, key: &str) -> Result<&'a Vec<Value>> {
    let values = args
        .get(key)
        .and_then(Value::as_array)
        .with_context(|| format!("Missing {key}"))?;
    if values.is_empty() {
        bail!("Missing {key}");
    }
    Ok(values)
}

fn required_str<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .with_context(|| format!("Missing {key}"))
}

fn validate_object_fields(value: &Value, allowed: &[&str], label: &str) -> Result<()> {
    let object = value.as_object().context("Invalid item")?;
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        bail!("Unknown {label} field: {key}");
    }
    Ok(())
}

struct TreeEntry {
    path: PathBuf,
    is_dir: bool,
    git_ignored: bool,
}

pub(crate) fn file_tree(state: &AppState, args: Value) -> Result<Value> {
    let default_max = state
        .config
        .settings
        .limits
        .tree_max_results
        .get()
        .min(super::registry::TREE_MAX_RESULTS_MAX)
        .max(super::registry::TREE_MAX_RESULTS_MIN);
    let (path, max_depth, max_results) = super::args::FileTreeArgs::parse(args, default_max)?;
    let path = visible_directory_path(state, &path)?;
    let mut entries = walk_entries(&path, max_depth, max_results + 1)?;
    append_git_ignored_children(&path, &mut entries)?;
    let truncated = entries.len() > max_results;
    entries.truncate(max_results);
    Ok(json!({ "content": render_tree(&path, &entries, max_depth, truncated) }))
}

pub(crate) fn non_grep_walk_builder(root: impl AsRef<Path>) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .filter_entry(|entry| entry.file_name() != ".git");
    builder
}

/// Walk entries (including `root` itself) with their kind taken from the
/// walker rather than an extra `stat` per path.
fn walk_entries(root: &Path, max_depth: usize, limit: usize) -> Result<Vec<TreeEntry>> {
    let mut builder = non_grep_walk_builder(root);
    builder.max_depth(Some(max_depth));
    let mut entries = Vec::new();
    for entry in builder.build() {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                tracing::debug!("file_tree skipped entry: {error}");
                continue;
            }
        };
        let is_dir = match entry.file_type() {
            Some(kind) if !kind.is_symlink() => kind.is_dir(),
            _ => entry.path().is_dir(),
        };
        entries.push(TreeEntry {
            path: entry.into_path(),
            is_dir,
            git_ignored: false,
        });
        if entries.len() >= limit {
            break;
        }
    }
    Ok(entries)
}

/// Lists the direct children of `dir` that git ignores, which the walker
/// skips.
fn append_git_ignored_children(dir: &Path, entries: &mut Vec<TreeEntry>) -> Result<()> {
    let mut children = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let is_dir = entry.file_type().is_ok_and(|kind| kind.is_dir());
        children.push((entry.path(), is_dir));
    }
    let ignored = gitignore::ignored_flags(
        dir,
        children
            .iter()
            .map(|(path, is_dir)| (path.as_path(), *is_dir)),
    )?;
    entries.extend(
        children
            .into_iter()
            .zip(ignored)
            .filter_map(|((path, is_dir), ignored)| {
                ignored.then_some(TreeEntry {
                    path,
                    is_dir,
                    git_ignored: true,
                })
            }),
    );
    Ok(())
}

struct TreeNode {
    name: String,
    is_dir: bool,
    truncated: bool,
    children: Vec<usize>,
}

/// Renders `entries` as an indented tree: directories first, then by name.
fn render_tree(root: &Path, entries: &[TreeEntry], max_depth: usize, truncated: bool) -> String {
    let mut nodes = vec![TreeNode {
        name: String::new(),
        is_dir: true,
        truncated: false,
        children: Vec::new(),
    }];
    let mut index = HashMap::<PathBuf, usize>::new();
    for entry in entries {
        let relative = entry.path.strip_prefix(root).unwrap_or(&entry.path);
        let depth_count = relative.components().count();
        let mut parent = 0;
        let mut current = PathBuf::new();
        for (depth, component) in relative.components().enumerate() {
            if depth > 0 && depth >= max_depth {
                break;
            }
            current.push(component);
            let node = match index.get(&current) {
                Some(&node) => node,
                None => {
                    let last = depth + 1 == depth_count;
                    let mut name = component.as_os_str().to_string_lossy().into_owned();
                    if last && entry.git_ignored {
                        name.push_str(" (git-ignored)");
                    }
                    nodes.push(TreeNode {
                        name,
                        is_dir: !last || entry.is_dir,
                        truncated: false,
                        children: Vec::new(),
                    });
                    let node = nodes.len() - 1;
                    nodes[parent].children.push(node);
                    index.insert(current.clone(), node);
                    node
                }
            };
            if nodes[node].is_dir && depth + 1 == max_depth {
                nodes[node].truncated = true;
            }
            parent = node;
        }
    }
    for node in 0..nodes.len() {
        let mut children = std::mem::take(&mut nodes[node].children);
        children.sort_by(|&left, &right| {
            let (left, right) = (&nodes[left], &nodes[right]);
            right
                .is_dir
                .cmp(&left.is_dir)
                .then_with(|| left.name.cmp(&right.name))
        });
        nodes[node].children = children;
    }

    let mut output = root.to_string_lossy().into_owned();
    render_children(&nodes, 0, &mut String::new(), &mut output);
    if truncated {
        output.push_str("\n... omitted 1");
    }
    output
}

fn render_children(nodes: &[TreeNode], node: usize, prefix: &mut String, output: &mut String) {
    let children = &nodes[node].children;
    for (position, &child) in children.iter().enumerate() {
        let last = position + 1 == children.len();
        let child = &nodes[child];
        output.push('\n');
        output.push_str(prefix);
        output.push_str(if last { "└── " } else { "├── " });
        output.push_str(&child.name);
        if child.is_dir {
            output.push('/');
        }
        if child.truncated {
            output.push_str(" ...");
        }
        let length = prefix.len();
        prefix.push_str(if last { "    " } else { "│   " });
        render_children(nodes, children[position], prefix, output);
        prefix.truncate(length);
    }
}

fn assert_not_git_ignored(path: &Path) -> Result<()> {
    let parent = nearest_existing_parent(path.parent().unwrap_or(path));
    if gitignore::is_ignored(parent, path, path.is_dir())? {
        bail!("Path is ignored by git and cannot be read through Squire tools");
    }
    Ok(())
}

fn nearest_existing_parent(path: &Path) -> &Path {
    path.ancestors()
        .find(|candidate| candidate.exists())
        .unwrap_or(path)
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|byte| *byte == 0)
}

fn max_file_size(state: &AppState) -> usize {
    state.config.settings.limits.max_file_size_bytes.get()
}

fn max_read_file_size(state: &AppState) -> usize {
    state.config.settings.limits.max_read_file_size_bytes.get()
}
