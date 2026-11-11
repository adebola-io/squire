//! Serves snapshotted tool-result attachments to the local web UI.

use crate::{connections, desktop, state::AppState, util::json_error};
use anyhow::Result;
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderName, StatusCode},
    response::{IntoResponse, Response},
};

/// Local browser attachments need no bearer credential, but must not be
/// reachable through a rebound Host name or from another site.
pub async fn local_attachment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(hash): Path<String>,
) -> Response {
    if let Some(rejection) = desktop::reject_foreign(&headers, &state.config) {
        return rejection;
    }
    match blob_attachment(&state, &hash).await {
        Ok((record, bytes)) => (
            [
                (
                    header::CONTENT_DISPOSITION,
                    attachment_disposition(&record.mime_type).into(),
                ),
                (header::CONTENT_TYPE, record.mime_type),
                (header::CONTENT_LENGTH, record.bytes.to_string()),
                (
                    HeaderName::from_static("x-content-type-options"),
                    "nosniff".into(),
                ),
                (
                    HeaderName::from_static("content-security-policy"),
                    "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'".into(),
                ),
            ],
            bytes,
        )
            .into_response(),
        Err(error) => json_error(StatusCode::NOT_FOUND, error),
    }
}

async fn blob_attachment(
    state: &AppState,
    hash: &str,
) -> Result<(connections::AttachmentRecord, Vec<u8>)> {
    let path = state.store.blobs.path(hash)?;
    let hash = hash.to_owned();
    let (mime_type, bytes) = state
        .store
        .read(move |db| {
            Ok(db.query_row(
                "SELECT mime_type,bytes FROM blobs WHERE hash=?1 AND refs>0",
                [hash],
                |r| Ok((r.get(0)?, r.get::<_, i64>(1)?)),
            )?)
        })
        .await?;
    let data = tokio::fs::read(path).await?;
    Ok((
        connections::AttachmentRecord {
            mime_type,
            bytes: bytes as u64,
        },
        data,
    ))
}

fn attachment_disposition(mime_type: &str) -> &'static str {
    match mime_type.split_once('/') {
        Some(("image", "gif" | "jpeg" | "png" | "webp")) | Some(("audio" | "video", _)) => "inline",
        _ => "attachment",
    }
}
