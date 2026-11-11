//! Opening a local path that a chat answer links to.
//!
//! Answers link to files by path (`/Users/me/project/notes.md`). In the
//! browser those resolve against the app's own origin and land on a page
//! that does not exist, so the web UI hands the path here instead and the
//! operating system opens it, the way a Finder double-click would.
//!
//! Only paths inside an enabled workspace root are opened, and only known
//! document types are opened at all: everything else is revealed in the file
//! manager. What opening a file does is up to whichever app claims its type,
//! and on Windows that runs code for far more types than any list could name
//! (`.js`, `.py`, `.pif`, whatever an installed language registers), so a
//! block list could never show that a link in a model's answer cannot launch
//! a program. An allow list can.

use crate::{roots, state::AppState};
use anyhow::{bail, Result};
use serde::Serialize;
use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
};

/// Types opened in their default app. Each is shown by a viewer or an editor,
/// not run, wherever Squire runs. Script languages are left out even where
/// they usually open in an editor (`.py`, `.js`, `.sh`, `.lua`), because some
/// system or installed runtime runs them on open; so are Office formats that
/// carry macros (`.docm`, `.xls`, ...).
#[rustfmt::skip]
const DOCUMENT_EXTENSIONS: &[&str] = &[
    // Text, data and configuration
    "txt", "text", "md", "markdown", "mdx", "rst", "adoc", "org", "log", "csv", "tsv", "json",
    "jsonc", "json5", "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf", "xml",
    "diff", "patch", "tex", "bib", "sql", "graphql", "gql", "proto",
    // Source code that no system runs by opening it
    "rs", "ts", "tsx", "mts", "cts", "jsx", "go", "c", "h", "cc", "cpp", "cxx", "hpp", "hh",
    "m", "mm", "swift", "kt", "kts", "java", "scala", "cs", "fs", "zig", "dart", "ex", "exs",
    "erl", "hs", "ml", "vue", "svelte", "astro", "css", "scss", "sass", "less",
    // Web pages, which browsers sandbox
    "html", "htm",
    // Documents
    "pdf", "rtf", "docx", "xlsx", "pptx", "odt", "ods", "odp", "pages", "numbers", "key", "epub",
    // Images
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif", "ico",
    "svg", "psd",
    // Audio and video
    "mp3", "m4a", "wav", "flac", "ogg", "opus", "aac", "mp4", "m4v", "mov", "webm", "mkv",
    "avi",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenAction {
    /// Opened in its default app.
    Opened,
    /// Shown selected in the file manager, without running it.
    Revealed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    pub action: OpenAction,
    pub path: String,
}

/// Open `target` in its default app, or reveal it when opening would run it.
pub fn open(state: &AppState, target: &str) -> Result<OpenResult> {
    let path = existing_path(state, target)?;
    let reveal = must_reveal(&path);
    let status = opener(&path, reveal)?.status()?;
    // Explorer reports a non-zero status even when it opened the file.
    if cfg!(not(target_os = "windows")) && !status.success() {
        bail!("The system could not open {}", path.display());
    }
    Ok(OpenResult {
        action: if reveal {
            OpenAction::Revealed
        } else {
            OpenAction::Opened
        },
        path: path.to_string_lossy().into_owned(),
    })
}

/// Opens `url` in the default browser without waiting for it. Returns false
/// when no browser could be launched, such as on a Linux machine without a
/// desktop session, so the caller can tell the person to open it themselves.
pub fn open_url(url: &str) -> bool {
    #[cfg(target_os = "linux")]
    if env::var_os("DISPLAY").is_none() && env::var_os("WAYLAND_DISPLAY").is_none() {
        return false;
    }
    let Ok(mut command) = url_opener(url) else {
        return false;
    };
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    match command.spawn() {
        Ok(mut child) => {
            // Reap the launcher once it hands the URL to the browser.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            true
        }
        Err(_) => false,
    }
}

/// The command that hands `url` to the default browser.
#[cfg(target_os = "windows")]
fn url_opener(url: &str) -> Result<Command> {
    // Not `explorer`: it is a file manager, its handling of URLs is
    // undocumented, and it can start Edge alongside the default browser.
    // This is the handler Windows uses for links clicked in other apps; it
    // follows the default browser and does no shell parsing of the URL.
    let mut command = Command::new("rundll32");
    command.arg("url.dll,FileProtocolHandler").arg(url);
    Ok(command)
}

/// The command that hands `url` to the default browser: elsewhere the system
/// opener takes a URL as readily as a path (`open`, `xdg-open`, `termux-open`).
#[cfg(not(target_os = "windows"))]
fn url_opener(url: &str) -> Result<Command> {
    opener(Path::new(url), false)
}

/// Shows `path` selected in the system file manager.
pub fn reveal(path: &Path) -> Result<()> {
    let status = opener(path, true)?.status()?;
    // Explorer reports a non-zero status even when it showed the file.
    if cfg!(not(target_os = "windows")) && !status.success() {
        bail!("The system could not show {}", path.display());
    }
    Ok(())
}

/// The real path of `target`, which must exist inside an enabled root.
///
/// Answers often point into a file (`src/lib.rs:42`, `src/lib.rs:42:7`); when
/// the literal path does not exist, the file it points into is opened.
fn existing_path(state: &AppState, target: &str) -> Result<PathBuf> {
    let target = expand_home(target.trim());
    let mut candidates = vec![target.clone()];
    candidates.extend(strip_line_suffix(&target));
    for candidate in &candidates {
        let lexical = roots::resolve_safe(state, candidate)?;
        // Symlinks could point outside the roots; check where they land.
        if let Ok(real) = dunce::canonicalize(&lexical) {
            ensure_inside_roots(state, &real)?;
            return Ok(real);
        }
    }
    bail!("No such file: {target}")
}

fn ensure_inside_roots(state: &AppState, real: &Path) -> Result<()> {
    let inside = roots::enabled(state)?.visible().iter().any(|root| {
        let root = dunce::canonicalize(root).unwrap_or_else(|_| root.clone());
        real.starts_with(root)
    });
    if !inside {
        bail!("Path escapes the allowed root directories");
    }
    Ok(())
}

fn expand_home(target: &str) -> String {
    let rest = match target.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => rest,
        _ => return target.to_string(),
    };
    match env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")) {
        Some(home) => format!("{}{rest}", home.to_string_lossy()),
        None => target.to_string(),
    }
}

