use super::filesystem::{non_grep_walk_builder, visible_existing_path};
use crate::{roots, state::AppState};
use anyhow::Result;
use grep::{
    regex::RegexMatcherBuilder,
    searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch},
};
use ignore::{DirEntry, Error as IgnoreError, WalkBuilder, WalkState};
use serde_json::{json, Value};
use std::{
    fmt::Write as _,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

const OMITTED_RESULTS: &str = "... omitted additional results";

fn search_scopes(state: &AppState, scope: Option<&str>) -> Result<Vec<PathBuf>> {
    if let Some(scope) = scope {
        return Ok(vec![visible_existing_path(state, scope)?]);
    }
    Ok(roots::enabled(state)?.visible().to_vec())
}

pub(crate) fn search_files(state: &AppState, args: Value) -> Result<Value> {
    let (query, max, scope) = super::args::SearchArgs::files(args)?;
    let query = query.to_lowercase();
    let mut matches = Vec::new();
    for scope in search_scopes(state, scope.as_deref())? {
        file_name_matches(&scope, &query, max + 1, &mut matches)?;
        if matches.len() > max {
            break;
        }
    }
    Ok(json!({ "content": format_results(&matches, max) }))
}

/// Appends paths under `scope` whose file name contains `query` (already
/// lowercased) until `matches` holds `limit` entries.
fn file_name_matches(
    scope: &Path,
    query: &str,
    limit: usize,
    matches: &mut Vec<String>,
) -> Result<()> {
    if matches.len() >= limit {
        return Ok(());
    }
    for entry in non_grep_walk_builder(scope).build() {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                tracing::debug!("search_files skipped entry: {error}");
                continue;
            }
        };
        let name = entry.file_name().to_str().unwrap_or("");
        if contains_ignore_case(name, query) {
            matches.push(entry.into_path().to_string_lossy().into_owned());
            if matches.len() >= limit {
                break;
            }
        }
    }
    Ok(())
}

/// Case-insensitive substring test against a lowercased `needle`, without
/// allocating for ASCII names.
fn contains_ignore_case(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    if haystack.is_ascii() && needle.is_ascii() {
        return haystack
            .as_bytes()
            .windows(needle.len())
            .any(|window| window.eq_ignore_ascii_case(needle.as_bytes()));
    }
    haystack.to_lowercase().contains(needle)
}

pub(crate) async fn search_file_contents(state: &AppState, args: Value) -> Result<Value> {
    let (regex, max, scope) = super::args::SearchArgs::contents(args)?;
    let max_file_size = state.config.settings.limits.max_file_size_bytes.get() as u64;
    let max_line_length = state.config.settings.limits.max_search_line_length.get();
    let scopes = search_scopes(state, scope.as_deref())?;
    tokio::task::spawn_blocking(move || {
        let matcher = Arc::new(
            RegexMatcherBuilder::new()
                .case_insensitive(true)
                .build(&regex)?,
        );
        let matches = Arc::new(AtomicUsize::new(0));
        let results = Arc::new(Mutex::new(Vec::<String>::new()));
        for scope in scopes {
            WalkBuilder::new(scope)
                .hidden(false)
                .max_filesize(Some(max_file_size))
                .filter_entry(|entry| entry.file_name() != ".git")
                .build_parallel()
                .run(|| {
                    let matcher = Arc::clone(&matcher);
                    let matches = Arc::clone(&matches);
                    let results = Arc::clone(&results);
                    let mut searcher = SearcherBuilder::new()
                        .binary_detection(BinaryDetection::quit(b'\x00'))
                        .line_number(true)
                        .build();
                    Box::new(move |entry: std::result::Result<DirEntry, IgnoreError>| {
                        if matches.load(Ordering::Relaxed) > max {
                            return WalkState::Quit;
                        }
                        let entry = match entry {
                            Ok(entry) => entry,
                            Err(error) => {
                                tracing::debug!("search skipped entry: {error}");
                                return WalkState::Skip;
                            }
                        };
                        if entry.file_type().is_some_and(|kind| kind.is_file()) {
                            let mut sink = SearchSink {
                                path: entry.path(),
                                results: &results,
                                matches: &matches,
                                max,
                                max_line_length,
                            };
                            if let Err(error) =
                                searcher.search_path(&*matcher, entry.path(), &mut sink)
                            {
                                // Unreadable files do not abort the whole search.
                                tracing::debug!(
                                    "search skipped unreadable {}: {error}",
                                    entry.path().display()
                                );
                                return WalkState::Skip;
                            }
                        }
                        if matches.load(Ordering::Relaxed) > max {
                            WalkState::Quit
                        } else {
                            WalkState::Continue
                        }
                    })
                });
            if matches.load(Ordering::Relaxed) > max {
                break;
            }
        }
        let truncated = matches.load(Ordering::Relaxed) > max;
        let mut lines = Arc::into_inner(results).unwrap().into_inner().unwrap();
        if truncated {
            lines.push(OMITTED_RESULTS.to_string());
        }
        Ok(json!({ "content": lines.join("\n") }))
    })
    .await?
}

/// Formats each match directly into its output line.
struct SearchSink<'a> {
    path: &'a Path,
    results: &'a Mutex<Vec<String>>,
    matches: &'a AtomicUsize,
    max: usize,
    max_line_length: usize,
}

impl Sink for SearchSink<'_> {
    type Error = std::io::Error;

    fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> std::io::Result<bool> {
        let index = self.matches.fetch_add(1, Ordering::Relaxed);
        if index >= self.max {
            return Ok(false);
        }
        let content = String::from_utf8_lossy(mat.bytes());
        let content = content.trim_end_matches('\n');
        let mut line = format!(
            "{}:{}:",
            self.path.to_string_lossy(),
            mat.line_number().unwrap_or(0)
        );
        match content.char_indices().nth(self.max_line_length) {
            Some((cut, _)) => {
                line.push_str(&content[..cut]);
                let omitted = content[cut..].chars().count();
                let _ = write!(line, " ... omitted {omitted} chars");
            }
            None => line.push_str(content),
        }
        self.results.lock().unwrap().push(line);
        Ok(true)
    }
}

fn format_results(results: &[String], max: usize) -> String {
    let mut output = results[..results.len().min(max)].join("\n");
    if results.len() > max {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(OMITTED_RESULTS);
    }
    output
}
