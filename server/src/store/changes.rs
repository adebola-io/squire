//! Durable, bounded changes for reconnecting clients.
use anyhow::{bail, Result};
use rusqlite::{params, Connection, Transaction};
use serde::Serialize;

#[derive(Debug)]
pub struct ExpiredCursor {
    pub latest: i64,
}
impl std::fmt::Display for ExpiredCursor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "change cursor expired")
    }
}
impl std::error::Error for ExpiredCursor {}
const RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const PAGE_SIZE: usize = 500;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub seq: i64,
    pub at: i64,
    pub entity_kind: String,
    pub entity_id: i64,
    pub rev: i64,
    pub deleted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub changes: Vec<Change>,
    pub next_since: i64,
    pub has_more: bool,
}

pub fn append(
    db: &Transaction<'_>,
    kind: &str,
    id: i64,
    rev: i64,
    deleted: bool,
    now: i64,
) -> Result<i64> {
    db.execute(
        "INSERT INTO changes(at, entity_kind, entity_id, rev, deleted) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![now, kind, id, rev, deleted],
    )?;
    Ok(db.last_insert_rowid())
}

pub fn since(db: &Connection, cursor: i64) -> Result<Page> {
    if cursor < 0 {
        bail!("invalid change cursor");
    }
    let floor: i64 = db
        .query_row(
            "SELECT value FROM meta WHERE key = 'change_log_floor'",
            [],
            |row| row.get::<_, String>(0),
        )
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok("0".into()),
            _ => Err(e),
        })?
        .parse()?;
    if cursor < floor {
        let latest = db.query_row("SELECT COALESCE(MAX(seq),?1) FROM changes", [floor], |r| {
            r.get(0)
        })?;
        return Err(ExpiredCursor { latest }.into());
    }

    let mut stmt = db.prepare(
        "SELECT seq, at, entity_kind, entity_id, rev, deleted
         FROM changes WHERE seq > ?1 ORDER BY seq LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![cursor, PAGE_SIZE as i64 + 1], |row| {
        Ok(Change {
            seq: row.get(0)?,
            at: row.get(1)?,
            entity_kind: row.get(2)?,
            entity_id: row.get(3)?,
            rev: row.get(4)?,
            deleted: row.get::<_, i64>(5)? != 0,
        })
    })?;
    let mut changes: Vec<_> = rows.collect::<rusqlite::Result<_>>()?;
    let has_more = changes.len() > PAGE_SIZE;
    changes.truncate(PAGE_SIZE);
    let next_since = changes.last().map_or(cursor, |c| c.seq);
    Ok(Page {
        changes,
        next_since,
        has_more,
    })
}

/// Pruning and advancing the floor must be one writer transaction.
pub fn prune(db: &Transaction<'_>, now: i64) -> Result<usize> {
    let cutoff = now - RETENTION_MS;
    let last: Option<i64> = db.query_row(
        "SELECT MAX(seq) FROM changes WHERE at < ?1",
        [cutoff],
        |r| r.get(0),
    )?;
    let Some(last) = last else { return Ok(0) };
    let count = db.execute("DELETE FROM changes WHERE seq <= ?1", [last])?;
    db.execute(
        "INSERT INTO meta(key,value) VALUES ('change_log_floor',?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [last.to_string()],
    )?;
    Ok(count)
}
