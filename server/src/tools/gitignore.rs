//! Git ignore checks implemented in-process with libgit2.

use anyhow::{Context, Result};
use git2::{ErrorCode, Index, Repository};
use std::path::{Path, PathBuf};

fn repository(path: &Path) -> Result<Option<Repository>> {
    match Repository::discover(path) {
        Ok(repo) => Ok(Some(repo)),
        Err(error) if error.code() == ErrorCode::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn tracked(index: &Index, relative: &Path, is_dir: bool) -> bool {
    if !is_dir {
        return index.get_path(relative, 0).is_some();
    }
    let mut prefix = PathBuf::from(relative);
    prefix.push("");
    index.find_prefix(prefix).is_ok()
}

/// Return one ignored/untracked flag per candidate, preserving input order.
pub(crate) fn ignored_flags<'a>(
    dir: &Path,
    candidates: impl IntoIterator<Item = (&'a Path, bool)>,
) -> Result<Vec<bool>> {
    let candidates = candidates.into_iter();
    let Some(repo) = repository(dir)? else {
        return Ok(candidates.map(|_| false).collect());
    };
    let workdir = repo
        .workdir()
        .context("Git repository has no working tree")?;
    let index = repo.index()?;
    let mut ignored = Vec::new();

    for (path, is_dir) in candidates {
        let Ok(relative) = path.strip_prefix(workdir) else {
            ignored.push(false);
            continue;
        };
        ignored.push(!tracked(&index, relative, is_dir) && repo.status_should_ignore(relative)?);
    }

    Ok(ignored)
}

pub(crate) fn is_ignored(dir: &Path, path: &Path, is_dir: bool) -> Result<bool> {
    Ok(ignored_flags(dir, [(path, is_dir)])?[0])
}
