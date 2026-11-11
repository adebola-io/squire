//! Web search and page fetching. Search runs through the hosted Squire
//! service so the Brave subscription key stays on the server; page fetching
//! uses the same public-egress policy as WASM Plugins. Image search resolves
//! each result URL to bytes before returning, so the agent and UI receive
//! images rather than only links.

use super::{
    args::{FetchPageArgs, SafeSearch, WebSearchArgs, WebSearchImagesArgs},
    AttachmentSlot, ProducedResult,
};
use crate::{
    state::AppState,
    wasm::squire::plugin::network::{HeaderPair, NetworkRequest, NetworkResponse},
    wasm_network::HARD_MAX_RESPONSE_BYTES,
};
use anyhow::{bail, Context, Result};
use dom_smoothie::{Config, Readability, ReadabilityError, TextMode};
use encoding_rs::{Encoding, UTF_8};
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use url::Url;

const SEARCH_PATH: &str = "/api/web/search";
const IMAGE_SEARCH_PATH: &str = "/api/web/search-images";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const PAGE_NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
const IMAGE_NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_HTTP_BYTES: usize = 2 * 1024 * 1024;
// The public-web client caps each response at this size. The aggregate cap
// below keeps a full page of results under the attachment storage limit.
const MAX_IMAGE_BYTES: u32 = HARD_MAX_RESPONSE_BYTES as u32;
const MAX_TOTAL_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const MAX_PAGE_ELEMENTS: usize = 10_000;
const MAX_REDIRECTS: usize = 5;
const USER_AGENT: &str = "Mozilla/5.0 (compatible; Squire Web Fetch/1.0)";
const IMAGE_ACCEPT: &str = "image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1";

#[derive(Serialize)]
struct SearchRequest<'a> {
    query: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    region: Option<&'a str>,
    safe_search: SafeSearch,
    max_results: usize,
}

#[derive(Serialize)]
struct ImageSearchRequest<'a> {
    query: &'a str,
    max_results: usize,
}

#[derive(Deserialize)]
struct SearchResponse<T> {
    query: String,
    results: Vec<T>,
}