/// `path:12` or `path:12:3` without the line and column.
fn strip_line_suffix(path: &str) -> Option<String> {
    let mut rest = path;
    for _ in 0..2 {
        match rest.rsplit_once(':') {
            Some((head, tail)) if !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()) => {
                rest = head;
            }
            _ => break,
        }
    }
    (rest.len() < path.len() && !rest.is_empty()).then(|| rest.to_string())
}

/// Whether opening `path` could run something, so it must be revealed instead.
fn must_reveal(path: &Path) -> bool {
    let extension = path.extension().and_then(|ext| ext.to_str());
    if path.is_dir() {
        // A plain folder opens in the file manager; a folder with an extension
        // can be a bundle the system launches (`.app`, `.pkg`, `.prefPane`).
        return extension.is_some();
    }
    let document = extension.is_some_and(|ext| {
        DOCUMENT_EXTENSIONS
            .iter()
            .any(|known| known.eq_ignore_ascii_case(ext))
    });
    !document || is_executable_file(path)
}

/// An executable bit makes some openers run a file whatever its name says.
#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable_file(_path: &Path) -> bool {
    false
}

#[cfg(target_os = "macos")]
fn opener(path: &Path, reveal: bool) -> Result<Command> {
    let mut command = Command::new("open");
    if reveal {
        command.arg("-R");
    }
    command.arg(path);
    Ok(command)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn opener(path: &Path, reveal: bool) -> Result<Command> {
    // Neither opener can select a file; revealing opens its folder.
    let target = if reveal {
        path.parent().unwrap_or(path)
    } else {
        path
    };
    // Termux's `termux-open` hands paths and URLs to Android apps.
    let program = if cfg!(target_os = "android") {
        "termux-open"
    } else {
        "xdg-open"
    };
    let mut command = Command::new(program);
    command.arg(target);
    Ok(command)
}

#[cfg(target_os = "windows")]
fn opener(path: &Path, reveal: bool) -> Result<Command> {
    let mut command = Command::new("explorer");
    if reveal {
        command.arg(format!("/select,{}", path.display()));
    } else {
        command.arg(path);
    }
    Ok(command)
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "linux",
    target_os = "android",
    target_os = "windows"
)))]
fn opener(_path: &Path, _reveal: bool) -> Result<Command> {
    bail!("Opening files is not supported on this platform")
}
