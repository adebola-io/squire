//! Content-addressed disk bytes. The SQLite attachment tables own references;
//! adding/removing an attachment row updates the count via schema triggers.
use super::Store;
use anyhow::{ensure, Context, Result};
use rusqlite::{params, Transaction};
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;

const GRACE_PERIOD_MS: i64 = 60 * 60 * 1000;
#[derive(Clone)]
pub struct BlobStore {
    root: PathBuf,
    cache: PathBuf,
}

impl BlobStore {
    pub fn new(root: PathBuf, cache: PathBuf) -> Self {
        Self { root, cache }
    }

    pub fn put_in(
        &self,
        db: &rusqlite::Connection,
        bytes: &[u8],
        mime: &str,
        now: i64,
    ) -> Result<String> {
        let hash = format!("{:x}", Sha256::digest(bytes));
        persist(&self.path(&hash)?, bytes)?;
        db.execute("INSERT OR IGNORE INTO blobs(hash,mime_type,bytes,created_at,unreferenced_at) VALUES (?1,?2,?3,?4,?4)", params![hash,mime,bytes.len() as i64,now])?;
        Ok(hash)
    }

    pub fn path(&self, hash: &str) -> Result<PathBuf> {
        if !valid_hash(hash) {
            anyhow::bail!("invalid blob hash");
        }
        Ok(self.root.join(&hash[..2]).join(hash))
    }

    /// Deterministic path for one stored name; invalid hashes have no path.
    pub fn cache_path(&self, hash: &str, name: &str, mime: &str) -> Option<PathBuf> {
        valid_hash(hash).then(|| self.cache.join(hash).join(cache_file_name(name, mime)))
    }

    /// Rebuild a missing or wrong-length copy from the immutable blob archive.
    /// The normal case requires only one metadata check.
    pub fn materialize(&self, hash: &str, name: &str, mime: &str, bytes: u64) -> Result<PathBuf> {
        let path = self
            .cache_path(hash, name, mime)
            .context("Invalid attachment hash")?;
        if cache_matches(&path, bytes) {
            return Ok(path);
        }
        let dir = path.parent().context("Attachment cache has no directory")?;
        fs::create_dir_all(dir)?;
        ensure!(
            fs::symlink_metadata(dir)?.is_dir(),
            "Attachment cache directory is not a directory"
        );
        let mut temp = NamedTempFile::new_in(dir)?;
        let mut source = fs::File::open(self.path(hash)?)?;
        let copied = io::copy(&mut source, temp.as_file_mut())?;
        ensure!(
            copied == bytes,
            "Attachment blob byte count differs from stored metadata"
        );
        temp.as_file().sync_all()?;
        match fs::symlink_metadata(&path) {
            // Never chmod a symlink: it could point outside the cache.
            Ok(meta) if meta.file_type().is_symlink() => fs::remove_file(&path)?,
            #[cfg(windows)]
            Ok(meta) => {
                let mut permissions = meta.permissions();
                permissions.set_readonly(false);
                fs::set_permissions(&path, permissions)?;
            }
            #[cfg(not(windows))]
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        if let Err(error) = temp.persist(&path) {
            // Another caller may have finished the same copy on Windows,
            // where replacing its read-only file can fail.
            if cache_matches(&path, bytes) {
                let mut permissions = fs::metadata(&path)?.permissions();
                permissions.set_readonly(true);
                fs::set_permissions(&path, permissions)?;
                return Ok(path);
            }
            return Err(error.error.into());
        }
        let mut permissions = fs::metadata(&path)?.permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions)?;
        Ok(path)
    }

    /// Materialize when needed and return the path portion of a model-facing note.
    /// A missing blob still leaves a usable attachment ID in the note.
    pub fn materialized_path_note(&self, hash: &str, name: &str, mime: &str, bytes: u64) -> String {
        match self.materialize(hash, name, mime, bytes) {
            Ok(path) => format!(", read-only path {}", path.display()),
            Err(error) => {
                tracing::warn!(%error, %hash, "Could not materialize attachment");
                String::new()
            }
        }
    }

