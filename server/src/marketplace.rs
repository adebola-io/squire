//! Verified marketplace catalog and WASM installation. Installed plugins remain in the local index.
use crate::{
    marketplace_operations::OperationContext,
    plugins::{self, IndexedRuntime, ManifestRuntime, McpConfig, PluginManifest},
    state::AppState,
    util,
};
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::io::AsyncWriteExt;

const CATALOG_PATH: &str = "/api/marketplace";
pub(crate) const MAX_CATALOG_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_WASM_ZIP_BYTES: u64 = 25 * 1024 * 1024;
pub(crate) const MAX_ICON_BYTES: usize = 1_000_000;
pub(crate) const MAX_OVERVIEW_BYTES: usize = 64 * 1024;
pub(crate) const ICON_EXTENSIONS: [&str; 5] = ["svg", "png", "jpg", "jpeg", "webp"];
/// A listing names one primary category and at most two more that the
/// audience of those categories would go looking for.
pub(crate) const MAX_ENTRY_CATEGORIES: usize = 3;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Catalog {
    pub groups: Vec<CategoryGroup>,
    pub entries: Vec<Entry>,
}

/// A top-level Discover filter. Listings name its categories, never the group.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CategoryGroup {
    pub id: String,
    pub name: String,
    pub categories: Vec<Category>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Category {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub manifest: PluginManifest,
    pub categories: Vec<String>,
    pub icons: Icons,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact: Option<Artifact>,
    /// Known install locations of a local MCP command, keyed by
    /// `{os}-{arch}` (Rust's `std::env::consts` names). The first that exists
    /// replaces the command; `~/` is the user's home directory.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub executables: BTreeMap<String, Vec<String>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IconAsset {
    pub sha256: String,
    pub ext: String,
}

