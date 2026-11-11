//! Best-effort initial title generation. Finished turns never re-evaluate titles.
//! Only the opening user message is sent, without tool payloads or attachments.
use crate::{
    conversations::{self, events, TitleSnapshot},
    state::AppState,
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, time::Duration};
use tokio::sync::Mutex;

const MESSAGE_BYTES: usize = 2048;
const MAX_TITLE_CHARS: usize = 48;
const MAX_INFLIGHT: usize = 12;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Default)]
pub struct TitleJobs(Mutex<HashMap<String, bool>>);

#[derive(Serialize)]
struct TitleRequest {
    message: String,
}

#[derive(Deserialize)]
struct TitleResponse {
    title: Option<String>,
}

/// Collapses whitespace, drops control characters, and cuts the result to
/// `max_bytes` at a character boundary.
fn fit(text: &str, max_bytes: usize) -> String {
    let mut clean = text
        .split_whitespace()
        .map(|word| word.chars().filter(|c| !c.is_control()).collect::<String>())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if clean.len() > max_bytes {
        let mut end = max_bytes;
        while !clean.is_char_boundary(end) {
            end -= 1;
        }
        clean.truncate(end);
    }
    clean
}

fn build_request(snapshot: &TitleSnapshot) -> Option<TitleRequest> {
    let message = fit(&snapshot.first_message, MESSAGE_BYTES);
    (!message.is_empty()).then_some(TitleRequest { message })
}

fn normalize_title(raw: &str) -> Option<String> {
    let raw = raw
        .trim()
        .trim_matches(|c| c == '"' || c == '\'' || c == '`');
    let title = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty()
        || title.chars().count() > MAX_TITLE_CHARS
        || title.chars().any(char::is_control)
    {
        return None;
    }
    Some(title)
}

/// An async, deduplicated best-effort job; callers never wait for inference.
pub fn schedule(state: &AppState, conversation_id: &str) {
    let state = state.clone();
    let id = conversation_id.to_owned();
    tokio::spawn(async move {
        let jobs = &state.title_jobs.0;
        {
            let mut active = jobs.lock().await;
            if let Some(pending) = active.get_mut(&id) {
                *pending = true;
                return;
            }
            if active.len() >= MAX_INFLIGHT {
                return;
            }
            active.insert(id.clone(), false);
        }
        loop {
            if let Err(error) = generate(&state, &id).await {
                tracing::warn!(conversation_id=%id, "Hosted title generation failed: {error:#}");
            }
            let mut active = jobs.lock().await;
            if let Some(pending) = active.get_mut(&id) {
                if *pending {
                    *pending = false;
                    continue;
                }
            }
            active.remove(&id);
            break;
        }
    });
}

async fn generate(state: &AppState, id: &str) -> Result<()> {
    // Avoid account lookups for conversations that already have a title.
    let Some(snapshot) = conversations::title_snapshot(state, id, MESSAGE_BYTES)? else {
        return Ok(());
    };
    if state.account.status().await?.state != "connected" {
        return Ok(());
    }
    let Some(request) = build_request(&snapshot) else {
        return Ok(());
    };
    let response = tokio::time::timeout(
        REQUEST_TIMEOUT,
        state
            .account
            .post_hosted_json("/api/titles/generate", &request),
    )
    .await
    .context("hosted title request timed out")??;
    if !response.status().is_success() {
        anyhow::bail!("title service HTTP {}", response.status());
    }
    let generated: TitleResponse = response.json().await.context("hosted title response")?;
    let Some(title) = generated.title.as_deref().and_then(normalize_title) else {
        anyhow::bail!("title service returned no usable title");
    };
    if conversations::set_auto_title(state, id, &snapshot, &title)? {
        events::conversation_updated(state, id);
    }
    Ok(())
}