    /// Persist bytes and catalog them atomically with respect to other writes
    /// and garbage collection. A repeated hash points to the same file.
    pub async fn put(
        &self,
        store: &Store,
        bytes: Vec<u8>,
        mime_type: String,
        now: i64,
    ) -> Result<String> {
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let path = self.path(&hash)?;
        let size = bytes.len() as i64;
        let saved_hash = hash.clone();
        store
            .write(move |db| {
                persist(&path, &bytes)?;
                db.execute(
                "INSERT OR IGNORE INTO blobs(hash,mime_type,bytes,refs,created_at,unreferenced_at)
                 VALUES (?1,?2,?3,0,?4,?4)",
                params![saved_hash, mime_type, size, now],
            )?;
                Ok(())
            })
            .await?;
        Ok(hash)
    }

    /// Prune unreferenced blobs and their derived cache copies.
    pub async fn sweep(&self, store: &Store, now: i64) -> Result<usize> {
        let root = self.clone();
        let removed = store.write(move |db| sweep(db, &root, now)).await?;

        // A failed SQL transaction can leave a fully written file without a
        // catalog row. Discover old candidates outside the writer, then check
        // ownership again under the writer before removing anything.
        let root = self.root.clone();
        let candidates = tokio::task::spawn_blocking(move || -> Result<Vec<(String, PathBuf)>> {
            let mut files = vec![];
            if !root.exists() {
                return Ok(files);
            }
            for directory in fs::read_dir(root)? {
                let directory = directory?;
                if !directory.file_type()?.is_dir() {
                    continue;
                }
                for entry in fs::read_dir(directory.path())? {
                    let entry = entry?;
                    let metadata = entry.metadata()?;
                    let modified = metadata
                        .modified()?
                        .duration_since(std::time::UNIX_EPOCH)?
                        .as_millis() as i64;
                    if metadata.is_file() && modified <= now - GRACE_PERIOD_MS {
                        files.push((
                            entry.file_name().to_string_lossy().into_owned(),
                            entry.path(),
                        ));
                    }
                }
            }
            Ok(files)
        })
        .await??;
        let candidates = store
            .read(move |db| {
                let mut query = db.prepare("SELECT 1 FROM blobs WHERE hash=?1")?;
                let mut orphans = vec![];
                for (hash, path) in candidates {
                    if !query.exists([&hash])? {
                        orphans.push((hash, path));
                    }
                    if orphans.len() == 1000 {
                        break;
                    }
                }
                Ok(orphans)
            })
            .await?;
        let orphans = store
            .write(move |db| {
                let mut count = 0;
                for (hash, path) in candidates {
                    if !db
                        .prepare("SELECT 1 FROM blobs WHERE hash=?1")?
                        .exists([hash])?
                    {
                        match fs::remove_file(path) {
                            Ok(()) => count += 1,
                            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                            Err(e) => return Err(e.into()),
                        }
                    }
                }
                Ok(count)
            })
            .await?;

        // Also prune a cache left behind by a crash or a former sweep.
        let cache = self.cache.clone();
        let candidates = tokio::task::spawn_blocking(move || -> Result<Vec<String>> {
            let mut hashes = vec![];
            if !cache.exists() {
                return Ok(hashes);
            }
            for entry in fs::read_dir(cache)? {
                let entry = entry?;
                if !entry.file_type()?.is_dir() {
                    continue;
                }
                let hash = entry.file_name().to_string_lossy().into_owned();
                let modified = entry
                    .metadata()?
                    .modified()?
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_millis() as i64;
                if modified <= now - GRACE_PERIOD_MS && valid_hash(&hash) {
                    hashes.push(hash);
                }
            }
            Ok(hashes)
        })
        .await??;
        let stale = store
            .read(move |db| {
                let mut query = db.prepare("SELECT 1 FROM blobs WHERE hash=?1")?;
                let mut hashes = vec![];
                for hash in candidates {
                    if !query.exists([&hash])? {
                        hashes.push(hash);
                    }
                    if hashes.len() == 1000 {
                        break;
                    }
                }
                Ok(hashes)
            })
            .await?;
        for hash in &stale {
            self.remove_cache_best_effort(hash);
        }
        Ok(removed + orphans)
    }