impl IconAsset {
    /// The content-addressed key under which the asset is published.
    pub fn key(&self) -> String {
        format!("marketplace/icons/{}.{}", self.sha256, self.ext)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Icons {
    pub primary: IconAsset,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub light: Option<IconAsset>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dark: Option<IconAsset>,
}

impl Icons {
    pub fn all(&self) -> impl Iterator<Item = &IconAsset> {
        std::iter::once(&self.primary)
            .chain(self.light.iter())
            .chain(self.dark.iter())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub sha256: String,
}

impl Entry {
    /// The content-addressed key of a WASM listing's package.
    pub fn artifact_key(&self) -> Option<String> {
        let artifact = self.artifact.as_ref()?;
        let version = self.manifest.version.as_deref()?;
        Some(format!(
            "marketplace/{}/{version}/{}.zip",
            self.manifest.id, artifact.sha256
        ))
    }
}

/// Lowercase hex SHA-256, the only digest spelling the catalog accepts.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn is_sha256(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// The one loopback rule: a plain-HTTP MCP endpoint on literal `127.0.0.1`.
pub(crate) fn is_loopback(url: &url::Url) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1")
}

/// How a newer published version is applied. A patch release inside the same
/// major and minor is a fix and installs itself; a higher minor or major is a
/// behaviour change and waits for the user.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateKind {
    Auto,
    Approval,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub kind: UpdateKind,
    pub version: String,
}

/// Catalog validation admits only plain `MAJOR.MINOR.PATCH` WASM versions, so
/// an installed managed copy and its listing always compare.
fn version_update(installed: Option<&str>, published: Option<&str>) -> Option<UpdateInfo> {
    let installed = semver::Version::parse(installed?).ok()?;
    let published_text = published?;
    let published = semver::Version::parse(published_text).ok()?;
    // Equal or older published versions are never applied: rollbacks are not
    // an update, and the installed copy stays authoritative.
    (published > installed).then(|| UpdateInfo {
        kind: if published.major == installed.major && published.minor == installed.minor {
            UpdateKind::Auto
        } else {
            UpdateKind::Approval
        },
        version: published_text.to_owned(),
    })
}

/// The verified catalog, plus the validator the Worker issued with it.
pub struct CatalogState {
    pub catalog: Option<Arc<Catalog>>,
    pub etag: Option<String>,
    pub error: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopRuntime {
    Wasm,
    Mcp,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Installation {
    NotInstalled,
    Managed,
    Unmanaged,
}

/// The desktop receives a prepared listing: local installation state and a
/// local asset route, never a Worker origin or remote install instructions.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSnapshot {
    pub catalog: Option<DesktopCatalog>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'static str>,
}

#[derive(Serialize)]
pub struct DesktopCatalog {
    pub groups: Vec<CategoryGroup>,
    pub entries: Vec<DesktopEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopManifest {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: Option<String>,
    pub runtime: DesktopRuntime,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_transport: Option<&'static str>,
    pub theme_color: String,
    pub secrets: Vec<plugins::PluginSecretManifest>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopEntry {
    pub manifest: DesktopManifest,
    pub categories: Vec<String>,
    pub overview: Option<String>,
    pub release_notes: Option<String>,
    pub published_at: Option<String>,
    pub installation: Installation,
    /// Present when the installed copy is older than the published one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update: Option<UpdateInfo>,
    pub icon_url: String,
    pub artifact_sha256: Option<String>,
}

/// A listing is managed when this exact installation came from the marketplace
/// under the same ID and runtime.
fn managed_listing(plugin: &plugins::IndexedPlugin, listing: &Entry) -> bool {
    plugin
        .marketplace
        .as_ref()
        .is_some_and(|origin| origin.integration_id == listing.manifest.id)
        && matches!(
            (&plugin.runtime, &listing.manifest.runtime),
            (IndexedRuntime::Wasm, ManifestRuntime::Wasm { .. })
                | (IndexedRuntime::Mcp(_), ManifestRuntime::Mcp { .. })
        )
}

/// The pending update for a listing. Only marketplace-managed WASM installs
/// have an in-place update path: a package imported by hand is the owner's, not
/// the marketplace's, so no update is reported for it.
fn installed_update(plugin: &plugins::IndexedPlugin, listing: &Entry) -> Option<UpdateInfo> {
    if !managed_listing(plugin, listing) || !matches!(plugin.runtime, IndexedRuntime::Wasm) {
        return None;
    }
    version_update(
        plugin.version.as_deref(),
        listing.manifest.version.as_deref(),
    )
}

fn mcp_transport(runtime: &ManifestRuntime) -> Option<&'static str> {
    match runtime {
        ManifestRuntime::Wasm { .. } => None,
        ManifestRuntime::Mcp {
            mcp: McpConfig::Stdio { .. },
        } => Some("stdio"),
        ManifestRuntime::Mcp {
            mcp: McpConfig::StreamableHttp { url, .. },
        } => Some(if url::Url::parse(url).is_ok_and(|url| is_loopback(&url)) {
            "loopback_http"
        } else {
            "streamable_http"
        }),
    }
}

fn desktop_entry(listing: &Entry, index: &plugins::PluginIndex) -> DesktopEntry {
    let manifest = &listing.manifest;
    let id = &manifest.id;
    let installed = index.plugins.iter().find(|plugin| plugin.id == *id);
    DesktopEntry {
        artifact_sha256: listing
            .artifact
            .as_ref()
            .map(|artifact| artifact.sha256.clone()),
        icon_url: format!("/desktop/plugins/marketplace/icons/{id}"),
        installation: match installed {
            None => Installation::NotInstalled,
            Some(plugin) if managed_listing(plugin, listing) => Installation::Managed,
            Some(_) => Installation::Unmanaged,
        },
        update: installed.and_then(|plugin| installed_update(plugin, listing)),
        categories: listing.categories.clone(),
        overview: listing.overview.clone(),
        release_notes: listing.release_notes.clone(),
        published_at: listing.published_at.clone(),
        manifest: DesktopManifest {
            id: id.clone(),
            name: manifest.name.clone(),
            description: manifest.description.clone(),
            version: manifest.version.clone(),
            runtime: match manifest.runtime {
                ManifestRuntime::Wasm { .. } => DesktopRuntime::Wasm,
                ManifestRuntime::Mcp { .. } => DesktopRuntime::Mcp,
            },
            mcp_transport: mcp_transport(&manifest.runtime),
            theme_color: manifest.theme_color.clone(),
            secrets: manifest.secrets.clone(),
        },
    }
}

pub fn desktop_snapshot(state: &AppState) -> Result<DesktopSnapshot> {
    let installed = plugins::catalog(state)?;
    let cached = state
        .marketplace_catalog
        .read()
        .expect("marketplace catalog");
    Ok(DesktopSnapshot {
        catalog: cached.catalog.as_deref().map(|catalog| DesktopCatalog {
            groups: catalog.groups.clone(),
            entries: catalog
                .entries
                .iter()
                .map(|listing| desktop_entry(listing, &installed.index))
                .collect(),
        }),
        error: cached
            .error
            .then_some("Marketplace unavailable. Try again."),
    })
}

/// The browser requests assets from Rust only. IDs/extensions are sourced from
/// the already-validated catalog, not the path or a user-supplied remote URL.
pub async fn icon(
    state: &AppState,
    id: &str,
    scheme: Option<plugins::IconScheme>,
) -> Result<(&'static str, Vec<u8>)> {
    let catalog = cached(state).context("No marketplace catalog available")?;
    let listing = catalog
        .entries
        .iter()
        .find(|entry| entry.manifest.id == id)
        .context("Marketplace icon not found")?;
    let asset = match scheme {
        Some(plugins::IconScheme::Light) => listing.icons.light.as_ref(),
        Some(plugins::IconScheme::Dark) => listing.icons.dark.as_ref(),
        None => None,
    }
    .unwrap_or(&listing.icons.primary);
    fetch_icon_asset(state, asset).await
}

pub(crate) fn icon_mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => return None,
    })
}