#[derive(Deserialize, Serialize)]
struct SearchResult {
    title: String,
    url: String,
    snippet: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct ImageResult {
    title: String,
    image_url: String,
    source_url: String,
    source: String,
}

#[derive(Clone, Copy)]
struct ImageFormat {
    mime: &'static str,
    extension: &'static str,
}

struct ResolvedImage {
    result: ImageResult,
    format: ImageFormat,
    bytes: Vec<u8>,
}

struct Fetched {
    url: Url,
    response: NetworkResponse,
}

#[derive(Deserialize)]
struct ApiError {
    error: String,
}

pub async fn search(state: &AppState, args: Value) -> Result<Value> {
    let (parsed, max_results, max_bytes) = WebSearchArgs::parse(args)?;
    let request = SearchRequest {
        query: &parsed.query,
        region: parsed.region.as_deref(),
        safe_search: parsed.safe_search.unwrap_or_default(),
        max_results,
    };
    let response: SearchResponse<SearchResult> = hosted_json(state, SEARCH_PATH, &request).await?;
    search_output(response.query, response.results, max_bytes)
}

pub async fn search_images(state: &AppState, args: Value) -> Result<ProducedResult> {
    let (parsed, max_results, max_bytes) = WebSearchImagesArgs::parse(args)?;
    let request = ImageSearchRequest {
        query: &parsed.query,
        max_results,
    };
    let response: SearchResponse<ImageResult> =
        hosted_json(state, IMAGE_SEARCH_PATH, &request).await?;
    if response.results.is_empty() {
        return Ok(ProducedResult::success(search_output(
            response.query,
            response.results,
            max_bytes,
        )?));
    }
    // Resolve every result before returning so the agent receives images, not
    // URLs that may be dead, hotlink-protected or not images at all. Requests
    // run together, so total latency is bounded by the slowest image rather
    // than their sum.
    let resolved = join_all(
        response
            .results
            .into_iter()
            .map(|result| resolve_image(state, result)),
    )
    .await;
    let mut images = Vec::new();
    let mut total_bytes = 0;
    for image in resolved.into_iter().flatten() {
        // Skip an image that would blow the aggregate budget, but keep looking:
        // a later result may be small enough to fit.
        if total_bytes + image.bytes.len() > MAX_TOTAL_IMAGE_BYTES {
            continue;
        }
        total_bytes += image.bytes.len();
        images.push(image);
    }
    if images.is_empty() {
        bail!("Image search did not return any images that could be fetched");
    }

    let results = images.iter().map(|image| image.result.clone()).collect();
    let mut output = search_output(response.query, results, max_bytes)?;
    // `search_output` only drops results from the end, so the retained images
    // are exactly the prefix that still has a result entry.
    let kept = output["results"].as_array().map_or(0, Vec::len);
    images.truncate(kept);
    if images.is_empty() {
        // A too-small metadata budget should not turn a successful search
        // into an error. The truncated flag tells the caller to retry larger.
        return Ok(ProducedResult::success(output));
    }

    let attachments = images
        .iter()
        .enumerate()
        .map(|(index, image)| {
            json!({
                "name": format!("image-{}.{}", index + 1, image.format.extension),
                "mimeType": image.format.mime,
            })
        })
        .collect::<Vec<_>>();
    let slots = images
        .into_iter()
        .map(|image| AttachmentSlot {
            staging: None,
            bytes: Some(image.bytes),
        })
        .collect();
    output = json!({
        "structuredContent": output,
        "attachments": attachments,
    });
    Ok(ProducedResult {
        result: output,
        attachments: slots,
        recorded: false,
    })
}

async fn resolve_image(state: &AppState, result: ImageResult) -> Option<ResolvedImage> {
    match fetch_image(state, &result.image_url).await {
        Ok((image_url, format, bytes)) => Some(ResolvedImage {
            result: ImageResult {
                image_url,
                ..result
            },
            format,
            bytes,
        }),
        Err(error) => {
            tracing::debug!(
                url = %result.image_url,
                %error,
                "Skipping image search result that could not be fetched"
            );
            None
        }
    }
}

/// Downloads an image under the public-egress policy and identifies it from
/// its bytes. The server's `Content-Type` is not trusted; only formats the
/// chat can render are accepted.
async fn fetch_image(state: &AppState, raw: &str) -> Result<(String, ImageFormat, Vec<u8>)> {
    let url = Url::parse(raw).map_err(|error| anyhow::anyhow!("invalid image URL: {error}"))?;
    let fetched = fetch_public(
        state,
        url,
        IMAGE_ACCEPT,
        MAX_IMAGE_BYTES,
        Instant::now() + IMAGE_NETWORK_TIMEOUT,
    )
    .await?;
    if fetched.response.truncated {
        bail!("image exceeded the {MAX_IMAGE_BYTES}-byte download limit");
    }
    let format = image_format(&fetched.response.body).with_context(|| {
        format!(
            "{} did not return a PNG, JPEG, GIF or WebP image",
            fetched.url
        )
    })?;
    Ok((fetched.url.to_string(), format, fetched.response.body))
}

fn image_format(bytes: &[u8]) -> Option<ImageFormat> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(ImageFormat {
            mime: "image/png",
            extension: "png",
        });
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Some(ImageFormat {
            mime: "image/jpeg",
            extension: "jpg",
        });
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(ImageFormat {
            mime: "image/gif",
            extension: "gif",
        });
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(ImageFormat {
            mime: "image/webp",
            extension: "webp",
        });
    }
    None
}

/// Fetches a public URL, following redirects. Every hop goes back through the
/// public-egress client, so each redirect target gets the same HTTPS and
/// private-address checks as the first request.
async fn fetch_public(
    state: &AppState,
    mut url: Url,
    accept: &str,
    max_bytes: u32,
    deadline: Instant,
) -> Result<Fetched> {
    let mut redirects = 0;
    loop {
        let response = state
            .web_client
            .execute(
                &NetworkRequest {
                    method: "GET".into(),
                    url: url.to_string(),
                    query: Vec::new(),
                    headers: vec![
                        HeaderPair {
                            name: "Accept".into(),
                            value: accept.into(),
                        },
                        HeaderPair {
                            name: "User-Agent".into(),
                            value: USER_AGENT.into(),
                        },
                    ],
                    body: None,
                    max_response_bytes: max_bytes,
                },
                deadline,
            )
            .await
            .map_err(|error| anyhow::anyhow!(error))?;

        if (300..400).contains(&response.status) {
            if redirects == MAX_REDIRECTS {
                bail!("{url} redirected too many times");
            }
            redirects += 1;
            let location = response_header(&response.headers, "location")
                .with_context(|| format!("{url} redirected without a Location header"))?;
            url = url
                .join(location)
                .with_context(|| format!("invalid redirect URL from {url}"))?;
            continue;
        }
        if !(200..300).contains(&response.status) {
            bail!("{url} returned HTTP {}", response.status);
        }
        return Ok(Fetched { url, response });
    }
}

