//! Squire HTTP transport configuration. Rig Core owns provider protocols.
use anyhow::{Context, Result};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(30);
const USER_AGENT: &str = concat!("squire/", env!("CARGO_PKG_VERSION"));

pub(crate) fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(TIMEOUT)
        .build()?)
}

pub(crate) fn session_header(name: Option<&str>) -> Result<Option<reqwest::header::HeaderName>> {
    name.map(str::parse)
        .transpose()
        .context("Invalid session header name")
}

pub(crate) fn api_key(key: Option<String>) -> Option<String> {
    key.filter(|key| !key.trim().is_empty())
}
