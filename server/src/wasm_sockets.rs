//! Deadline- and cancellation-bounded loopback TCP host implementation.
//! Limits and ownership are specified in wit/squire-plugin.wit.

use std::{
    future::Future,
    net::{Ipv4Addr, SocketAddr},
    time::Instant,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use tokio_util::sync::CancellationToken;

pub const MAX_CONNECTIONS: usize = 8;
pub const MAX_CONNECTION_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_INVOCATION_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_RECV_BYTES: usize = 256 * 1024;

#[derive(Default)]
pub struct InvocationSockets {
    pub open: usize,
    pub transferred: usize,
}

pub struct SocketConnection {
    pub stream: Option<TcpStream>,
    pub transferred: usize,
    pub deadline: Instant,
}

#[derive(Debug)]
pub enum ConnectError {
    Refused,
    InvalidPort,
    LimitReached,
    Failed(String),
}

impl InvocationSockets {
    pub async fn connect(
        &mut self,
        port: u16,
        deadline: Instant,
        cancel: &CancellationToken,
    ) -> Result<SocketConnection, ConnectError> {
        if port == 0 {
            return Err(ConnectError::InvalidPort);
        }
        if self.open >= MAX_CONNECTIONS {
            return Err(ConnectError::LimitReached);
        }
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let socket = bounded_io(TcpStream::connect(address), deadline, cancel)
            .await
            .map_err(|e| match e {
                IoError::Io(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
                    ConnectError::Refused
                }
                IoError::Io(error) => ConnectError::Failed(error.to_string()),
                IoError::Expired => ConnectError::Failed("invocation deadline exceeded".into()),
                IoError::Cancelled => ConnectError::Failed("invocation cancelled".into()),
            })?;
        self.open += 1;
        Ok(SocketConnection {
            stream: Some(socket),
            transferred: 0,
            deadline,
        })
    }

    pub fn closed(&mut self) {
        self.open = self.open.saturating_sub(1);
    }

    pub async fn send(
        &mut self,
        conn: &mut SocketConnection,
        bytes: &[u8],
        deadline: Instant,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        let size = bytes.len();
        if size > MAX_CONNECTION_BYTES.saturating_sub(conn.transferred) {
            conn.stream.take();
            return Err(format!(
                "TCP connection byte limit ({MAX_CONNECTION_BYTES}) exceeded"
            ));
        }
        if size > MAX_INVOCATION_BYTES.saturating_sub(self.transferred) {
            conn.stream.take();
            return Err(format!(
                "TCP invocation byte limit ({MAX_INVOCATION_BYTES}) exceeded"
            ));
        }
        let stream = conn.stream.as_mut().ok_or("TCP stream already closed")?;
        if let Err(error) = bounded_io(stream.write_all(bytes), deadline, cancel).await {
            conn.stream.take();
            return Err(format!("TCP send failed: {error}"));
        }
        conn.transferred += size;
        self.transferred += size;
        Ok(())
    }

    pub async fn recv(
        &mut self,
        conn: &mut SocketConnection,
        max_bytes: u32,
        deadline: Instant,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>, String> {
        if max_bytes == 0 {
            conn.stream.take();
            return Err("TCP recv max-bytes must be greater than zero".into());
        }
        let size = (max_bytes as usize)
            .min(MAX_RECV_BYTES)
            .min(MAX_CONNECTION_BYTES.saturating_sub(conn.transferred))
            .min(MAX_INVOCATION_BYTES.saturating_sub(self.transferred));
        if size == 0 {
            conn.stream.take();
            return Err("TCP byte limit reached".into());
        }
        let mut buf = vec![0; size];
        let stream = conn.stream.as_mut().ok_or("TCP stream already closed")?;
        let count = match bounded_io(stream.read(&mut buf), deadline, cancel).await {
            Ok(count) => count,
            Err(error) => {
                conn.stream.take();
                return Err(format!("TCP recv failed: {error}"));
            }
        };
        buf.truncate(count);
        conn.transferred += count;
        self.transferred += count;
        Ok(buf)
    }
}

enum IoError {
    Io(std::io::Error),
    Expired,
    Cancelled,
}

impl std::fmt::Display for IoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => e.fmt(f),
            Self::Expired => f.write_str("invocation deadline exceeded"),
            Self::Cancelled => f.write_str("invocation cancelled"),
        }
    }
}

async fn bounded_io<T>(
    op: impl Future<Output = std::io::Result<T>>,
    deadline: Instant,
    cancel: &CancellationToken,
) -> Result<T, IoError> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(IoError::Cancelled),
        result = tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), op) => {
            result.map_err(|_| IoError::Expired)?.map_err(IoError::Io)
        }
    }
}
