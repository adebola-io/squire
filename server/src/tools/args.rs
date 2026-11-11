//! Typed tool arguments: one `Deserialize` struct per tool.
//!
//! Parsing once via `serde_json::from_value` replaces hand-rolled
//! `arg_str`/`arg_usize` per field, so wrong types are rejected instead of
//! silently falling back to defaults. Range limits share the constants in
//! [`super::registry`], the same constants the JSON schemas are built from,
//! so schema and parser cannot drift apart.
use super::registry;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

fn deserialize_args<T: for<'de> Deserialize<'de>>(args: Value, tool: &str) -> Result<T> {
    serde_json::from_value(args).with_context(|| format!("Invalid arguments for {tool}"))
}

#[derive(Deserialize)]
pub struct FileTreeArgs {
    pub path: String,
    #[serde(default = "default_depth")]
    pub max_depth: usize,
    #[serde(default)]
    pub max_results: Option<usize>,
}

fn default_depth() -> usize {
    2
}

impl FileTreeArgs {
    pub fn parse(args: Value, default_max: usize) -> Result<(String, usize, usize)> {
        let parsed: Self = deserialize_args(args, "get_file_tree")?;
        if parsed.path.trim().is_empty() {
            anyhow::bail!("Missing path");
        }
        if !(registry::TREE_MAX_DEPTH_MIN..=registry::TREE_MAX_DEPTH_MAX)
            .contains(&parsed.max_depth)
        {
            anyhow::bail!(
                "max_depth must be between {} and {}",
                registry::TREE_MAX_DEPTH_MIN,
                registry::TREE_MAX_DEPTH_MAX
            );
        }
        let max_results = parsed.max_results.unwrap_or(default_max);
        if !(registry::TREE_MAX_RESULTS_MIN..=registry::TREE_MAX_RESULTS_MAX).contains(&max_results)
        {
            anyhow::bail!(
                "max_results must be between {} and {}",
                registry::TREE_MAX_RESULTS_MIN,
                registry::TREE_MAX_RESULTS_MAX
            );
        }
        Ok((parsed.path, parsed.max_depth, max_results))
    }
}

#[derive(Deserialize)]
pub struct SearchArgs {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub regex: Option<String>,
    #[serde(default)]
    pub max_results: Option<usize>,
    #[serde(default, rename = "in")]
    pub scope: Option<String>,
}

impl SearchArgs {
    fn max_results(&self) -> Result<usize> {
        let max = self
            .max_results
            .unwrap_or(registry::FILES_MAX_RESULTS_DEFAULT);
        if !(registry::SEARCH_MAX_RESULTS_MIN..=registry::SEARCH_MAX_RESULTS_MAX).contains(&max) {
            anyhow::bail!(
                "max_results must be between {} and {}",
                registry::SEARCH_MAX_RESULTS_MIN,
                registry::SEARCH_MAX_RESULTS_MAX
            );
        }
        Ok(max)
    }

    pub fn files(args: Value) -> Result<(String, usize, Option<String>)> {
        let parsed: Self = deserialize_args(args, "search_files")?;
        let max = parsed.max_results()?;
        let query = parsed.query.context("Missing query")?;
        Ok((query, max, parsed.scope))
    }

    pub fn contents(args: Value) -> Result<(String, usize, Option<String>)> {
        let parsed: Self = deserialize_args(args, "search_file_contents")?;
        let max = parsed.max_results()?;
        let regex = parsed.regex.context("Missing regex")?;
        Ok((regex, max, parsed.scope))
    }
}

#[derive(Deserialize)]
pub struct WebSearchArgs {
    pub query: String,
    #[serde(default)]
    pub region: Option<String>,
    #[serde(default)]
    pub safe_search: Option<SafeSearch>,
    #[serde(default)]
    pub max_results: Option<usize>,
    #[serde(default)]
    pub max_bytes: Option<usize>,
}

#[derive(Clone, Copy, Deserialize, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SafeSearch {
    On,
    #[default]
    Moderate,
    Off,
}

#[derive(Deserialize)]
pub struct WebSearchImagesArgs {
    pub query: String,
    #[serde(default)]
    pub max_results: Option<usize>,
    #[serde(default)]
    pub max_bytes: Option<usize>,
}

#[derive(Deserialize)]
pub struct FetchPageArgs {
    pub url: String,
    #[serde(default)]
    pub max_bytes: Option<usize>,
}

