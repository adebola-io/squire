//! Browser runtime assets under `SQUIRE_HOME/runtimes`.
//!
//! The host embeds the browser `driver.cjs` plus its kernel lock-helper
//! contract, the vendored `playwright-core` package and (through
//! `node_runtime`) Node.js for the core browser service. WASM Plugins reach it
//! only through the `browser` host import.

use anyhow::{Context, Result};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::SystemTime,
};

/// Size and mtime of each runtime file as last verified against the embedded
/// bytes. A matching stat skips the read-and-compare on every browser Action;
/// any write that changes size or mtime re-verifies. The map is per process
/// and the embedded bytes are fixed per build, so the only thing a stat
/// cannot see is an external edit that deliberately preserves both, which is
/// repaired on the next restart.
static VERIFIED: LazyLock<Mutex<HashMap<PathBuf, (u64, SystemTime)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn stat(path: &Path) -> Option<(u64, SystemTime)> {
    let metadata = std::fs::metadata(path).ok()?;
    Some((metadata.len(), metadata.modified().ok()?))
}

const BROWSER_DRIVER: &[u8] = include_bytes!("../assets/browser-driver.cjs");

const BROWSER_PACKAGE: &[u8] = include_bytes!("../assets/package.json");
/// The npm tarball of the `playwright-core` version that `package.json` pins.
const PLAYWRIGHT: &[u8] = include_bytes!("../assets/playwright-core.tgz");

/// Installs the driver and its package manifest. Node.js and Playwright are
/// installed lazily by the core browser service.
pub fn browser_driver_path(squire_home: &Path) -> Result<PathBuf> {
    let directory = squire_home.join("runtimes").join("browser");
    for (name, bytes) in [
        ("driver.cjs", BROWSER_DRIVER),
        (
            "browser-private.cjs",
            include_bytes!("../assets/browser-private.cjs").as_slice(),
        ),
        (
            "browser-launch.cjs",
            include_bytes!("../assets/browser-launch.cjs").as_slice(),
        ),
        (
            "browser-tabs.cjs",
            include_bytes!("../assets/browser-tabs.cjs").as_slice(),
        ),
        (
            "browser-shared.cjs",
            include_bytes!("../assets/browser-shared.cjs").as_slice(),
        ),
        (
            "browser-window.cjs",
            include_bytes!("../assets/browser-window.cjs").as_slice(),
        ),
        (
            "browser-platform.cjs",
            include_bytes!("../assets/browser-platform.cjs").as_slice(),
        ),
        (
            "browser-storage.cjs",
            include_bytes!("../assets/browser-storage.cjs").as_slice(),
        ),
        (
            "browser-viewer.cjs",
            include_bytes!("../assets/browser-viewer.cjs").as_slice(),
        ),
        (
            "browser-sign-in.cjs",
            include_bytes!("../assets/browser-sign-in.cjs").as_slice(),
        ),
        (
            "squire-mark.svg",
            include_bytes!("../assets/squire-mark.svg").as_slice(),
        ),
        (
            "geist-sans.woff2",
            include_bytes!("../../packages/ui/src/assets/fonts/geist-sans/GeistSans-Variable.woff2")
                .as_slice(),
        ),
        (
            "source-serif-4.woff2",
            include_bytes!("../../packages/ui/src/assets/fonts/source-serif-4/source-serif-4-normal-latin.woff2")
                .as_slice(),
        ),
        ("package.json", BROWSER_PACKAGE),
    ] {
        let destination = directory.join(name);
        let current = stat(&destination);
        if current.is_some() && VERIFIED.lock().unwrap().get(&destination) == current.as_ref() {
            continue;
        }
        if std::fs::read(&destination).ok().as_deref() != Some(bytes) {
            atomic_write(&destination, bytes)?;
        }
        match stat(&destination) {
            Some(verified) => {
                VERIFIED.lock().unwrap().insert(destination, verified);
            }
            None => {
                VERIFIED.lock().unwrap().remove(&destination);
            }
        }
    }
    Ok(directory.join("driver.cjs"))
}

fn browser_runtime_dir(squire_home: &Path) -> PathBuf {
    squire_home.join("runtimes").join("browser")
}

fn expected_playwright_version() -> Option<String> {
    serde_json::from_slice::<serde_json::Value>(BROWSER_PACKAGE)
        .ok()?
        .get("dependencies")?
        .get("playwright-core")?
        .as_str()
        .map(str::to_string)
}