/// Resolve immutable icon bytes from the exact catalog entry under review.
async fn fetch_icon_asset(state: &AppState, asset: &IconAsset) -> Result<(&'static str, Vec<u8>)> {
    let mime = icon_mime(&asset.ext).context("Unsupported marketplace icon")?;
    let filename = format!("{}.{}", asset.sha256, asset.ext);
    let directory = state
        .config
        .storage
        .squire_home
        .join("cache/marketplace-icons");
    let path = directory.join(&filename);
    if let Ok(bytes) = tokio::fs::read(&path).await {
        if sha256_hex(&bytes) == asset.sha256 {
            return Ok((mime, bytes));
        }
    }
    let url = state.account.endpoint(&format!("/{}", asset.key()))?;
    let response = state
        .marketplace_client
        .get(url)
        .timeout(Duration::from_secs(10))
        .send()
        .await?
        .error_for_status()?;
    let bytes = limited_bytes(response, MAX_ICON_BYTES, "Icon too large").await?;
    ensure!(
        !bytes.is_empty() && sha256_hex(&bytes) == asset.sha256,
        "Marketplace icon failed integrity verification"
    );
    let cached = bytes.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        fs::create_dir_all(&directory)?;
        let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
        std::io::Write::write_all(&mut temporary, &cached)?;
        // Another request may have installed the identical immutable asset first.
        if let Err(error) = temporary.persist(&path) {
            if !fs::read(&path).is_ok_and(|data| data == cached) {
                return Err(error.into());
            }
        }
        Ok(())
    })
    .await??;
    Ok((mime, bytes))
}

fn cache_path(home: &Path) -> PathBuf {
    home.join("cache").join("marketplace.json")
}

/// Curated catalogs are validated as one release, not partially accepted.
pub(crate) fn parse(bytes: &[u8]) -> Result<Catalog> {
    ensure!(
        bytes.len() <= MAX_CATALOG_BYTES,
        "marketplace catalog exceeds size limit"
    );
    let catalog: Catalog = serde_json::from_slice(bytes)?;
    validate(&catalog)?;
    Ok(catalog)
}