impl WebSearchArgs {
    pub fn parse(args: Value) -> Result<(Self, usize, usize)> {
        let mut parsed: Self = deserialize_args(args, "web_search")?;
        parsed.query = validate_query(
            parsed.query,
            registry::WEB_QUERY_MAX_LEN,
            registry::WEB_QUERY_MAX_WORDS,
        )?;
        if let Some(region) = parsed.region.as_mut() {
            *region = region.trim().to_owned();
            let valid = region.len() == 5
                && region.as_bytes()[2] == b'-'
                && region
                    .bytes()
                    .enumerate()
                    .all(|(index, byte)| index == 2 || byte.is_ascii_alphabetic());
            if !valid {
                anyhow::bail!("region must look like us-en");
            }
        }
        let max_results = parsed
            .max_results
            .unwrap_or(registry::WEB_SEARCH_MAX_RESULTS_DEFAULT);
        if !(registry::WEB_SEARCH_MAX_RESULTS_MIN..=registry::WEB_SEARCH_MAX_RESULTS_MAX)
            .contains(&max_results)
        {
            anyhow::bail!(
                "max_results must be between {} and {}",
                registry::WEB_SEARCH_MAX_RESULTS_MIN,
                registry::WEB_SEARCH_MAX_RESULTS_MAX
            );
        }
        let max_bytes = output_bytes(parsed.max_bytes)?;
        Ok((parsed, max_results, max_bytes))
    }
}

impl WebSearchImagesArgs {
    pub fn parse(args: Value) -> Result<(Self, usize, usize)> {
        let mut parsed: Self = deserialize_args(args, "web_search_images")?;
        parsed.query = validate_query(
            parsed.query,
            registry::WEB_IMAGES_QUERY_MAX_LEN,
            registry::WEB_IMAGES_QUERY_MAX_WORDS,
        )?;
        let max_results = parsed
            .max_results
            .unwrap_or(registry::WEB_IMAGES_MAX_RESULTS_DEFAULT);
        if !(registry::WEB_SEARCH_MAX_RESULTS_MIN..=registry::WEB_IMAGES_MAX_RESULTS_MAX)
            .contains(&max_results)
        {
            anyhow::bail!(
                "max_results must be between {} and {}",
                registry::WEB_SEARCH_MAX_RESULTS_MIN,
                registry::WEB_IMAGES_MAX_RESULTS_MAX
            );
        }
        let max_bytes = output_bytes(parsed.max_bytes)?;
        Ok((parsed, max_results, max_bytes))
    }
}

impl FetchPageArgs {
    pub fn parse(args: Value) -> Result<(Self, usize)> {
        let mut parsed: Self = deserialize_args(args, "fetch_page")?;
        parsed.url = parsed.url.trim().to_owned();
        if parsed.url.is_empty() {
            anyhow::bail!("url must not be empty");
        }
        let max_bytes = output_bytes(parsed.max_bytes)?;
        Ok((parsed, max_bytes))
    }
}

fn validate_query(query: String, max_chars: usize, max_words: usize) -> Result<String> {
    let query = query.trim().to_owned();
    if query.is_empty() {
        anyhow::bail!("query must not be empty");
    }
    if query.chars().count() > max_chars {
        anyhow::bail!("query must be at most {max_chars} characters");
    }
    if query.split_whitespace().count() > max_words {
        anyhow::bail!("query must be at most {max_words} words");
    }
    Ok(query)
}

fn output_bytes(value: Option<usize>) -> Result<usize> {
    let value = value.unwrap_or(registry::WEB_OUTPUT_BYTES_DEFAULT);
    if !(registry::WEB_OUTPUT_BYTES_MIN..=registry::WEB_OUTPUT_BYTES_MAX).contains(&value) {
        anyhow::bail!(
            "max_bytes must be between {} and {}",
            registry::WEB_OUTPUT_BYTES_MIN,
            registry::WEB_OUTPUT_BYTES_MAX
        );
    }
    Ok(value)
}

#[derive(Deserialize)]
pub struct SearchActionsArgs {
    pub keywords: Vec<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

impl SearchActionsArgs {
    pub fn parse(args: &Value) -> Result<(Vec<String>, Option<usize>)> {
        let parsed: Self =
            serde_json::from_value(args.clone()).context("Invalid arguments for search_actions")?;
        if parsed.keywords.len() < registry::ACTIONS_KEYWORDS_MIN_ITEMS
            || parsed.keywords.len() > registry::ACTIONS_KEYWORDS_MAX_ITEMS
        {
            anyhow::bail!(
                "keywords must contain between {} and {} values",
                registry::ACTIONS_KEYWORDS_MIN_ITEMS,
                registry::ACTIONS_KEYWORDS_MAX_ITEMS
            );
        }
        for (index, keyword) in parsed.keywords.iter().enumerate() {
            if keyword.trim().is_empty() {
                anyhow::bail!("keywords[{index}] must not be blank");
            }
            let len = keyword.chars().count();
            if len < registry::ACTIONS_KEYWORD_MIN_LEN || len > registry::ACTIONS_KEYWORD_MAX_LEN {
                anyhow::bail!(
                    "keywords[{index}] must be between {} and {} characters",
                    registry::ACTIONS_KEYWORD_MIN_LEN,
                    registry::ACTIONS_KEYWORD_MAX_LEN
                );
            }
        }
        if let Some(limit) = parsed.limit {
            if !(registry::ACTIONS_LIMIT_MIN..=registry::ACTIONS_LIMIT_MAX).contains(&limit) {
                anyhow::bail!(
                    "limit must be between {} and {}",
                    registry::ACTIONS_LIMIT_MIN,
                    registry::ACTIONS_LIMIT_MAX
                );
            }
        }
        Ok((parsed.keywords, parsed.limit))
    }
}
