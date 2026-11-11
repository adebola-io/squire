use crate::state::AppState;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

#[derive(Serialize, Deserialize, Clone)]
pub struct RootEntry {
    pub path: String,
    pub enabled: bool,
    #[serde(default)]
    pub exists: bool,
}

/// Normalized roots as of the last load. Tool calls resolve paths against this
/// snapshot instead of re-reading the store and re-canonicalizing every
/// root per path; mutations and the desktop listing refresh it.
pub struct RootSet {
    visible: Vec<PathBuf>,
}

impl RootSet {
    fn new(entries: &[RootEntry]) -> Self {
        let visible = entries
            .iter()
            .filter(|root| root.enabled && root.exists)
            .map(|root| PathBuf::from(&root.path))
            .collect();
        Self { visible }
    }

    /// Enabled roots that existed when the set was loaded.
    pub fn visible(&self) -> &[PathBuf] {
        &self.visible
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    name: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveEntry {
    name: String,
    path: String,
    /// The drive the listed folder is on.
    current: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    path: String,
    parent_path: Option<String>,
    home_path: String,
    /// Every folder from the filesystem root down to `path`. Built here so the
    /// UI never splits paths itself: Windows paths use `\` and start at a
    /// drive, not at `/`.
    breadcrumbs: Vec<DirectoryEntry>,
    /// Drive roots (`C:\`, `D:\`, …) on Windows. Empty elsewhere, where every
    /// volume hangs off `/`.
    drives: Vec<DriveEntry>,
    directories: Vec<DirectoryEntry>,
}

fn load(state: &AppState) -> Result<Vec<RootEntry>> {
    let saved = state.store.read_blocking(|db| {
        Ok(db
            .prepare("SELECT path,enabled FROM roots ORDER BY id")?
            .query_map([], |r| {
                Ok(RootEntry {
                    path: r.get(0)?,
                    enabled: r.get(1)?,
                    exists: false,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    })?;
    saved
        .into_iter()
        .map(|root| root_entry(&root.path, root.enabled))
        .collect()
}

/// The cached root set, loading it on first use. Initial load is serialized
/// with mutations so an older disk snapshot can never overwrite newer state.
pub fn snapshot(state: &AppState) -> Result<Arc<RootSet>> {
    if let Some(set) = state.roots.read().unwrap().as_ref() {
        return Ok(set.clone());
    }
    let mut cached = state.roots.write().unwrap();
    if let Some(set) = cached.as_ref() {
        return Ok(set.clone());
    }
    let set = Arc::new(RootSet::new(&load(state)?));
    *cached = Some(set.clone());
    Ok(set)
}

/// Fresh listing for the desktop UI; also refreshes the cached snapshot so
/// roots created or removed on disk are picked up.
pub fn list(state: &AppState) -> Result<Vec<RootEntry>> {
    let mut cached = state.roots.write().unwrap();
    let entries = load(state)?;
    *cached = Some(Arc::new(RootSet::new(&entries)));
    Ok(entries)
}

pub fn browse(path: Option<&str>) -> Result<DirectoryListing> {
    let home = crate::util::home_dir()?;
    let requested = path.map(requested_path).unwrap_or_else(|| home.clone());
    if !requested.is_absolute() {
        bail!("Enter a full folder path, such as {}", home.display());
    }
    let current = dunce::canonicalize(&requested)
        .with_context(|| format!("Could not open directory `{}`", requested.display()))?;
    if !current.is_dir() {
        bail!("Path must be an existing directory");
    }

    let mut directories = Vec::new();
    let entries = fs::read_dir(&current)
        .with_context(|| format!("Could not read directory `{}`", current.display()))?;
    for entry in entries.flatten() {
        let entry_path = entry.path();
        if !entry_path.is_dir() {
            continue;
        }
        directories.push(DirectoryEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry_path.to_string_lossy().into_owned(),
        });
    }
    directories.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
    });

    Ok(DirectoryListing {
        path: current.to_string_lossy().into_owned(),
        parent_path: current
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned()),
        home_path: dunce::canonicalize(&home)
            .unwrap_or(home)
            .to_string_lossy()
            .into_owned(),
        breadcrumbs: breadcrumbs(&current),
        drives: drives(&current),
        directories,
    })
}

fn requested_path(path: &str) -> PathBuf {
    let path = path.trim();
    // A bare `D:` means "the working folder on D:", not the drive's root.
    if cfg!(windows)
        && path.len() == 2
        && path.ends_with(':')
        && path.as_bytes()[0].is_ascii_alphabetic()
    {
        return PathBuf::from(format!("{path}\\"));
    }
    PathBuf::from(path)
}

fn breadcrumbs(path: &Path) -> Vec<DirectoryEntry> {
    let mut crumbs = path
        .ancestors()
        .map(|ancestor| DirectoryEntry {
            name: ancestor
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| root_label(ancestor)),
            path: ancestor.to_string_lossy().into_owned(),
        })
        .collect::<Vec<_>>();
    crumbs.reverse();
    crumbs
}

/// `C:\` reads as `C:` and `\\server\share\` as `\\server\share`; `/` stays.
fn root_label(root: &Path) -> String {
    let label = root.to_string_lossy();
    let trimmed = label.trim_end_matches(['\\', '/']);
    if trimmed.is_empty() {
        label.into_owned()
    } else {
        trimmed.to_owned()
    }
}

#[cfg(windows)]
fn drives(current: &Path) -> Vec<DriveEntry> {
    let current = current.to_string_lossy();
    (b'A'..=b'Z')
        .map(char::from)
        .filter_map(|letter| {
            let name = format!("{letter}:");
            let path = format!("{name}\\");
            // Empty card readers and optical drives are not directories.
            Path::new(&path).is_dir().then(|| DriveEntry {
                current: current
                    .get(..2)
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case(&name)),
                name,
                path,
            })
        })
        .collect()
}

#[cfg(not(windows))]
fn drives(_current: &Path) -> Vec<DriveEntry> {
    Vec::new()
}

/// Applies `update` to the on-disk roots and publishes the result. The write
/// lock is held throughout so concurrent mutations cannot interleave.
fn mutate(
    state: &AppState,
    update: impl FnOnce(&mut Vec<RootEntry>) -> Result<bool>,
) -> Result<Vec<RootEntry>> {
    let mut cached = state.roots.write().unwrap();
    let mut roots = load(state)?;
    if update(&mut roots)? {
        write(state, &roots)?;
    }
    *cached = Some(Arc::new(RootSet::new(&roots)));
    Ok(roots)
}

pub fn add(state: &AppState, path: &str) -> Result<Vec<RootEntry>> {
    let root = root_entry(path, true)?;
    if !root.exists {
        bail!("Root path must be an existing directory");
    }
    mutate(state, |roots| {
        if roots.iter().any(|entry| entry.path == root.path) {
            return Ok(false);
        }
        roots.push(root);
        Ok(true)
    })
}

pub fn set_enabled(state: &AppState, path: &str, enabled: bool) -> Result<Vec<RootEntry>> {
    let normalized = root_entry(path, enabled)?.path;
    mutate(state, |roots| {
        roots
            .iter_mut()
            .find(|root| root.path == normalized)
            .context("Root not found")?
            .enabled = enabled;
        Ok(true)
    })
}

pub fn remove(state: &AppState, path: &str) -> Result<Vec<RootEntry>> {
    let normalized = root_entry(path, true)?.path;
    mutate(state, |roots| {
        let index = roots
            .iter()
            .position(|root| root.path == normalized)
            .context("Root not found")?;
        roots.remove(index);
        Ok(true)
    })
}

pub fn visible_paths_text(state: &AppState) -> Result<String> {
    Ok(snapshot(state)?
        .visible()
        .iter()
        .map(|root| root.to_string_lossy())
        .collect::<Vec<_>>()
        .join("\n"))
}

const TREE_DEPTH: usize = 3;
const TREE_MAX_PER_DIRECTORY: usize = 45;
const TREE_MAX_PER_ROOT: usize = 160;
const TREE_MAX_TOTAL: usize = 400;
const TREE_SCAN_LIMIT: usize = 2000;

/// A small, stable workspace overview for the frozen conversation prompt.
/// These paths are context, not permission: file tools still enforce roots.
pub fn workspace_trees_text(state: &AppState) -> Result<String> {
    let roots = snapshot(state)?;
    if roots.visible().is_empty() {
        return Ok("(none configured)".to_owned());
    }

    let mut out = String::new();
    let mut total_remaining = TREE_MAX_TOTAL;
    for root in roots.visible() {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&root.to_string_lossy());
        out.push('\n');
        if total_remaining == 0 {
            out.push_str("  ... (workspace listing limit reached)\n");
            continue;
        }
        let mut root_remaining = TREE_MAX_PER_ROOT.min(total_remaining);
        tree_directory(root, "", 0, &mut root_remaining, &mut out);
        total_remaining -= TREE_MAX_PER_ROOT.min(total_remaining) - root_remaining;
    }
    Ok(out)
}

