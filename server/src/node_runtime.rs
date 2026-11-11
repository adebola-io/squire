//! The Node.js runtime embedded at build time (see `build.rs`), extracted once
//! to `SQUIRE_HOME/runtimes/node/<version>`. Squire never runs a Node.js found
//! on PATH. nodejs.org publishes no Android build, so on Android it runs
//! Termux's own Node.js (`pkg install nodejs`) instead.
//!
//! The same archive carries npm, which provides `npx` for curated marketplace
//! MCP listings. npm is thousands of small files, so it is unpacked only the
//! first time such a listing starts ([`npx`]).

use anyhow::Result;
#[cfg(not(target_os = "android"))]
use anyhow::{ensure, Context};
use std::path::{Path, PathBuf};
#[cfg(not(target_os = "android"))]
use std::{fs, sync::Mutex};

#[cfg(not(target_os = "android"))]
const VERSION: &str = env!("SQUIRE_NODE_VERSION");
/// The official nodejs.org archive for this target, verified by `build.rs`:
/// a `.tar.xz` on macOS and Linux, a `.zip` on Windows.
#[cfg(not(target_os = "android"))]
const ARCHIVE: &[u8] = include_bytes!(env!("SQUIRE_NODE_ARCHIVE"));

/// The executable's path inside the archive's top-level directory.
#[cfg(all(unix, not(target_os = "android")))]
const EXECUTABLE: &str = "bin/node";
#[cfg(windows)]
const EXECUTABLE: &str = "node.exe";

/// npm's package directory inside the archive's top-level directory.
#[cfg(all(unix, not(target_os = "android")))]
const NPM_DIR: &str = "lib/node_modules/npm";
#[cfg(windows)]
const NPM_DIR: &str = "node_modules/npm";

/// The script behind `npx`, inside [`NPM_DIR`]. Squire starts a server's
/// `npx` by running it with `node` directly, which works the same on every
/// platform; the [`SHIMS`] are for whatever that server runs in turn.
#[cfg(not(target_os = "android"))]
const NPX_CLI: &str = "bin/npx-cli.js";

/// nodejs.org's own `npm`/`npx` launchers, installed next to `node` so a
/// package that runs `npm` or `npx` itself finds these on PATH rather than
/// the person's: relative symlinks into [`NPM_DIR`] on macOS and Linux, and
/// `.cmd`/`.ps1`/shell wrappers on Windows.
#[cfg(all(unix, not(target_os = "android")))]
const SHIMS: &[&str] = &["bin/npm", "bin/npx"];
#[cfg(windows)]
const SHIMS: &[&str] = &["npm", "npm.cmd", "npm.ps1", "npx", "npx.cmd", "npx.ps1"];

/// The shim whose presence, with [`NPX_CLI`], marks npm as installed.
#[cfg(all(unix, not(target_os = "android")))]
const NPX_SHIM: &str = "bin/npx";
#[cfg(windows)]
const NPX_SHIM: &str = "npx.cmd";

/// How to start `npx` on Squire's Node.js: `program` followed by
/// `leading_args`, then the listing's own arguments. `bin_dir` goes first on
/// the server's PATH, so the packages npx installs, which start with
/// `#!/usr/bin/env node` (or `.cmd` wrappers on Windows), run on that same
/// Node.js rather than one the person installed.
pub struct Npx {
    pub program: PathBuf,
    pub leading_args: Vec<PathBuf>,
    pub bin_dir: PathBuf,
}

/// npm's download cache for Squire's npx, kept under `SQUIRE_HOME` so it is
/// removed with Squire's other runtimes. The person's `~/.npmrc` still
/// applies (registry, proxy, auth).
pub fn npm_cache(squire_home: &Path) -> PathBuf {
    squire_home.join("runtimes").join("npm-cache")
}

/// Serializes extraction within this process; the final rename makes it
/// atomic across processes.
#[cfg(not(target_os = "android"))]
static EXTRACTING: Mutex<()> = Mutex::new(());