fn package_version(package: &Path) -> Option<String> {
    serde_json::from_slice::<serde_json::Value>(&std::fs::read(package.join("package.json")).ok()?)
        .ok()?
        .get("version")?
        .as_str()
        .map(str::to_string)
}

fn playwright_dir(squire_home: &Path) -> PathBuf {
    browser_runtime_dir(squire_home)
        .join("node_modules")
        .join("playwright-core")
}

/// Fast readiness check used before spawning the supervisor.
pub fn browser_runtime_ready(squire_home: &Path) -> bool {
    crate::node_runtime::path(squire_home).is_file()
        && expected_playwright_version().is_some_and(|expected| {
            package_version(&playwright_dir(squire_home)).as_deref() == Some(expected.as_str())
        })
}

/// Installs the embedded Node.js runtime and the vendored playwright-core.
/// Blocking: the browser core runs it off the async runtime and coalesces
/// concurrent callers before entering this function.
pub fn install_browser_runtime(squire_home: &Path) -> Result<()> {
    browser_driver_path(squire_home)?;
    crate::node_runtime::ensure(squire_home)?;
    let destination = playwright_dir(squire_home);
    let modules = destination
        .parent()
        .context("Playwright directory has no parent")?;
    std::fs::create_dir_all(modules)
        .with_context(|| format!("failed to create {}", modules.display()))?;
    let staging = modules.join(format!(".{}", uuid::Uuid::new_v4()));
    let installed = install_playwright(&staging, &destination);
    let _ = std::fs::remove_dir_all(&staging);
    installed
}

const CHROMIUM_REVISION: &str = "1234";

/// Playwright 1.62.0's Chromium revision 1234. Digests pin the archive bytes,
/// not a mutable download endpoint. See Playwright's bundled browsers.json.
struct ChromiumArtifact {
    url: &'static str,
    sha256: &'static str,
    executable: &'static str,
}

fn chromium_artifact() -> Result<ChromiumArtifact> {
    let artifact = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => ChromiumArtifact {
            url: "https://cdn.playwright.dev/builds/cft/151.0.7922.34/linux64/chrome-linux64.zip",
            sha256: "ae8736ac28bc69278551500f219fc749575648263c43ec5990749eff43b9fcf8",
            executable: "chrome-linux64/chrome",
        },
        ("macos", "aarch64") => ChromiumArtifact {
            url: "https://cdn.playwright.dev/builds/cft/151.0.7922.34/mac-arm64/chrome-mac-arm64.zip",
            sha256: "01a23ef9501b2745e0c2944c2e583207e6f6132d8d91c3a87ff65b5079e438ef",
            executable: "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        },
        ("macos", "x86_64") => ChromiumArtifact {
            url: "https://cdn.playwright.dev/builds/cft/151.0.7922.34/mac-x64/chrome-mac-x64.zip",
            sha256: "69bcc853db975a2380767e9ff36da17f1d7b782fbbe191a210f676d2d5967d3e",
            executable: "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        },
        ("windows", "x86_64") => ChromiumArtifact {
            url: "https://cdn.playwright.dev/builds/cft/151.0.7922.34/win64/chrome-win64.zip",
            sha256: "045621e45a9dd27002c7fc1d8e10fe9f5f71f4cadbf44ec6f397f56f0179725c",
            executable: "chrome-win64/chrome.exe",
        },
        _ => anyhow::bail!("Managed Chromium is not available for this operating system and architecture"),
    };
    Ok(artifact)
}

/// Returns the managed browser path, whether or not it is installed yet.
/// The supervisor receives this exact executable rather than its own platform table.
pub fn managed_chromium_executable(squire_home: &Path) -> Option<PathBuf> {
    let artifact = chromium_artifact().ok()?;
    Some(
        browser_runtime_dir(squire_home)
            .join(format!("chromium-{CHROMIUM_REVISION}"))
            .join(artifact.executable),
    )
}

/// Downloads and verifies one pinned Chromium archive, then publishes a fully
/// extracted directory with a single rename. The caller serializes installs.
pub async fn install_managed_chromium(squire_home: &Path) -> Result<()> {
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;

    let artifact = chromium_artifact()?;
    let runtime = browser_runtime_dir(squire_home);
    std::fs::create_dir_all(&runtime)?;
    let destination = runtime.join(format!("chromium-{CHROMIUM_REVISION}"));
    if destination.join(artifact.executable).is_file() {
        return Ok(());
    }
    let staging = tempfile::Builder::new()
        .prefix(".chromium-")
        .tempdir_in(&runtime)?;
    let archive = staging.path().join("browser.zip");
    let mut response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(900))
        .build()?
        .get(artifact.url)
        .send()
        .await
        .context("Chromium download failed")?
        .error_for_status()
        .context("Chromium download failed")?;
    let mut file = tokio::fs::File::create(&archive).await?;
    let mut hash = Sha256::new();
    let mut size = 0_u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .context("Chromium download interrupted")?
    {
        size = size.saturating_add(chunk.len() as u64);
        anyhow::ensure!(
            size <= 1024 * 1024 * 1024,
            "Chromium archive exceeds the size limit"
        );
        hash.update(&chunk);
        file.write_all(&chunk).await?;
    }
    file.sync_all().await?;
    drop(file);
    anyhow::ensure!(
        format!("{:x}", hash.finalize()) == artifact.sha256,
        "Chromium archive checksum mismatch"
    );

    let executable = artifact.executable;
    tokio::task::spawn_blocking(move || -> Result<()> {
        let extracted = staging.path().join("extracted");
        std::fs::create_dir(&extracted)?;
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&archive)?)?;
        // The pinned archive is trusted, but still cap expansion to avoid disk exhaustion.
        let expanded = (0..zip.len()).try_fold(0_u64, |total, index| -> Result<u64> {
            Ok(total.saturating_add(zip.by_index(index)?.size()))
        })?;
        anyhow::ensure!(
            expanded <= 3 * 1024 * 1024 * 1024,
            "Chromium archive expands beyond the size limit"
        );
        // macOS Chrome for Testing has framework symlinks. zip::extract
        // materializes those as regular files, breaking its app bundle.
        #[cfg(target_os = "macos")]
        {
            let output = std::process::Command::new("/usr/bin/ditto")
                .args(["-x", "-k"])
                .arg(&archive)
                .arg(&extracted)
                .output()
                .context("failed to launch macOS Chromium extractor")?;
            anyhow::ensure!(
                output.status.success(),
                "failed to extract Chromium: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        #[cfg(not(target_os = "macos"))]
        zip.extract(&extracted)
            .context("failed to extract Chromium")?;
        anyhow::ensure!(
            extracted.join(executable).is_file(),
            "Chromium archive is missing its executable"
        );
        if destination.exists() {
            std::fs::remove_dir_all(&destination)?;
        }
        std::fs::rename(extracted, destination).context("failed to publish Chromium")?;
        Ok(())
    })
    .await
    .context("Chromium installer stopped")??;
    Ok(())
}