fn tree_directory(
    path: &std::path::Path,
    indent: &str,
    depth: usize,
    remaining: &mut usize,
    out: &mut String,
) {
    if depth >= TREE_DEPTH || *remaining == 0 {
        return;
    }
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(_) => {
            out.push_str(indent);
            out.push_str("└── (directory unavailable)\n");
            return;
        }
    };
    let mut items = entries
        .take(TREE_SCAN_LIMIT + 1)
        .filter_map(|result| {
            let entry = result.ok()?;
            let file_type = entry.file_type().ok()?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if file_type.is_dir()
                && matches!(
                    name.as_str(),
                    ".git"
                        | "node_modules"
                        | ".venv"
                        | "venv"
                        | "target"
                        | "dist"
                        | "build"
                        | ".next"
                        | ".cache"
                        | "__pycache__"
                        | "coverage"
                )
            {
                return None;
            }
            Some((
                name,
                entry.path(),
                file_type.is_dir(),
                file_type.is_symlink(),
            ))
        })
        .collect::<Vec<_>>();
    let scan_limited = items.len() > TREE_SCAN_LIMIT;
    items.truncate(TREE_SCAN_LIMIT);
    items.sort_by(|a, b| {
        b.2.cmp(&a.2)
            .then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase()))
            .then_with(|| a.0.cmp(&b.0))
    });
    let show = items.len().min(TREE_MAX_PER_DIRECTORY).min(*remaining);
    let more = show < items.len() || scan_limited;
    let mut shown = 0;
    for (index, (name, child, directory, symlink)) in items.into_iter().take(show).enumerate() {
        if *remaining == 0 {
            break;
        }
        shown += 1;
        let last = index + 1 == show && !more;
        out.push_str(indent);
        out.push_str(if last { "└── " } else { "├── " });
        // Names can contain line breaks and control characters; keep them on one line.
        out.extend(
            name.chars()
                .map(|ch| if ch.is_control() { ' ' } else { ch }),
        );
        if directory {
            out.push('/');
        } else if symlink {
            out.push('@');
        }
        out.push('\n');
        *remaining -= 1;
        if directory && depth + 1 < TREE_DEPTH && *remaining > 0 {
            let mut next = indent.to_owned();
            next.push_str(if last { "    " } else { "│   " });
            tree_directory(&child, &next, depth + 1, remaining, out);
        }
    }
    if more || shown < show {
        out.push_str(indent);
        out.push_str("└── ... (more entries)\n");
    }
}