pub async fn fetch_page(state: &AppState, args: Value) -> Result<Value> {
    let (parsed, max_bytes) = FetchPageArgs::parse(args)?;
    let url = Url::parse(&parsed.url).map_err(|error| anyhow::anyhow!("invalid URL: {error}"))?;
    let fetched = fetch_public(
        state,
        url,
        "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.1",
        MAX_HTTP_BYTES as u32,
        Instant::now() + PAGE_NETWORK_TIMEOUT,
    )
    .await?;
    // DOM construction and extraction are CPU work. The network cap bounds
    // the input even when the response is larger; return the readable prefix
    // instead of discarding it because the download was truncated.
    tokio::task::spawn_blocking(move || render_fetched_page(&fetched, max_bytes))
        .await
        .context("page extraction worker failed")?
}

fn render_fetched_page(fetched: &Fetched, max_bytes: usize) -> Result<Value> {
    let content_type =
        response_header(&fetched.response.headers, "content-type").unwrap_or("text/html");
    let text = match readable_page(&fetched.response.body, content_type, fetched.url.as_str()) {
        Ok(text) if !text.trim().is_empty() => text,
        // A partial HTML document may fail Readability's parser. Still return
        // the downloaded text instead of failing solely due to the size cap.
        Ok(_) | Err(_) if fetched.response.truncated => {
            let (_, charset) = page_content_type(content_type)?;
            decode_page(&fetched.response.body, charset)?
        }
        Ok(_) => bail!("page did not contain readable text"),
        Err(error) => return Err(error),
    };
    if text.trim().is_empty() {
        bail!("page did not contain readable text");
    }

    let content = format!("URL: {}\n\n{text}", fetched.url.as_str());
    Ok(json!(bounded_page_output(
        &content,
        max_bytes,
        fetched
            .response
            .truncated
            .then_some(fetched.response.body.len()),
    )))
}

fn response_header<'a>(headers: &'a [HeaderPair], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case(name))
        .map(|header| header.value.as_str())
}

async fn hosted_json<T: for<'de> Deserialize<'de>, B: Serialize + ?Sized>(
    state: &AppState,
    path: &str,
    body: &B,
) -> Result<T> {
    let response =
        tokio::time::timeout(REQUEST_TIMEOUT, state.account.post_hosted_json(path, body))
            .await
            .context("hosted web request timed out")??;
    let status = response.status();
    if !status.is_success() {
        let message = response
            .json::<ApiError>()
            .await
            .ok()
            .map(|error| error.error)
            .unwrap_or_else(|| format!("Squire web service returned HTTP {status}"));
        bail!("{message}");
    }
    response
        .json::<T>()
        .await
        .context("Malformed Squire web service response")
}

fn search_output<T: Serialize>(
    query: String,
    mut results: Vec<T>,
    max_bytes: usize,
) -> Result<Value> {
    let total = results.len();
    // Account for each result's serialized size once, avoiding quadratic
    // reserialization as oversized pages are trimmed. The envelope contains
    // an empty results array, whose internal bytes are counted separately.
    let mut result_bytes = serde_json::to_vec(&results)?.len() - b"[]".len();
    let mut output = json!({
        "query": query,
        "result_count": total,
        "results": [],
        "truncated": false,
    });
    loop {
        output["result_count"] = json!(results.len());
        output["truncated"] = json!(results.len() != total);
        if serde_json::to_vec(&output)?.len() + result_bytes <= max_bytes {
            output["results"] = serde_json::to_value(results)?;
            return Ok(output);
        }
        let Some(removed) = results.pop() else {
            break;
        };
        result_bytes -= serde_json::to_vec(&removed)?.len();
        if !results.is_empty() {
            result_bytes -= 1; // Comma separating the removed item.
        }
    }
    output["truncated"] = json!(true);
    let full_query = output["query"].as_str().unwrap_or_default().to_owned();
    let mut end = full_query.len();
    loop {
        output["query"] = json!(&full_query[..end]);
        if serde_json::to_vec(&output)?.len() <= max_bytes {
            return Ok(output);
        }
        if end == 0 {
            // The minimum schema fits the validated max_bytes minimum (64).
            unreachable!("empty search response exceeds max_bytes");
        }
        end -= 1;
        while !full_query.is_char_boundary(end) {
            end -= 1;
        }
    }
}

fn readable_page(body: &[u8], content_type: &str, url: &str) -> Result<String> {
    let (kind, charset) = page_content_type(content_type)?;
    let page = decode_page(body, charset)?;
    if kind == "text/html" {
        html_to_text(&page, url)
    } else {
        // JSON (including vendor +json media types) and plain text should
        // be returned verbatim, not interpreted as HTML.
        Ok(page)
    }
}

fn decode_page(body: &[u8], charset: Option<String>) -> Result<String> {
    let encoding = match charset {
        Some(charset) => Encoding::for_label(charset.as_bytes())
            .with_context(|| format!("unsupported character encoding {charset}"))?,
        None => UTF_8,
    };
    let (page, _, _) = encoding.decode(body);
    Ok(page.into_owned())
}