#[cfg(not(target_os = "android"))]
fn version_dir(squire_home: &Path) -> PathBuf {
    squire_home.join("runtimes").join("node").join(VERSION)
}

/// Where the extracted `node` executable lives.
#[cfg(not(target_os = "android"))]
pub fn path(squire_home: &Path) -> PathBuf {
    version_dir(squire_home).join(EXECUTABLE)
}

/// Extracts the embedded runtime unless it is already in place, removes
/// runtimes left by earlier versions and returns the `node` executable.
/// Blocks for a few seconds on first use while the archive decompresses.
#[cfg(not(target_os = "android"))]
pub fn ensure(squire_home: &Path) -> Result<PathBuf> {
    let node = path(squire_home);
    if node.is_file() {
        return Ok(node);
    }
    let _extracting = EXTRACTING.lock().unwrap();
    if node.is_file() {
        return Ok(node);
    }
    let destination = version_dir(squire_home);
    let runtimes = destination
        .parent()
        .context("Node.js runtime directory has no parent")?;
    fs::create_dir_all(runtimes)
        .with_context(|| format!("failed to create {}", runtimes.display()))?;
    let staging = runtimes.join(format!(".{VERSION}-{}", uuid::Uuid::new_v4()));
    let extracted = extract(&staging, wanted).and_then(|()| {
        ensure!(
            staging.join(EXECUTABLE).is_file(),
            "the embedded Node.js archive has no {EXECUTABLE}"
        );
        // Another Squire process may have finished first.
        if node.is_file() {
            return Ok(());
        }
        fs::rename(&staging, &destination)
            .with_context(|| format!("failed to install {}", destination.display()))
    });
    let _ = fs::remove_dir_all(&staging);
    extracted?;
    remove_other_versions(runtimes);
    Ok(node)
}