pub(crate) fn validate(catalog: &Catalog) -> Result<()> {
    ensure!(
        !catalog.groups.is_empty(),
        "marketplace has no category groups"
    );
    // Group and category IDs share one namespace, so a listing can never name
    // a group where a category is expected.
    let mut ids: HashSet<&str> = HashSet::new();
    let mut categories: HashSet<String> = HashSet::new();
    for group in &catalog.groups {
        ensure!(
            !group.id.is_empty()
                && !group.name.trim().is_empty()
                && !group.categories.is_empty()
                && ids.insert(group.id.as_str()),
            "invalid, empty or duplicate marketplace group `{}`",
            group.id
        );
        for category in &group.categories {
            ensure!(
                !category.id.is_empty()
                    && !category.name.trim().is_empty()
                    && ids.insert(category.id.as_str()),
                "invalid or duplicate marketplace category `{}`",
                category.id
            );
            categories.insert(category.id.clone());
        }
    }
    let mut integrations = HashSet::new();
    for entry in &catalog.entries {
        validate_entry(entry, &categories)?;
        ensure!(
            integrations.insert(&entry.manifest.id),
            "duplicate marketplace integration `{}`",
            entry.manifest.id
        );
    }
    Ok(())
}

fn validate_entry(entry: &Entry, categories: &HashSet<String>) -> Result<()> {
    let manifest = plugins::validate_manifest(entry.manifest.clone())?;
    let id = &manifest.id;
    ensure!(
        (1..=MAX_ENTRY_CATEGORIES).contains(&entry.categories.len())
            && entry
                .categories
                .iter()
                .all(|category| categories.contains(category))
            && entry.categories.iter().collect::<HashSet<_>>().len() == entry.categories.len(),
        "{id}: list 1 to {MAX_ENTRY_CATEGORIES} distinct categories from marketplace/categories.toml"
    );
    let valid_asset = |asset: &IconAsset| {
        ICON_EXTENSIONS.contains(&asset.ext.as_str()) && is_sha256(&asset.sha256)
    };
    ensure!(
        valid_asset(&entry.icons.primary),
        "{id}: invalid primary icon"
    );
    ensure!(
        entry.icons.light.is_some() == entry.icons.dark.is_some(),
        "{id}: partial theme icon set"
    );
    for variant in [&entry.icons.light, &entry.icons.dark]
        .into_iter()
        .flatten()
    {
        ensure!(
            variant.ext == "svg" && valid_asset(variant),
            "{id}: invalid theme icon"
        );
    }
    if let Some(date) = &entry.published_at {
        let parsed = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")?;
        ensure!(
            parsed.format("%Y-%m-%d").to_string() == *date,
            "{id}: invalid publication date"
        );
    }
    ensure!(
        entry
            .release_notes
            .as_ref()
            .is_none_or(|notes| !notes.trim().is_empty()),
        "{id}: empty release notes"
    );
    ensure!(
        entry
            .overview
            .as_ref()
            .is_some_and(|text| !text.trim().is_empty() && text.len() <= MAX_OVERVIEW_BYTES),
        "{id}: missing or invalid README overview"
    );
    ensure!(
        entry.executables.is_empty()
            || matches!(
                manifest.runtime,
                ManifestRuntime::Mcp {
                    mcp: McpConfig::Stdio { .. }
                }
            ),
        "{id}: executables apply only to local stdio MCP listings"
    );
    for (platform, paths) in &entry.executables {
        ensure!(
            platform.split_once('-').is_some_and(|(os, arch)| {
                [os, arch].iter().all(|part| {
                    !part.is_empty()
                        && part
                            .bytes()
                            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
                })
            }),
            "{id}: executables keys must be `{{os}}-{{arch}}`, not `{platform}`"
        );
        // Validated wherever the catalog is, so a Windows path is recognized
        // by its drive (`C:\` or `C:/`) rather than by the host's rules.
        let absolute = |path: &str| {
            let bytes = path.as_bytes();
            path.starts_with('/')
                || path.starts_with("~/")
                || (bytes.len() > 2
                    && bytes[0].is_ascii_alphabetic()
                    && bytes[1] == b':'
                    && matches!(bytes[2], b'\\' | b'/'))
        };
        ensure!(
            !paths.is_empty() && paths.iter().all(|path| absolute(path)),
            "{id}: executables for `{platform}` must be absolute or `~/` paths"
        );
    }
    match &manifest.runtime {
        ManifestRuntime::Wasm { .. } => {
            let version = manifest
                .version
                .as_deref()
                .context("missing WASM version")?;
            ensure!(
                semver::Version::parse(version)
                    .is_ok_and(|version| version.pre.is_empty() && version.build.is_empty()),
                "{id}: WASM versions must be plain MAJOR.MINOR.PATCH, not `{version}`"
            );
            let artifact = entry.artifact.as_ref().context("missing WASM artifact")?;
            ensure!(is_sha256(&artifact.sha256), "{id}: invalid SHA-256");
        }
        ManifestRuntime::Mcp {
            mcp: McpConfig::StreamableHttp { url, .. },
        } => {
            ensure!(entry.artifact.is_none(), "{id}: unexpected ZIP");
            let parsed = url::Url::parse(url)?;
            ensure!(
                (parsed.scheme() == "https" && parsed.host_str().is_some() || is_loopback(&parsed))
                    && parsed.username().is_empty()
                    && parsed.password().is_none(),
                "{id}: invalid remote or loopback MCP endpoint"
            );
        }
        ManifestRuntime::Mcp {
            mcp: McpConfig::Stdio { .. },
        } => {
            ensure!(entry.artifact.is_none(), "{id}: unexpected ZIP");
        }
    }
    Ok(())
}

