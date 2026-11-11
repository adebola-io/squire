//! Host-mediated HTTP egress for WASM Plugins.
//!
//! The guest supplies an absolute URL and its own headers (including any
//! credentials it read through `squire:plugin/secrets`). The host builds a
//! `wreq` request with redirects disabled, streams the response with hard
//! byte caps, and returns the exact status/body plus an accurate truncation
//! flag. The invocation deadline bounds the whole operation.

use anyhow::{bail, Context, Result};
use std::time::Instant;
use wreq::header::{HeaderName, HeaderValue};

/// The public-web client uses this resolver to reject private addresses at
/// connection time. All resolved addresses must be public: accepting a mixed
/// answer would allow the transport to choose a private destination.
struct PublicDnsResolver;

impl wreq::dns::Resolve for PublicDnsResolver {
    fn resolve(&self, name: wreq::dns::Name) -> wreq::dns::Resolving {
        Box::pin(async move {
            let addresses = tokio::net::lookup_host((name.as_str(), 0))
                .await?
                .collect::<Vec<_>>();
            if addresses.is_empty()
                || !addresses
                    .iter()
                    .all(|addr| crate::plugins::is_public_ip(addr.ip()))
            {
                return Err(
                    "public web requests cannot resolve to private or reserved IP addresses".into(),
                );
            }
            Ok::<wreq::dns::Addrs, Box<dyn std::error::Error + Send + Sync>>(Box::new(
                addresses.into_iter(),
            ))
        })
    }
}

fn validate_public_target(url: &url::Url) -> Result<()> {
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        bail!("public web requests require HTTPS without URL credentials");
    }
    match url.host().context("public web URL has no host")? {
        url::Host::Domain(domain) => {
            if domain == "localhost" || domain.ends_with(".localhost") {
                bail!("public web requests cannot target localhost");
            }
        }
        url::Host::Ipv4(ip) => {
            if !crate::plugins::is_public_ip(ip.into()) {
                bail!("public web requests cannot target private or reserved IP addresses");
            }
        }
        url::Host::Ipv6(ip) => {
            if !crate::plugins::is_public_ip(ip.into()) {
                bail!("public web requests cannot target private or reserved IP addresses");
            }
        }
    }
    Ok(())
}

pub const HARD_MAX_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_REQUEST_BODY_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_PATH_LEN: usize = 2048;
pub const MAX_QUERY_PAIRS: usize = 64;
pub const MAX_HEADER_COUNT: usize = 32;
pub const MAX_HEADER_VALUE_LEN: usize = 8192;

/// Response header bounds: generous for real servers, finite for hostile ones.
pub const MAX_RESPONSE_HEADER_COUNT: usize = 256;
pub const MAX_RESPONSE_HEADER_BYTES: usize = 64 * 1024;

use crate::wasm::squire::plugin::network::{HeaderPair, NetworkRequest, NetworkResponse};

/// Copies response headers, one pair per value, failing rather than
/// silently dropping some when a server sends more than the bounds allow.
fn response_headers(
    headers: &wreq::header::HeaderMap,
) -> std::result::Result<Vec<HeaderPair>, String> {
    if headers.len() > MAX_RESPONSE_HEADER_COUNT {
        return Err(format!(
            "HTTP response has too many headers (max {MAX_RESPONSE_HEADER_COUNT})"
        ));
    }
    let mut total = 0;
    let mut pairs = Vec::with_capacity(headers.len());
    for (name, value) in headers {
        total += name.as_str().len() + value.len();
        if total > MAX_RESPONSE_HEADER_BYTES {
            return Err(format!(
                "HTTP response headers exceed {MAX_RESPONSE_HEADER_BYTES} bytes"
            ));
        }
        pairs.push(HeaderPair {
            name: name.as_str().to_string(),
            value: String::from_utf8_lossy(value.as_bytes()).into_owned(),
        });
    }
    Ok(pairs)
}

/// Validates a guest-supplied absolute request URL. Parse-only: the URL must
/// parse and include a host. Scheme, credentials, query strings, and fragments
/// are the plugin's business.
pub fn validate_request_url(value: &str) -> Result<url::Url> {
    let url = url::Url::parse(value.trim()).context("request URL is not a valid URL")?;
    if url.host_str().is_none_or(|host| host.is_empty()) {
        bail!("request URL must include a host");
    }
    Ok(url)
}

/// Builds the final request URL from a guest-supplied absolute URL and query
/// pairs.
pub fn build_request_url(url: &str, query: &[(String, String)]) -> Result<url::Url> {
    let mut parsed = validate_request_url(url)?;
    if parsed.path().len() > MAX_PATH_LEN {
        bail!("request URL path is too long (max {MAX_PATH_LEN})");
    }
    if query.len() > MAX_QUERY_PAIRS {
        bail!("too many query parameters (max {MAX_QUERY_PAIRS})");
    }
    for (name, value) in query {
        if name.is_empty() || name.len() > 2048 {
            bail!("invalid query parameter name");
        }
        if value.len() > 4096 {
            bail!("query parameter value is too long");
        }
        if name.bytes().any(|b| b < 0x20 || b == 0x7f)
            || value.bytes().any(|b| b < 0x20 || b == 0x7f)
        {
            bail!("query parameters must not contain control characters");
        }
    }
    {
        let mut pairs = parsed.query_pairs_mut();
        for (name, value) in query {
            pairs.append_pair(name, value);
        }
    }
    Ok(parsed)
}