fn page_content_type(content_type: &str) -> Result<(&str, Option<String>)> {
    let mut parts = content_type.split(';');
    let kind = parts.next().expect("split always has a first part").trim();
    let kind_lower = kind.to_ascii_lowercase();
    let is_json = kind_lower == "application/json"
        || kind_lower == "text/json"
        || (kind_lower.starts_with("application/") && kind_lower.ends_with("+json"));
    if !kind.eq_ignore_ascii_case("text/html")
        && !kind.eq_ignore_ascii_case("application/xhtml+xml")
        && !kind.eq_ignore_ascii_case("text/plain")
        && !is_json
    {
        bail!("unsupported page content type {content_type}");
    }
    let charset = parts.find_map(|parameter| {
        let (name, value) = parameter.trim().split_once('=')?;
        name.trim()
            .eq_ignore_ascii_case("charset")
            .then(|| value.trim().trim_matches('"').to_string())
    });
    Ok((
        if is_json {
            "application/json"
        } else if kind.eq_ignore_ascii_case("text/plain") {
            "text/plain"
        } else {
            "text/html"
        },
        charset,
    ))
}

/// Remove non-content nodes once, then let the parsing library handle both
/// article extraction and the formatted fallback.
fn html_to_text(html: &str, url: &str) -> Result<String> {
    let config = Config {
        text_mode: TextMode::Formatted,
        max_elements_to_parse: MAX_PAGE_ELEMENTS,
        ..Config::default()
    };
    let mut document = Readability::new(html, Some(url), Some(config))?;
    document
        .doc
        .select("script, style, noscript, svg, template, nav, footer, aside, form")
        .remove();
    match document.parse() {
        Ok(article) => {
            let content = article.text_content.trim();
            if !content.is_empty() {
                let title = article.title.trim();
                return Ok(if title.is_empty() || content.starts_with(title) {
                    content.to_string()
                } else {
                    format!("{title}\n\n{content}")
                });
            }
        }
        Err(ReadabilityError::GrabFailed) => {}
        Err(error) => return Err(error.into()),
    }
    Ok(document
        .doc
        .select("body")
        .formatted_text()
        .trim()
        .to_string())
}

/// Bound the serialized JSON string, not just its raw characters: quotes,
/// backslashes, and control characters expand when the tool result is encoded.
/// Track download truncation separately from output truncation.
fn bounded_page_output(content: &str, max_bytes: usize, download_cap: Option<usize>) -> String {
    let download_notice = download_cap
        .map(|cap| format!("\n[download truncated at {cap} bytes]"))
        .unwrap_or_default();
    let complete = format!("{content}{download_notice}");
    if serialized_string_len(&complete) <= max_bytes {
        return complete;
    }

    if let Some(cap) = download_cap {
        let notice = format!("\n[download truncated at {cap} bytes; output truncated]");
        let prefix = serialized_bounded_prefix(content, &notice, max_bytes);
        return format!("{prefix}{notice}");
    }

    // Include the number of omitted source bytes. The initial estimate is
    // an upper bound; the notice can only get shorter as it converges.
    let mut omitted = content.len();
    loop {
        let notice = format!("\n[output truncated: {omitted} bytes omitted]");
        let prefix = serialized_bounded_prefix(content, &notice, max_bytes);
        let next_omitted = content.len() - prefix.len();
        if next_omitted == omitted {
            return format!("{prefix}{notice}");
        }
        omitted = next_omitted;
    }
}

fn serialized_string_len(text: &str) -> usize {
    serde_json::to_string(text)
        .expect("serializing a string cannot fail")
        .len()
}

/// Find the largest UTF-8-safe prefix whose JSON string with `suffix` fits.
/// No need to index beyond the budget: JSON encoding never shrinks text.
fn serialized_bounded_prefix<'a>(content: &'a str, suffix: &str, max_bytes: usize) -> &'a str {
    let upper = utf8_prefix(content, max_bytes);
    let mut boundaries = upper.char_indices().map(|(i, _)| i).collect::<Vec<_>>();
    boundaries.push(upper.len());

    let mut low = 0;
    let mut high = boundaries.len() - 1;
    while low < high {
        let middle = low + (high - low + 1) / 2;
        let candidate = format!("{}{suffix}", &content[..boundaries[middle]]);
        if serialized_string_len(&candidate) <= max_bytes {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    &content[..boundaries[low]]
}

fn utf8_prefix(value: &str, max_bytes: usize) -> &str {
    let mut end = value.len().min(max_bytes);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}
