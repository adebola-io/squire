use sha2::{Digest, Sha256};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

/// Node.js embedded for the browser runtime: official nodejs.org builds,
/// pinned by the SHA-256 values in that release's SHASUMS256.txt. Each entry
/// is (Rust target, Node platform, archive extension, SHA-256).
const NODE_VERSION: &str = "v24.22.2";
const NODE_ARCHIVES: &[(&str, &str, &str, &str)] = &[
    (
        "aarch64-apple-darwin",
        "darwin-arm64",
        "tar.xz",
        "1f5ac075be50bed4780ea3be19a007fda95ea4d527d28d76d0b91de47d915115",
    ),
    (
        "x86_64-apple-darwin",
        "darwin-x64",
        "tar.xz",
        "6965578fd823e72c1b5387f5ab84cb25368f886e02eb8779e6f0fce6b91c27b7",
    ),
    (
        "aarch64-unknown-linux-gnu",
        "linux-arm64",
        "tar.xz",
        "eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8",
    ),
    (
        "x86_64-unknown-linux-gnu",
        "linux-x64",
        "tar.xz",
        "48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75",
    ),
    (
        "x86_64-pc-windows-msvc",
        "win-x64",
        "zip",
        "ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2",
    ),
    (
        "aarch64-pc-windows-msvc",
        "win-arm64",
        "zip",
        "f47968c213105077f64c6510f007632c0ca2574802a0b5067c327c49abe1c468",
    ),
];

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    ensure_web_dist();
    embed_node();
}

fn ensure_web_dist() {
    // rust-embed fails the build when its folder is missing, and `dist/` is
    // gitignored. Guarantee the directory exists so a bare `cargo build`
    // without a prior `pnpm run build-web` still compiles (with a placeholder).
    // Release builds always run `pnpm run build-web` first, overwriting this.
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be set");
    let dist = Path::new(&manifest_dir).join("../packages/web/dist");
    if !dist.join("index.html").exists() {
        fs::create_dir_all(&dist).ok();
        fs::write(
            dist.join("index.html"),
            "<!-- squire web build missing: run `pnpm run build-web` before release builds -->\n",
        )
        .ok();
        println!("cargo:warning=packages/web/dist/index.html missing; wrote placeholder. Run `pnpm run build-web` for the real UI.");
    }
    println!("cargo:rerun-if-changed=../packages/web/dist/index.html");
}

/// Downloads the pinned Node.js archive for the target once into OUT_DIR and
/// hands its path to `node_runtime.rs`, which embeds it.
fn embed_node() {
    // nodejs.org publishes no Android build; there `node_runtime.rs` uses
    // Termux's own Node.js instead.
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        return;
    }
    let target = env::var("TARGET").expect("TARGET must be set");
    let (_, platform, extension, sha256) = NODE_ARCHIVES
        .iter()
        .find(|(triple, ..)| *triple == target)
        .unwrap_or_else(|| panic!("no embedded Node.js build is pinned for target {target}"));
    let name = format!("node-{NODE_VERSION}-{platform}.{extension}");
    let archive = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR must be set")).join(&name);
    if !archive.is_file() || digest(&archive) != *sha256 {
        let url = format!("https://nodejs.org/dist/{NODE_VERSION}/{name}");
        let status = Command::new("curl")
            .args(["--fail", "--location", "--silent", "--show-error"])
            .args(["--retry", "3", "--output"])
            .arg(&archive)
            .arg(&url)
            .status()
            .unwrap_or_else(|error| panic!("could not run curl to download {url}: {error}"));
        assert!(status.success(), "could not download {url}");
        assert_eq!(
            digest(&archive),
            *sha256,
            "{name} failed SHA-256 verification"
        );
    }
    println!("cargo:rustc-env=SQUIRE_NODE_VERSION={NODE_VERSION}");
    println!("cargo:rustc-env=SQUIRE_NODE_ARCHIVE={}", archive.display());
}

fn digest(path: &Path) -> String {
    let bytes = fs::read(path).expect("failed to read the Node.js archive");
    format!("{:x}", Sha256::digest(bytes))
}