/// The visible roots, failing when there are none.
pub fn enabled(state: &AppState) -> Result<Arc<RootSet>> {
    let roots = snapshot(state)?;
    if roots.visible().is_empty() {
        bail!("No Squire roots are enabled");
    }
    Ok(roots)
}

pub fn resolve_safe(state: &AppState, target: &str) -> Result<PathBuf> {
    resolve_path(state, target, false)
}

/// Read access includes Squire's internal, read-only attachment cache.
pub fn resolve_readable(state: &AppState, target: &str) -> Result<PathBuf> {
    resolve_path(state, target, true)
}

fn resolve_path(state: &AppState, target: &str, readable: bool) -> Result<PathBuf> {
    let path = PathBuf::from(target);
    if !path.is_absolute() {
        bail!("Path must be absolute");
    }
    // Canonicalize the nearest existing ancestor so `..` and symlinks in
    // existing prefixes cannot escape; the non-existent remainder is joined
    // lexically and checked against the canonical roots.
    let mut ancestor = path.as_path();
    let mut remainder = Vec::new();
    while !ancestor.exists() {
        let Some(parent) = ancestor.parent() else {
            bail!("Path escapes the allowed root directories");
        };
        if let Some(file_name) = ancestor.file_name() {
            remainder.push(file_name.to_owned());
        }
        ancestor = parent;
    }
    let canonical = dunce::canonicalize(ancestor)
        .with_context(|| format!("Could not resolve `{}`", ancestor.display()))?;
    let mut normalized = canonical;
    for component in remainder.into_iter().rev() {
        normalized.push(component);
    }
    let normalized = normalize_lexically(normalized);
    if normalized.starts_with(state.config.storage.attachments_dir()) {
        if !readable {
            bail!(
                "The attachments cache is read-only; pass an output path inside a workspace root"
            );
        }
        return Ok(normalized);
    }
    if !enabled(state)?
        .visible()
        .iter()
        .any(|root| normalized.starts_with(root))
    {
        bail!("Path escapes the allowed root directories");
    }
    Ok(normalized)
}

