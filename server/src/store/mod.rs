//! Unified SQLite store (plan 013).
//!
//! Machine-managed persistence with a serialized writer and independent readers.
pub mod activity;
pub mod blobs;
pub mod changes;
pub mod connections;
pub mod conversations;
pub mod schema;
pub mod secrets;

use crate::storage::StoragePaths;
use anyhow::{Context, Result};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{Connection, TransactionBehavior};
use std::{
    fs,
    fs::File,
    sync::{Arc, Mutex},
};

/// Another process holds this home's `store.lock`: a Squire is already
/// running from it. Every Squire version takes this lock, so `main` uses it
/// to hand a second launch over to the running one.
#[derive(Debug)]
pub struct HomeInUse;

impl std::fmt::Display for HomeInUse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Squire is already using this home directory")
    }
}

impl std::error::Error for HomeInUse {}

/// Whether another process holds this home's lock right now. Checking takes the lock for a
/// moment and releases it.
pub fn home_in_use(paths: &StoragePaths) -> Result<bool> {
    let path = paths.squire_home.join("store.lock");
    if !path.exists() {
        return Ok(false);
    }
    let file = fs::OpenOptions::new().read(true).write(true).open(&path)?;
    match file.try_lock() {
        Ok(()) => Ok(false),
        Err(fs::TryLockError::WouldBlock) => Ok(true),
        Err(fs::TryLockError::Error(error)) => Err(error.into()),
    }
}

/// Single serialized transaction writer, independent read-only WAL pool.
///
/// The writer is a plain `Mutex<Connection>`; all writes run in one
/// transaction on whichever blocking thread holds the lock. Reads use the
/// pool and never wait for the writer. There is exactly one writable
/// connection (this mutex); `Secrets` shares it, so multi-table writes stay
/// atomic in a single transaction.
pub struct Store {
    writer: Arc<Mutex<Connection>>,
    _home_lock: File,
    readers: Pool<SqliteConnectionManager>,
    pub blobs: blobs::BlobStore,
    pub secrets: secrets::Secrets,
    pub chatgpt_auth_path: std::path::PathBuf,
}

impl Store {
    pub fn open(paths: &StoragePaths) -> Result<Self> {
        fs::create_dir_all(&paths.squire_home)?;
        // The unified database also contains installation credentials. Restrict
        // access for both fresh and existing homes before opening SQLite.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&paths.squire_home, fs::Permissions::from_mode(0o700))?;
        }
        let home_lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(paths.squire_home.join("store.lock"))?;
        match home_lock.try_lock() {
            Ok(()) => {}
            Err(fs::TryLockError::WouldBlock) => return Err(HomeInUse.into()),
            Err(fs::TryLockError::Error(error)) => {
                return Err(anyhow::Error::new(error).context("locking the Squire home directory"));
            }
        }
        let path = paths.db();
        let mut db =
            Connection::open(&path).with_context(|| format!("opening {}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        }
        configure(&db)?;
        schema::setup(&mut db)?;

        let manager = SqliteConnectionManager::file(&path).with_init(|db| {
            configure(db)?;
            db.execute_batch("PRAGMA query_only = ON;")
        });
        let readers = Pool::builder()
            .max_size(4)
            .min_idle(Some(4))
            .build(manager)?;
        let writer = Arc::new(Mutex::new(db));
        let secrets = secrets::Secrets::new(writer.clone(), readers.clone());
        Ok(Self {
            writer,
            _home_lock: home_lock,
            readers,
            blobs: blobs::BlobStore::new(paths.blobs_dir(), paths.attachments_dir()),
            secrets,
            chatgpt_auth_path: paths.squire_home.join("auth").join("chatgpt.json"),
        })
    }

    pub async fn maintain(&self, retention_days: i64) -> Result<()> {
        let now = chrono::Utc::now().timestamp_millis();
        self.write(move |db| {
            changes::prune(db, now)?;
            connections::prune_payloads(db, now, retention_days)?;
            db.execute_batch("PRAGMA optimize;")?;
            Ok(())
        })
        .await?;
        self.blobs.sweep(self, now).await?;
        Ok(())
    }

    /// Synchronous domain operations run on the shared writer mutex.
    /// On Tokio workers, `block_in_place` lets the runtime schedule other work.
    pub fn write_blocking<T, F>(&self, write: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&rusqlite::Transaction<'_>) -> Result<T> + Send + 'static,
    {
        let writer = self.writer.clone();
        let run = move || {
            let mut db = writer
                .lock()
                .map_err(|_| anyhow::anyhow!("sqlite writer poisoned"))?;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let value = write(&tx)?;
            tx.commit()?;
            Ok(value)
        };
        match tokio::runtime::Handle::try_current() {
            Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
                tokio::task::block_in_place(run)
            }
            _ => run(),
        }
    }

    pub fn read_blocking<T, F>(&self, read: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T> + Send + 'static,
    {
        // Readers are checked out per call; the writer mutex is never held here.
        match tokio::runtime::Handle::try_current() {
            Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
                let pool = self.readers.clone();
                tokio::task::block_in_place(move || {
                    let db = pool.get()?;
                    read(&db)
                })
            }
            _ => {
                let db = self.readers.get()?;
                read(&db)
            }
        }
    }

    /// The write closure runs in one transaction on the shared writer mutex,
    /// executed on the blocking pool. Dropping an uncommitted transaction
    /// automatically rolls it back.
    pub async fn write<T, F>(&self, write: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&rusqlite::Transaction<'_>) -> Result<T> + Send + 'static,
    {
        let writer = self.writer.clone();
        tokio::task::spawn_blocking(move || {
            let mut db = writer
                .lock()
                .map_err(|_| anyhow::anyhow!("sqlite writer poisoned"))?;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let value = write(&tx)?;
            tx.commit()?;
            Ok(value)
        })
        .await
        .context("SQLite write task failed")?
    }

    /// Read-only work executes in Tokio's blocking pool, checking out a
    /// separate SQLite connection without waiting for the writer.
    pub async fn read<T, F>(&self, read: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T> + Send + 'static,
    {
        let pool = self.readers.clone();
        tokio::task::spawn_blocking(move || {
            let db = pool.get()?;
            read(&db)
        })
        .await
        .context("SQLite read task failed")?
    }
}

fn configure(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;
         PRAGMA temp_store = MEMORY;
         PRAGMA cache_size = -32000;
         PRAGMA mmap_size = 268435456;
         PRAGMA journal_size_limit = 67108864;",
    )
}
