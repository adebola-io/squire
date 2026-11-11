//! Instance secrets in SQLite, keyed by owner (`provider:<id>`,
//! `plugin:<id>`, ...). No OS keychain is used, by explicit
//! constraint: secrets stay in `squire.db` alongside the rows that reference
//! them, so there is never a keychain prompt and headless hosts need no
//! fallback. Reads use the shared read pool; writes go through the store's
//! single serialized writer mutex, so multi-table saves stay atomic.
use anyhow::Result;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct Secrets {
    writer: Arc<Mutex<rusqlite::Connection>>,
    readers: Pool<SqliteConnectionManager>,
}

impl Secrets {
    pub fn new(
        writer: Arc<Mutex<rusqlite::Connection>>,
        readers: Pool<SqliteConnectionManager>,
    ) -> Self {
        Self { writer, readers }
    }

    pub fn get(&self, key: &str) -> Result<Option<String>> {
        let db = self.readers.get()?;
        Ok(db
            .query_row("SELECT value FROM secrets WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()?)
    }

    pub fn set(&self, key: &str, value: &str) -> Result<()> {
        let mut db = self
            .writer
            .lock()
            .map_err(|_| anyhow::anyhow!("sqlite writer poisoned"))?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO secrets(key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn delete(&self, key: &str) -> Result<()> {
        let mut db = self
            .writer
            .lock()
            .map_err(|_| anyhow::anyhow!("sqlite writer poisoned"))?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("DELETE FROM secrets WHERE key = ?1", [key])?;
        tx.commit()?;
        Ok(())
    }
}