fn write(state: &AppState, roots: &[RootEntry]) -> Result<()> {
    let roots = roots.to_vec();
    state.store.write_blocking(move |db| {
        let existing = db
            .prepare("SELECT path,enabled FROM roots")?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)))?
            .collect::<rusqlite::Result<std::collections::HashMap<_, _>>>()?;
        let now = chrono::Utc::now().timestamp_millis();
        for root in &roots {
            match existing.get(&root.path) {
                Some(enabled) if *enabled == root.enabled => {}
                Some(_) => {
                    db.execute(
                        "UPDATE roots SET enabled=?2 WHERE path=?1",
                        rusqlite::params![root.path, root.enabled],
                    )?;
                }
                None => {
                    db.execute(
                        "INSERT INTO roots(path,enabled,added_at) VALUES (?1,?2,?3)",
                        rusqlite::params![root.path, root.enabled, now],
                    )?;
                }
            }
        }
        for path in existing.keys() {
            if !roots.iter().any(|r| &r.path == path) {
                db.execute("DELETE FROM roots WHERE path=?1", [path])?;
            }
        }
        Ok(())
    })
}

fn root_entry(path: &str, enabled: bool) -> Result<RootEntry> {
    let normalized = absolutize(PathBuf::from(path));
    Ok(RootEntry {
        path: normalized.to_string_lossy().into(),
        enabled,
        exists: normalized.is_dir(),
    })
}

fn absolutize(path: PathBuf) -> PathBuf {
    let full = if path.is_absolute() {
        path
    } else {
        normalize_lexically(path)
    };
    // `dunce` keeps Windows paths in their usual form, not `\\?\C:\…`, so
    // roots read normally in the UI and Explorer and plugins accept them.
    dunce::canonicalize(&full).unwrap_or_else(|_| normalize_lexically(full))
}

fn normalize_lexically(path: PathBuf) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            value => normalized.push(value.as_os_str()),
        }
    }
    normalized
}