/// Parses guest headers once. Invalid names/values are rejected by the header
/// types themselves; the count and value length are bounded first.
fn build_headers(headers: &[(String, String)]) -> Result<Vec<(HeaderName, HeaderValue)>> {
    if headers.len() > MAX_HEADER_COUNT {
        bail!("too many headers (max {MAX_HEADER_COUNT})");
    }
    let mut parsed = Vec::with_capacity(headers.len());
    for (name, value) in headers {
        if value.len() > MAX_HEADER_VALUE_LEN {
            bail!("header `{name}` value is too long");
        }
        let name = HeaderName::from_bytes(name.as_bytes())
            .with_context(|| format!("invalid header name `{name}`"))?;
        let value = HeaderValue::from_str(value)
            .with_context(|| format!("invalid header `{name}` value"))?;
        parsed.push((name, value));
    }
    Ok(parsed)
}

/// The transport and URL checks are selected together at construction.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum NetworkPolicy {
    Unrestricted,
    PublicWeb,
}

#[derive(Clone)]
pub struct NetworkClient {
    client: wreq::Client,
    policy: NetworkPolicy,
}

impl NetworkClient {
    pub fn new(policy: NetworkPolicy, profile: wreq_util::Profile) -> Result<Self> {
        let mut builder = wreq::Client::builder()
            .redirect(wreq::redirect::Policy::none())
            .emulation(
                wreq_util::Emulation::builder()
                    .profile(profile)
                    .platform(wreq_util::Platform::MacOS)
                    .http2(true)
                    .headers(false)
                    .build(),
            );
        if policy == NetworkPolicy::PublicWeb {
            // Check DNS at connection time to prevent rebinding. A separate
            // pool prevents reuse of unrestricted connections; proxies are off
            // so they cannot bypass the resolver.
            builder = builder
                .dns_resolver(std::sync::Arc::new(PublicDnsResolver))
                .no_proxy();
        }
        let client = builder
            .build()
            .context("failed to build plugin HTTP client")?;
        Ok(Self { client, policy })
    }

    /// Executes one network call. Redirects are disabled, the response body is
    /// streamed with a hard cap, and the exact status, headers and bytes are
    /// returned.
    pub async fn execute(
        &self,
        request: &NetworkRequest,
        deadline: Instant,
    ) -> std::result::Result<NetworkResponse, String> {
        const DEADLINE: &str = "network request exceeded the invocation deadline";
        let query = request
            .query
            .iter()
            .map(|pair| (pair.name.clone(), pair.value.clone()))
            .collect::<Vec<_>>();
        let headers = request
            .headers
            .iter()
            .map(|pair| (pair.name.clone(), pair.value.clone()))
            .collect::<Vec<_>>();
        let url = build_request_url(&request.url, &query).map_err(|error| format!("{error:#}"))?;
        if self.policy == NetworkPolicy::PublicWeb {
            validate_public_target(&url).map_err(|error| format!("{error:#}"))?;
        }
        let headers = build_headers(&headers).map_err(|error| format!("{error:#}"))?;
        if let Some(body) = &request.body {
            if body.len() > MAX_REQUEST_BODY_BYTES {
                return Err(format!(
                    "request body exceeds the limit of {MAX_REQUEST_BODY_BYTES} bytes"
                ));
            }
        }

        let timeout = deadline.saturating_duration_since(Instant::now());
        if timeout.is_zero() {
            return Err(DEADLINE.to_string());
        }
        let cap = (request.max_response_bytes as usize).clamp(1, HARD_MAX_RESPONSE_BYTES);

        let mut builder = self
            .client
            .request(
                request
                    .method
                    .parse::<wreq::Method>()
                    .map_err(|_| format!("invalid HTTP method `{}`", request.method))?,
                url.as_str(),
            )
            .timeout(timeout);
        for (name, value) in headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = &request.body {
            builder = builder.body(body.clone());
        }

        let response = tokio::time::timeout(timeout, builder.send())
            .await
            .map_err(|_| DEADLINE.to_string())?
            .map_err(|error| format!("HTTP request failed: {error}"))?;
        let status = response.status().as_u16();
        let response_headers = response_headers(response.headers())?;

        // Stream with a hard cap. One byte past the cap marks truncation; the
        // remainder is discarded without being returned.
        let remaining = || deadline.saturating_duration_since(Instant::now());
        let mut body = Vec::new();
        let mut truncated = false;
        use futures_util::StreamExt;
        let mut stream = response.bytes_stream();
        loop {
            let next = tokio::time::timeout(remaining(), stream.next())
                .await
                .map_err(|_| DEADLINE.to_string())?;
            match next {
                None => break,
                Some(Err(error)) => {
                    return Err(format!("HTTP response transfer failed: {error}"));
                }
                Some(Ok(chunk)) => {
                    if body.len() + chunk.len() <= cap {
                        body.extend_from_slice(&chunk);
                    } else {
                        let room = cap.saturating_sub(body.len());
                        body.extend_from_slice(&chunk[..room]);
                        truncated = true;
                        break;
                    }
                }
            }
        }
        Ok(NetworkResponse {
            status,
            headers: response_headers,
            body,
            truncated,
        })
    }
}