fn install_playwright(staging: &Path, destination: &Path) -> Result<()> {
    tar::Archive::new(flate2::read::GzDecoder::new(PLAYWRIGHT))
        .unpack(staging)
        .context("failed to extract the vendored playwright-core")?;
    // npm tarballs root every file at `package/`.
    let package = staging.join("package");
    let expected =
        expected_playwright_version().context("embedded browser package version is missing")?;
    anyhow::ensure!(
        package_version(&package).as_deref() == Some(expected.as_str()),
        "vendored playwright-core does not match the pinned version {expected}"
    );
    if destination.exists() {
        std::fs::remove_dir_all(destination)
            .with_context(|| format!("failed to replace {}", destination.display()))?;
    }
    std::fs::rename(&package, destination)
        .with_context(|| format!("failed to install {}", destination.display()))
}

/// Absolute path of the kernel lock helper implementing
/// `<helper> --internal-lock <file>`. The server binary itself serves this
/// contract (see `run_internal_lock`); the driver spawns it via
/// `SQUIRE_BROWSER_LOCK_HELPER`.
pub fn lock_helper_path() -> Result<PathBuf> {
    std::env::current_exe().context("failed to resolve the lock helper path")
}

pub(crate) fn atomic_write(destination: &Path, bytes: &[u8]) -> Result<()> {
    let parent = destination
        .parent()
        .context("runtime destination has no parent")?;
    std::fs::create_dir_all(parent)
        .with_context(|| format!("failed to create {}", parent.display()))?;
    let tmp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, bytes).with_context(|| format!("failed to write {}", tmp.display()))?;
    #[cfg(windows)]
    if destination.exists() {
        std::fs::remove_file(destination)
            .with_context(|| format!("failed to remove {}", destination.display()))?;
    }
    std::fs::rename(&tmp, destination).with_context(|| {
        let _ = std::fs::remove_file(&tmp);
        format!(
            "failed to replace {} with {}",
            destination.display(),
            tmp.display()
        )
    })?;
    Ok(())
}
