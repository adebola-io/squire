//! Kernel locks owned by one WASM invocation. Dropping the invocation closes
//! its files and releases every lock, including on traps and deadline expiry.

use std::{
    collections::HashMap,
    fs::{File, OpenOptions, TryLockError},
    path::Path,
    time::{Duration, Instant},
};

const POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Default)]
pub struct InvocationLocks {
    held: HashMap<String, File>,
}

impl InvocationLocks {
    /// Waits for another invocation to release the lock, up to `deadline` or
    /// until the invocation is cancelled.
    pub fn acquire(
        &mut self,
        plugin_id: &str,
        squire_home: &Path,
        name: &str,
        deadline: Instant,
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> Result<(), String> {
        while Instant::now() < deadline {
            if cancellation.is_cancelled() {
                return Err("invocation cancelled".into());
            }
            if self.try_acquire(plugin_id, squire_home, name)? {
                return Ok(());
            }
            std::thread::sleep(
                POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
            );
        }
        Err(format!(
            "lock `{name}` is busy: invocation deadline expired"
        ))
    }

    /// Reacquiring a lock already owned by this invocation is idempotent.
    pub fn try_acquire(
        &mut self,
        plugin_id: &str,
        squire_home: &Path,
        name: &str,
    ) -> Result<bool, String> {
        validate_name(name)?;
        if self.held.contains_key(name) {
            return Ok(true);
        }
        let directory = squire_home
            .join("plugin-data")
            .join(plugin_id)
            .join("locks");
        std::fs::create_dir_all(&directory)
            .map_err(|error| format!("failed to create lock directory: {error}"))?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join(format!("{name}.lock")))
            .map_err(|error| format!("failed to open lock `{name}`: {error}"))?;
        match file.try_lock() {
            Ok(()) => {
                self.held.insert(name.to_string(), file);
                Ok(true)
            }
            Err(TryLockError::WouldBlock) => Ok(false),
            Err(TryLockError::Error(error)) => {
                Err(format!("failed to acquire lock `{name}`: {error}"))
            }
        }
    }

    pub fn release(&mut self, name: &str) -> Result<(), String> {
        self.held
            .remove(name)
            .map(drop)
            .ok_or_else(|| format!("lock `{name}` is not held by this invocation"))
    }
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 128
        || matches!(name, "." | "..")
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
    {
        return Err(format!("invalid lock name `{name}`"));
    }
    Ok(())
}

/// Implements `<helper> --internal-lock <file>` for the browser driver.
/// Acknowledges only after acquiring a kernel lock on Unix or Windows, then
/// holds it until stdin closes. File contents never determine ownership.
pub fn run_internal_lock(path: &Path) -> anyhow::Result<i32> {
    use std::io::{Read, Write};
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    file.lock()?;
    println!("locked");
    std::io::stdout().flush()?;
    let mut buffer = [0u8; 1024];
    while std::io::stdin().read(&mut buffer)? != 0 {}
    Ok(0)
}