/// Starts `npx` on the embedded Node.js, unpacking npm and its shims next to
/// `node` the first time. `ensure` returns as soon as `node` exists, so npm
/// has its own check: a runtime extracted before this existed has no npm yet.
/// Blocks for a few seconds on first use.
///
/// Safe with several Squire processes sharing `SQUIRE_HOME` without a lock:
/// each unpacks into its own staging directory, the shims are renamed into
/// place first (identical files, so a later rename over them is harmless),
/// and npm's directory is published last by one rename, which fails rather
/// than overwrite when another process published first. Nothing already
/// installed is ever removed, and an interrupted install leaves npm absent,
/// so the next start redoes it.
#[cfg(not(target_os = "android"))]
pub fn npx(squire_home: &Path) -> Result<Npx> {
    let node = ensure(squire_home)?;
    let version = version_dir(squire_home);
    let destination = version.join(NPM_DIR);
    let cli = destination.join(NPX_CLI);
    let installed = || cli.is_file() && present(&version.join(NPX_SHIM));
    let npx = Npx {
        program: node.clone(),
        leading_args: vec![cli.clone()],
        bin_dir: node
            .parent()
            .context("Node.js executable has no parent directory")?
            .to_path_buf(),
    };
    if installed() {
        return Ok(npx);
    }
    let _extracting = EXTRACTING.lock().unwrap();
    if installed() {
        return Ok(npx);
    }
    let runtimes = version
        .parent()
        .context("Node.js runtime directory has no parent")?
        .to_path_buf();
    let staging = runtimes.join(format!(".npm-{VERSION}-{}", uuid::Uuid::new_v4()));
    let npm_dir = Path::new(NPM_DIR);
    let wanted = |relative: &Path| {
        relative.starts_with(npm_dir) || SHIMS.iter().any(|shim| relative == Path::new(shim))
    };
    let extracted = extract(&staging, wanted).and_then(|()| {
        ensure!(
            staging.join(NPM_DIR).join(NPX_CLI).is_file() && present(&staging.join(NPX_SHIM)),
            "the embedded Node.js archive has no npx"
        );
        for shim in SHIMS {
            let unpacked = staging.join(shim);
            if !present(&unpacked) {
                continue;
            }
            let target = version.join(shim);
            fs::rename(&unpacked, &target)
                .with_context(|| format!("failed to install {}", target.display()))?;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        match fs::rename(staging.join(NPM_DIR), &destination) {
            Ok(()) => Ok(()),
            // Another Squire process published npm first.
            Err(_) if cli.is_file() => Ok(()),
            Err(error) => {
                Err(error).with_context(|| format!("failed to install {}", destination.display()))
            }
        }
    });
    let _ = fs::remove_dir_all(&staging);
    extracted?;
    Ok(npx)
}

/// Whether `path` exists, counting a symlink whose target is not in place yet:
/// the Unix shims point into npm's directory, which is published after them.
#[cfg(not(target_os = "android"))]
fn present(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// Termux's `npx`, which its `nodejs` package installs along with `node`.
#[cfg(target_os = "android")]
pub fn npx(squire_home: &Path) -> Result<Npx> {
    let bin_dir = path(squire_home)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| crate::util::termux_prefix().join("bin"));
    let program = bin_dir.join("npx");
    anyhow::ensure!(
        program.is_file(),
        "this integration needs npx, which Termux installs with `pkg install nodejs`"
    );
    Ok(Npx {
        program,
        leading_args: Vec::new(),
        bin_dir,
    })
}

/// Termux's `node`. It links against Termux's own libraries, so it cannot be
/// embedded the way the nodejs.org builds are.
#[cfg(target_os = "android")]
pub fn path(_squire_home: &Path) -> PathBuf {
    crate::util::termux_prefix().join("bin").join("node")
}

#[cfg(target_os = "android")]
pub fn ensure(squire_home: &Path) -> Result<PathBuf> {
    let node = path(squire_home);
    anyhow::ensure!(
        node.is_file(),
        "the browser tools need Node.js, which Termux installs with `pkg install nodejs`"
    );
    Ok(node)
}

/// What [`ensure`] unpacks: the executable and Node's `LICENSE`. npm is
/// unpacked separately by [`npx`], and headers are never used. `relative`
/// excludes the archive's top-level directory.
#[cfg(not(target_os = "android"))]
fn wanted(relative: &Path) -> bool {
    relative == Path::new(EXECUTABLE) || relative == Path::new("LICENSE")
}

/// Unpacks the archive entries `wanted` accepts into `staging`.
#[cfg(all(unix, not(target_os = "android")))]
fn extract(staging: &Path, wanted: impl Fn(&Path) -> bool) -> Result<()> {
    let mut archive = tar::Archive::new(liblzma::read::XzDecoder::new(ARCHIVE));
    for entry in archive
        .entries()
        .context("failed to read the embedded Node.js archive")?
    {
        let mut entry = entry.context("failed to read the embedded Node.js archive")?;
        let relative: PathBuf = entry.path()?.components().skip(1).collect();
        if !wanted(&relative) {
            continue;
        }
        let target = staging.join(&relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        entry
            .unpack(&target)
            .with_context(|| format!("failed to extract {}", relative.display()))?;
    }
    Ok(())
}

#[cfg(windows)]
fn extract(staging: &Path, wanted: impl Fn(&Path) -> bool) -> Result<()> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(ARCHIVE))
        .context("failed to read the embedded Node.js archive")?;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .context("failed to read the embedded Node.js archive")?;
        let Some(name) = file.enclosed_name() else {
            continue;
        };
        let relative: PathBuf = name.components().skip(1).collect();
        if !file.is_file() || !wanted(&relative) {
            continue;
        }
        let target = staging.join(&relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = fs::File::create(&target)
            .with_context(|| format!("failed to create {}", target.display()))?;
        std::io::copy(&mut file, &mut output)
            .with_context(|| format!("failed to extract {}", relative.display()))?;
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn remove_other_versions(runtimes: &Path) {
    let Ok(entries) = fs::read_dir(runtimes) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name != VERSION && name.to_string_lossy().starts_with('v') {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}