/// Read and revalidate a saved catalog; never expose corrupt or obsolete cache data.
pub fn load_cached(home: &Path) -> Option<Catalog> {
    let bytes = fs::read(cache_path(home)).ok()?;
    match parse(&bytes) {
        Ok(catalog) => Some(catalog),
        Err(error) => {
            tracing::warn!(%error, "Ignoring invalid marketplace cache");
            None
        }
    }
}

/// The validated catalog, shared rather than copied.
pub fn cached(state: &AppState) -> Option<Arc<Catalog>> {
    state
        .marketplace_catalog
        .read()
        .expect("marketplace catalog")
        .catalog
        .clone()
}

/// One refresh attempt, with the previous verified cache preserved on any failure.
pub async fn refresh(state: &AppState) {
    match fetch_and_cache(state).await {
        Ok(catalog) => queue_auto_updates(state, &catalog),
        Err(error) => {
            tracing::warn!(%error, "Marketplace refresh failed");
            state
                .marketplace_catalog
                .write()
                .expect("marketplace catalog")
                .error = true;
        }
    }
}

/// Patch releases install themselves once a verified catalog arrives. A higher
/// minor waits for approval, so it is deliberately not queued here.
fn queue_auto_updates(state: &AppState, catalog: &Catalog) {
    let installed = match plugins::catalog(state) {
        Ok(installed) => installed,
        Err(error) => {
            tracing::warn!(%error, "Skipping automatic marketplace updates");
            return;
        }
    };
    for entry in &catalog.entries {
        let Some(UpdateInfo {
            kind: UpdateKind::Auto,
            version,
        }) = installed
            .index
            .plugins
            .iter()
            .find(|plugin| plugin.id == entry.manifest.id)
            .and_then(|plugin| installed_update(plugin, entry))
        else {
            continue;
        };
        let intent = WasmInstallIntent {
            entry: entry.clone(),
            update: Some(UpdateKind::Auto),
        };
        let queued = state.clone();
        let result = state
            .marketplace_operations
            .enqueue(entry.manifest.id.clone(), move |context| {
                change_wasm(queued, intent, context)
            });
        match result {
            Ok(_) => tracing::info!(
                integration = %entry.manifest.id,
                %version,
                "Queued automatic marketplace update"
            ),
            Err(error) => tracing::warn!(
                %error,
                integration = %entry.manifest.id,
                "Could not queue automatic marketplace update"
            ),
        }
    }
}

