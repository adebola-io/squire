//! Native device protocol between this computer and its hosted peer.
//!
//! Messages are JSON text frames. Every connection starts with `hello`, which
//! carries the tool catalog this build executes; the Worker serves `tools/list`
//! from the catalog its device last reported, so desktop and Worker releases
//! never have to ship together. Attachment bytes travel in base64 chunks
//! before the result that references them.
//!
//! `PROTOCOL_VERSION` changes only for incompatible message changes, not optional fields. The
//! limits below are this side's own; the Worker keeps its own caps, and a
//! result over them fails that one call rather than the connection.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

pub const PROTOCOL_VERSION: u32 = 1;
pub const CHUNK_BYTES: usize = 192 * 1024;
// Base64 of a multiple of 3 bytes has no padding, so the Worker joins
// non-final chunks as strings without decoding them.
const _: () = assert!(CHUNK_BYTES % 3 == 0, "CHUNK_BYTES must be a multiple of 3");
pub const MAX_CONCURRENT_REQUESTS: usize = 8;
/// How often this side sends a lease. The Worker expires a connection that
/// stays silent for its own lease window (120s), so this must stay well below.
pub const LEASE_INTERVAL: Duration = Duration::from_secs(60);
/// How long the hosted side may stay silent before this side treats the
/// connection as half-open and reconnects. The Worker answers each lease.
pub const LEASE_TIMEOUT: Duration = Duration::from_secs(150);
pub const MAX_SOCKET_MESSAGE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Incoming {
    Request {
        id: String,
        op: String,
        name: String,
        #[serde(default = "empty_arguments")]
        arguments: Value,
        #[serde(default)]
        client: Option<String>,
    },
    Cancel {
        id: String,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Outgoing {
    Hello {
        tools: Vec<Value>,
        /// Optional display metadata; old Workers ignore it without changing the protocol.
        #[serde(skip_serializing_if = "Option::is_none")]
        device: Option<super::device_identity::DeviceIdentity>,
    },
    Lease,
    AttachmentChunk {
        id: String,
        index: usize,
        seq: usize,
        #[serde(rename = "final")]
        is_final: bool,
        data: String,
    },
    Result {
        id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<NativeError>,
    },
}

#[derive(Debug, Serialize)]
pub struct NativeError {
    pub code: String,
    pub message: String,
}

impl NativeError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

fn empty_arguments() -> Value {
    json!({})
}