    fn remove_cache_best_effort(&self, hash: &str) {
        if !valid_hash(hash) {
            return;
        }
        let dir = self.cache.join(hash);
        let result = (|| -> Result<()> {
            match fs::symlink_metadata(&dir) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(error.into()),
                Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
                    fs::remove_file(&dir)?;
                    return Ok(());
                }
                Ok(_) => {}
            }
            #[cfg(windows)]
            for entry in fs::read_dir(&dir)? {
                let entry = entry?;
                let mut permissions = entry.metadata()?.permissions();
                permissions.set_readonly(false);
                fs::set_permissions(entry.path(), permissions)?;
            }
            fs::remove_dir_all(dir)?;
            Ok(())
        })();
        if let Err(error) = result {
            tracing::warn!(%hash, %error, "Could not remove attachment cache");
        }
    }
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn cache_matches(path: &Path, bytes: u64) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() == bytes)
}

/// One safe UTF-8 path segment, bounded to 120 bytes.
fn cache_file_name(name: &str, mime: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim_start_matches('.').trim().trim_end_matches('.');
    let cleaned = if cleaned.is_empty() {
        "attachment"
    } else {
        cleaned
    };
    let existing_ext = Path::new(cleaned)
        .extension()
        .and_then(|ext| ext.to_str())
        .filter(|ext| {
            !ext.is_empty() && ext.len() <= 12 && ext.bytes().all(|b| b.is_ascii_alphanumeric())
        });
    let (stem, extension) = if let Some(ext) = existing_ext {
        (&cleaned[..cleaned.len() - ext.len() - 1], format!(".{ext}"))
    } else {
        (
            cleaned,
            mime_guess::get_mime_extensions_str(mime)
                .and_then(|extensions| extensions.first().copied())
                .map(|ext| format!(".{ext}"))
                .unwrap_or_default(),
        )
    };
    let limit = 120usize.saturating_sub(extension.len());
    let mut end = stem.len().min(limit);
    while !stem.is_char_boundary(end) {
        end -= 1;
    }
    let stem = stem[..end].trim_end_matches('.');
    format!(
        "{}{}",
        if stem.is_empty() { "attachment" } else { stem },
        extension
    )
}

fn persist(path: &Path, bytes: &[u8]) -> Result<()> {
    if path.exists() {
        return Ok(());
    }
    let parent = path.parent().context("blob must have a parent")?;
    fs::create_dir_all(parent)?;
    let mut tmp = NamedTempFile::new_in(parent)?;
    io::Write::write_all(&mut tmp, bytes)?;
    tmp.as_file().sync_all()?;
    match tmp.persist_noclobber(path) {
        Ok(_) => Ok(()),
        Err(e) if e.error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e.error.into()),
    }
}

fn sweep(db: &Transaction<'_>, store: &BlobStore, now: i64) -> Result<usize> {
    let cutoff = now - GRACE_PERIOD_MS;
    let hashes: Vec<String> = {
        let mut stmt = db.prepare(
            "SELECT hash FROM blobs WHERE refs = 0 AND unreferenced_at <= ?1 LIMIT 1000",
        )?;
        let rows = stmt
            .query_map([cutoff], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for hash in &hashes {
        let path = store.path(hash)?;
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        db.execute("DELETE FROM blobs WHERE hash = ?1 AND refs = 0", [hash])?;
    }
    Ok(hashes.len())
}

/// Copies payload ownership and blob references without copying disk bytes.
pub fn copy_payload(db: &rusqlite::Connection, source: i64) -> Result<i64> {
    db.execute("INSERT INTO payloads(args_json,result_json,model_text) SELECT args_json,result_json,model_text FROM payloads WHERE id=?1", [source])?;
    let id = db.last_insert_rowid();
    db.execute("INSERT INTO result_attachments SELECT ?2,idx,name,mime_type,bytes,width,height,blob_hash FROM result_attachments WHERE payload_id=?1", params![source,id])?;
    Ok(id)
}