/// Enforce the response limit even when Content-Length is missing or inaccurate.
async fn limited_bytes(
    mut response: reqwest::Response,
    limit: usize,
    error: &str,
) -> Result<Vec<u8>> {
    ensure!(
        response.content_length().is_none_or(|n| n <= limit as u64),
        "{error}"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(bytes.len() + chunk.len() <= limit, "{error}");
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Only successful, verified network fetches authorize marketplace mutations.
/// A conditional request keeps repeated checks cheap: an unchanged release
/// answers 304 and the verified copy already in memory is reused.
async fn fetch_and_cache(state: &AppState) -> Result<Arc<Catalog>> {
    let url = state.account.endpoint(CATALOG_PATH)?;
    let (current, etag) = {
        let cached = state
            .marketplace_catalog
            .read()
            .expect("marketplace catalog");
        (cached.catalog.clone(), cached.etag.clone())
    };
    let mut request = state
        .marketplace_client
        .get(url)
        .timeout(Duration::from_secs(10));
    if let (Some(_), Some(etag)) = (&current, &etag) {
        request = request.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let response = request
        .send()
        .await
        .context("Could not reach the marketplace catalog")?
        .error_for_status()
        .context("Marketplace catalog request failed")?;
    if response.status() == reqwest::StatusCode::NOT_MODIFIED {
        let catalog = current.context("Marketplace answered 304 without a cached catalog")?;
        state
            .marketplace_catalog
            .write()
            .expect("marketplace catalog")
            .error = false;
        return Ok(catalog);
    }
    ensure!(
        response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("application/json")),
        "marketplace endpoint returned non-JSON content"
    );
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let bytes = limited_bytes(
        response,
        MAX_CATALOG_BYTES,
        "marketplace catalog exceeds size limit",
    )
    .await?;
    let catalog = Arc::new(parse(&bytes)?);
    util::write_json(cache_path(&state.config.storage.squire_home), &*catalog)
        .context("saving marketplace cache")?;
    let mut cached = state
        .marketplace_catalog
        .write()
        .expect("marketplace catalog");
    cached.catalog = Some(catalog.clone());
    cached.etag = etag;
    cached.error = false;
    Ok(catalog)
}

fn available<'a>(catalog: &'a Catalog, id: &str) -> Result<&'a Entry> {
    catalog
        .entries
        .iter()
        .find(|entry| entry.manifest.id == id)
        .with_context(|| format!("Integration `{id}` is no longer published"))
}

/// The first known install location of a listing's local command on this platform.
fn known_executable(entry: &Entry) -> Option<String> {
    let platform = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    let home = crate::util::home_dir().ok();
    entry
        .executables
        .get(&platform)?
        .iter()
        .filter_map(|path| match path.strip_prefix("~/") {
            Some(rest) => home.as_ref().map(|home| home.join(rest)),
            None => Some(PathBuf::from(path)),
        })
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
}

/// Reuses existing discovery/OAuth candidates. Only the integration ID,
/// credentials for declared secrets and OAuth preferences come from the UI.
pub async fn connect_mcp(
    state: &AppState,
    id: &str,
    credentials: std::collections::HashMap<String, String>,
    oauth: plugins::DirectMcpOAuthOptions,
    executable_path: Option<String>,
    redirect_uri: String,
) -> Result<plugins::DirectMcpConnectResponse> {
    let catalog = fetch_and_cache(state).await?;
    let entry = available(&catalog, id)?;
    ensure!(
        matches!(&entry.manifest.runtime, ManifestRuntime::Mcp { .. }),
        "{id} is not an MCP integration"
    );
    ensure!(
        !plugins::catalog(state)?
            .index
            .plugins
            .iter()
            .any(|plugin| plugin.id == id),
        "{id} is already installed"
    );
    let executable_path = executable_path.or_else(|| known_executable(entry));
    plugins::connect_marketplace_mcp_candidate(
        state,
        entry.manifest.clone(),
        credentials,
        oauth,
        executable_path,
        redirect_uri,
    )
    .await
}

