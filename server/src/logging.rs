//! Tracing setup: the terminal shows Squire's address and genuine problems;
//! `logs/squire.log` keeps more detail and survives restarts.
use std::{fs, sync::Arc};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Layer};

/// Initialize global tracing. Safe to call once; subsequent calls are no-ops.
pub fn init(squire_home: &std::path::Path) {
    let log_dir = squire_home.join("logs");
    let _ = fs::create_dir_all(&log_dir);
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("squire.log"));
    // Keep startup output short: show Squire's server address and genuine
    // warnings/errors, but not dependency INFO records (some include full MCP
    // server instructions). Keep more detail in the log file.
    // An explicit RUST_LOG still overrides these defaults for debugging.
    let override_filter = std::env::var("RUST_LOG").ok();
    let terminal_filter = override_filter
        .as_deref()
        .unwrap_or("warn,squire_server::http=info");
    let stored_filter = override_filter
        .as_deref()
        .unwrap_or("warn,squire_server=info");

    let file_layer = file.ok().map(|file| {
        fmt::layer()
            .with_writer(Arc::new(file))
            .with_ansi(false)
            .with_filter(
                EnvFilter::try_new(stored_filter)
                    .unwrap_or_else(|_| EnvFilter::new("warn,squire_server=info")),
            )
    });
    let _ = tracing_subscriber::registry()
        .with(
            fmt::layer().with_filter(
                EnvFilter::try_new(terminal_filter)
                    .unwrap_or_else(|_| EnvFilter::new("warn,squire_server::http=info")),
            ),
        )
        .with(file_layer)
        .try_init();
}