/// Confirmation starts a tracked installation only after discovery and
/// optional OAuth have completed. A fresh catalog must still approve exactly
/// the endpoint and manifest the user reviewed.
pub async fn install_mcp(
    state: AppState,
    candidate: plugins::MarketplaceMcpCandidate,
    ctx: OperationContext,
) -> Result<()> {
    ctx.progress("Verifying MCP integration", None);
    let approved = candidate.manifest();
    let catalog = tokio::select! {
        result = fetch_and_cache(&state) => result?,
        _ = ctx.cancellation.cancelled() => bail!("Marketplace installation cancelled"),
    };
    let entry = available(&catalog, &approved.id)?;
    ensure!(
        &entry.manifest == approved,
        "Marketplace integration changed since connection; reconnect to review the latest listing"
    );
    ensure!(
        !plugins::catalog(&state)?
            .index
            .plugins
            .iter()
            .any(|plugin| plugin.id == approved.id),
        "Integration `{}` is already installed",
        approved.id
    );
    ensure!(
        !ctx.cancellation.is_cancelled(),
        "Marketplace installation cancelled"
    );
    ctx.progress("Installing MCP integration", None);
    let primary = format!("icon.{}", entry.icons.primary.ext);
    let mut icons = vec![(
        primary,
        fetch_icon_asset(&state, &entry.icons.primary).await?.1,
    )];
    if let (Some(light), Some(dark)) = (&entry.icons.light, &entry.icons.dark) {
        icons.push((
            "icon-light.svg".to_string(),
            fetch_icon_asset(&state, light).await?.1,
        ));
        icons.push((
            "icon-dark.svg".to_string(),
            fetch_icon_asset(&state, dark).await?.1,
        ));
    }
    ensure!(
        !ctx.cancellation.is_cancelled(),
        "Marketplace installation cancelled"
    );
    plugins::install_marketplace_mcp_candidate(&state, candidate, icons, ctx.cancellation.clone())
        .await?;
    state.emit_plugins_changed();
    Ok(())
}

/// A verified marketplace ZIP staged for installation. The staging directory
/// lives as long as this value, so the bytes cannot vanish before the commit
/// that consumes them.
struct StagedPackage {
    staging: tempfile::TempDir,
    upload: plugins::PluginZipUpload,
}

/// Download the approved artifact for a listing and verify its digest.
async fn stage_package(
    state: &AppState,
    listing: &Entry,
    ctx: &OperationContext,
) -> Result<StagedPackage> {
    let id = &listing.manifest.id;
    let artifact = listing
        .artifact
        .as_ref()
        .context("Marketplace listing has no ZIP")?;
    let key = listing.artifact_key().context("missing version")?;
    let expected_url = state.account.endpoint(&format!("/{key}"))?;

    ctx.progress("Downloading plugin", None);
    let staging = tempfile::tempdir().context("staging marketplace ZIP")?;
    let path = staging.path().join(format!("{id}.zip"));

    let download = async {
        let mut response = state
            .marketplace_client
            .get(expected_url)
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .context("Marketplace package download failed")?
            .error_for_status()
            .context("Marketplace package unavailable")?;
        ensure!(
            response
                .content_length()
                .is_none_or(|len| len <= MAX_WASM_ZIP_BYTES),
            "Marketplace ZIP exceeds 25 MiB"
        );
        let mut file = tokio::fs::File::create(&path).await?;
        let mut hash = Sha256::new();
        let mut size = 0_u64;
        let total = response.content_length().filter(|n| *n > 0);
        ctx.progress("Downloading plugin", total.map(|_| 0));
        let mut last_percent = 0;
        while let Some(chunk) = response
            .chunk()
            .await
            .context("Marketplace package download interrupted")?
        {
            size += chunk.len() as u64;
            ensure!(size <= MAX_WASM_ZIP_BYTES, "Marketplace ZIP exceeds 25 MiB");
            hash.update(&chunk);
            file.write_all(&chunk).await?;
            if let Some(total) = total {
                let percent = ((size as f64 / total as f64) * 100.0).min(100.0) as u8;
                if percent > last_percent {
                    ctx.progress("Downloading plugin", Some(percent));
                    last_percent = percent;
                }
            }
        }
        file.flush().await?;
        ensure!(size > 0, "Marketplace ZIP is empty");
        ensure!(
            format!("{:x}", hash.finalize()) == artifact.sha256,
            "Marketplace ZIP failed SHA-256 verification"
        );
        Ok::<u64, anyhow::Error>(size)
    };
    let size = tokio::select! {
        result = download => result?,
        _ = ctx.cancellation.cancelled() => bail!("Marketplace installation cancelled"),
    };
    Ok(StagedPackage {
        staging,
        upload: plugins::PluginZipUpload {
            file_name: format!("{id}.zip"),
            path,
            compressed_bytes: size,
        },
    })
}

/// The exact server-verified release and authorization retained by queued work.
pub struct WasmInstallIntent {
    entry: Entry,
    update: Option<UpdateKind>,
}

impl WasmInstallIntent {
    pub fn id(&self) -> &str {
        &self.entry.manifest.id
    }
}

/// Fresh-install intents for the WASM integrations among `ids` that a newly
/// verified catalog lists. Ids the catalog does not list are left out.
pub async fn new_install_intents(
    state: &AppState,
    ids: &[String],
) -> Result<Vec<WasmInstallIntent>> {
    let catalog = fetch_and_cache(state).await?;
    Ok(catalog
        .entries
        .iter()
        .filter(|entry| {
            ids.contains(&entry.manifest.id)
                && matches!(entry.manifest.runtime, ManifestRuntime::Wasm { .. })
        })
        .map(|entry| WasmInstallIntent {
            entry: entry.clone(),
            update: None,
        })
        .collect())
}

pub fn wasm_install_intent(
    state: &AppState,
    id: &str,
    version: &str,
    digest: &str,
    update: bool,
) -> Result<WasmInstallIntent> {
    let catalog = cached(state).context("Refresh the marketplace before installing")?;
    let entry = available(&catalog, id)?;
    ensure!(
        matches!(entry.manifest.runtime, ManifestRuntime::Wasm { .. }),
        "{id} is not a WASM integration"
    );
    ensure!(
        entry.manifest.version.as_deref() == Some(version)
            && entry
                .artifact
                .as_ref()
                .is_some_and(|artifact| artifact.sha256 == digest),
        "Marketplace release changed; refresh and review the latest listing"
    );
    Ok(WasmInstallIntent {
        entry: entry.clone(),
        update: update.then_some(UpdateKind::Approval),
    })
}

pub async fn change_wasm(
    state: AppState,
    intent: WasmInstallIntent,
    ctx: OperationContext,
) -> Result<()> {
    let id = &intent.entry.manifest.id;
    ctx.progress("Checking marketplace catalog", None);
    let catalog = tokio::select! {
        result = fetch_and_cache(&state) => result?,
        _ = ctx.cancellation.cancelled() => bail!("Marketplace installation cancelled"),
    };
    let listing = available(&catalog, id)?;
    ensure!(
        listing.manifest == intent.entry.manifest
            && listing.artifact.as_ref().map(|artifact| &artifact.sha256)
                == intent
                    .entry
                    .artifact
                    .as_ref()
                    .map(|artifact| &artifact.sha256),
        "Marketplace release changed; refresh and review the latest listing"
    );
    ensure!(
        matches!(listing.manifest.runtime, ManifestRuntime::Wasm { .. }),
        "{id} is not a WASM integration"
    );

    let installed = plugins::catalog(&state)?;
    let existing = installed
        .index
        .plugins
        .iter()
        .find(|plugin| plugin.id == *id);
    let previous = if let Some(approval) = intent.update {
        let plugin = existing.with_context(|| format!("Integration `{id}` is not installed"))?;
        ensure!(
            managed_listing(plugin, listing),
            "Integration `{id}` was not installed from the marketplace"
        );
        let update = version_update(
            plugin.version.as_deref(),
            listing.manifest.version.as_deref(),
        )
        .with_context(|| format!("{id} is already at its published version"))?;
        ensure!(
            approval != UpdateKind::Auto || update.kind == UpdateKind::Auto,
            "This update requires approval"
        );
        Some(plugin.clone())
    } else {
        ensure!(existing.is_none(), "{id} is already installed");
        None
    };

    let digest = listing
        .artifact
        .as_ref()
        .context("Marketplace listing has no ZIP")?
        .sha256
        .clone();
    let staged = stage_package(&state, listing, &ctx).await?;
    ctx.progress("Validating and installing WASM package", None);
    let manifest = listing.manifest.clone();
    let cancel = ctx.cancellation.clone();
    let notify = state.clone();
    tokio::task::spawn_blocking(move || {
        let StagedPackage { staging, upload } = staged;
        let _staging = staging;
        plugins::commit_marketplace_wasm_zip(&state, &upload, &manifest, &digest, &cancel, previous)
    })
    .await
    .context("Marketplace installation task failed")??;
    notify.emit_plugins_changed();
    Ok(())
}
