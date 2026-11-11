//! Locally cached models.dev capabilities. Unknown models use editable defaults.
//! Fetches only during model discovery; agent turns never depend on the network.
//!
//! A model served through a gateway the catalog does not cover (an OpenAI-
//! compatible endpoint, say) is still matched by its model ID across every
//! catalogued provider, so `deepseek/deepseek-v4.1-flash` behind a custom
//! endpoint gets DeepSeek's real limits instead of the generic default.
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{Mutex, OnceLock, RwLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const CATALOG_URL: &str = "https://models.dev/api.json";
const REFRESH_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const RETRY_INTERVAL: Duration = Duration::from_secs(5 * 60);
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
/// Bumped when the cached shape gains data or is derived differently, so an
/// older cache is refetched. Stored as its own row (`VERSION_KIND`).
const CACHE_VERSION: u32 = 12;
/// The effort levels Squire offers, weakest first, as models.dev and rig
/// spell them. `none` turns reasoning off; a model offers it only when its
/// listing does, so it is never added to a model that cannot run without it.
const EFFORTS: [&str; 7] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
/// `model_catalog` rows that are not model metadata: the cache version, and
/// per-provider wire packages (`WIRE_KIND_PREFIX` + provider kind).
const VERSION_KIND: &str = "__version";
const WIRE_KIND_PREFIX: &str = "__wire:";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelMetadata {
    pub context_window: u32,
    pub max_output: u32,
    pub tools: bool,
    pub vision: bool,
    pub reasoning_style: String,
    /// USD per million tokens.
    pub input_price: Option<f64>,
    pub output_price: Option<f64>,
    /// USD per million cached input tokens; absent when no reliable rate exists.
    pub cache_read_price: Option<f64>,
    pub cache_write_price: Option<f64>,
    /// The catalog's human name ("Claude Haiku 4.5"), shown instead of the
    /// raw model ID when the reader has not set a display name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The reasoning effort levels the model accepts, weakest first; empty
    /// when it takes none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reasoning_levels: Vec<String>,
    /// The level a request without one runs at: the model's documented
    /// default, or a middle level when none is documented. Squire sends it,
    /// so the level the picker shows is always the level used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_default: Option<String>,
}

/// Limits for a model nothing else describes. Tool-calling models in current
/// use have at least this much context; a smaller one can be set per model.
impl Default for ModelMetadata {
    fn default() -> Self {
        Self {
            context_window: 131_072,
            max_output: 8_192,
            tools: true,
            vision: false,
            reasoning_style: "native".into(),
            input_price: None,
            output_price: None,
            cache_read_price: None,
            cache_write_price: None,
            name: None,
            reasoning_levels: Vec::new(),
            reasoning_default: None,
        }
    }
}

impl ModelMetadata {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.max_output > 0 && self.context_window > self.max_output,
            "Context window must exceed the positive output limit"
        );
        for price in [
            self.input_price,
            self.output_price,
            self.cache_read_price,
            self.cache_write_price,
        ]
        .into_iter()
        .flatten()
        {
            ensure!(
                price.is_finite() && price >= 0.0,
                "Prices must be nonnegative"
            );
        }
        Ok(())
    }

    /// `options` with this model's default effort added when they name none,
    /// so a request runs at the level the picker shows.
    pub fn with_default_effort(&self, options: Value) -> Value {
        let Some(default) = &self.reasoning_default else {
            return options;
        };
        let mut fields = match options {
            Value::Object(fields) => fields,
            Value::Null => serde_json::Map::new(),
            other => return other,
        };
        let named = fields.contains_key("reasoning_effort")
            || fields
                .get("reasoning")
                .is_some_and(|reasoning| reasoning.get("effort").is_some());
        if !named {
            fields.insert("reasoning_effort".into(), Value::String(default.clone()));
        }
        Value::Object(fields)
    }

    /// Estimates public list-price cost, never a provider billing receipt.
    /// If a cached-token rate is unknown, report no estimate instead of
    /// silently charging the ordinary input rate.
    pub fn estimated_cost_usd(&self, usage: crate::providers::types::Usage) -> Option<f64> {
        // `Usage::input` is canonical total input including cached tokens
        // (normalized in `rig::mapped_usage`). Ordinary tokens are the
        // remainder; vanishing on corrupt data is fail-closed.
        let ordinary = usage
            .input
            .checked_sub(usage.cached_read.checked_add(usage.cached_write)?)?;
        let read_price = if usage.cached_read == 0 {
            0.0
        } else {
            self.cache_read_price?
        };
        let write_price = if usage.cached_write == 0 {
            0.0
        } else {
            self.cache_write_price?
        };
        Some(
            (ordinary as f64 * self.input_price?
                + usage.cached_read as f64 * read_price
                + usage.cached_write as f64 * write_price
                + usage.output as f64 * self.output_price?)
                / 1_000_000.0,
        )
    }
}

type Models = BTreeMap<String, BTreeMap<String, ModelMetadata>>;

#[derive(Default, Serialize, Deserialize)]
struct Cache {
    #[serde(default)]
    version: u32,
    fetched_at: u64,
    providers: Models,
    /// Every catalogued model by normalized ID, across all providers.
    #[serde(default)]
    models: BTreeMap<String, ModelMetadata>,
    /// The SDK package a gateway serves each model through, by provider
    /// kind then model ID: models.dev's per-model `provider.npm`
    /// (`@ai-sdk/openai` for Responses, `@ai-sdk/anthropic` for Messages).
    /// Includes the upstream provider default when a model does not override it.
    #[serde(default)]
    wires: BTreeMap<String, BTreeMap<String, String>>,
}

/// The bare model name: lowercase, without a vendor prefix
/// (`deepseek/…`) or a routing suffix (`…:free`).
fn normalize(id: &str) -> String {
    let name = id.rsplit('/').next().unwrap_or(id);
    let name = name.split(':').next().unwrap_or(name);
    name.trim().to_ascii_lowercase()
}

/// A snapshot held in memory for synchronous lookups, with a disk copy for
/// offline starts. The refresh mutex deduplicates simultaneous discoveries.
#[derive(Default)]
pub struct ModelCatalog {
    store: Option<std::sync::Arc<crate::store::Store>>,
    cache: RwLock<Cache>,
    refresh: tokio::sync::Mutex<()>,
    last_attempt: Mutex<Option<Instant>>,
}

impl ModelCatalog {
    pub fn load_from_store(store: std::sync::Arc<crate::store::Store>) -> Result<Self> {
        let cache = store.read_blocking(|db| {
            let mut cache = Cache::default();
            let rows = db
                .prepare(
                    "SELECT provider_kind,model_id,metadata_json,fetched_at FROM model_catalog",
                )?
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, i64>(3)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for (kind, id, json, at) in rows {
                if kind == VERSION_KIND {
                    cache.version = serde_json::from_str(&json)?;
                    continue;
                }
                if let Some(wire_kind) = kind.strip_prefix(WIRE_KIND_PREFIX) {
                    let package: String = serde_json::from_str(&json)?;
                    cache
                        .wires
                        .entry(wire_kind.to_string())
                        .or_default()
                        .insert(id, package);
                    continue;
                }
                let metadata = serde_json::from_str(&json)?;
                cache.fetched_at = at as u64 / 1000;
                if kind == "__normalized" {
                    cache.models.insert(id, metadata);
                } else {
                    cache
                        .providers
                        .entry(kind)
                        .or_default()
                        .insert(id, metadata);
                }
            }
            Ok(cache)
        })?;
        Ok(Self {
            store: Some(store),
            cache: RwLock::new(cache),
            ..Self::default()
        })
    }

    pub fn lookup(&self, kind: &str, id: &str) -> ModelMetadata {
        let cache = self.cache.read().expect("model catalog");
        cache
            .providers
            .get(if matches!(kind, "responses" | "chatgpt") {
                "openai"
            } else {
                kind
            })
            .and_then(|models| models.get(id))
            .or_else(|| cache.models.get(&normalize(id)))
            .cloned()
            .unwrap_or_default()
    }

    /// The SDK package `kind` serves model `id` through, when the catalog
    /// lists one for it (see `Cache::wires`).
    /// An upstream-declared output capability, with no generated default.
    pub fn known_max_output(&self, kind: &str, id: &str) -> Option<u32> {
        self.cache
            .read()
            .expect("model catalog")
            .providers
            .get(kind)?
            .get(id)
            .map(|model| model.max_output)
    }

    pub fn has_wires(&self, kind: &str) -> bool {
        self.cache
            .read()
            .expect("model catalog")
            .wires
            .get(kind)
            .is_some_and(|models| !models.is_empty())
    }

    pub fn wire(&self, kind: &str, id: &str) -> Option<String> {
        let cache = self.cache.read().expect("model catalog");
        cache.wires.get(kind)?.get(id).cloned()
    }

    pub async fn refresh(&self) -> Result<()> {
        // Tests never reach the network; they call `refresh_from` directly.
        if cfg!(test) {
            return Ok(());
        }
        self.refresh_from(CATALOG_URL).await
    }

    async fn refresh_from(&self, url: &str) -> Result<()> {
        let Some(store) = &self.store else {
            return Ok(());
        };
        let _refresh = self.refresh.lock().await;
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        {
            // A cache written by an older build lacks data this one reads,
            // so it is refetched however recent it is.
            let cache = self.cache.read().expect("model catalog");
            if cache.version == CACHE_VERSION
                && now.saturating_sub(cache.fetched_at) < REFRESH_INTERVAL.as_secs()
            {
                return Ok(());
            }
        }
        {
            let mut attempt = self.last_attempt.lock().expect("model catalog");
            if attempt.is_some_and(|last| last.elapsed() < RETRY_INTERVAL) {
                return Ok(());
            }
            *attempt = Some(Instant::now());
        }

        let response = reqwest::Client::new()
            .get(url)
            .timeout(Duration::from_secs(8))
            .send()
            .await?
            .error_for_status()?;
        if let Some(size) = response.content_length() {
            ensure!(
                size <= MAX_RESPONSE_BYTES as u64,
                "Model catalog is too large"
            );
        }
        let bytes = response.bytes().await?;
        ensure!(
            bytes.len() <= MAX_RESPONSE_BYTES,
            "Model catalog is too large"
        );
        let source: Value = serde_json::from_slice(&bytes)?;
        let providers = extract(&source)?;
        let models = index(&source);
        ensure!(
            !providers.is_empty() || !models.is_empty(),
            "Model catalog contains no models"
        );

        let next = Cache {
            version: CACHE_VERSION,
            fetched_at: now,
            providers,
            models,
            wires: extract_wires(&source),
        };
        let mut rows = Vec::new();
        for (kind, models) in &next.providers {
            for (id, metadata) in models {
                rows.push((kind.clone(), id.clone(), serde_json::to_string(metadata)?));
            }
        }
        for (id, metadata) in &next.models {
            rows.push((
                "__normalized".into(),
                id.clone(),
                serde_json::to_string(metadata)?,
            ));
        }
        for (kind, packages) in &next.wires {
            for (id, package) in packages {
                rows.push((
                    format!("{WIRE_KIND_PREFIX}{kind}"),
                    id.clone(),
                    serde_json::to_string(package)?,
                ));
            }
        }
        rows.push((
            VERSION_KIND.into(),
            String::new(),
            serde_json::to_string(&CACHE_VERSION)?,
        ));
        store
            .write(move |db| {
                db.execute("DELETE FROM model_catalog", [])?;
                for (kind, id, json) in rows {
                    db.execute(
                        "INSERT INTO model_catalog VALUES (?1,?2,?3,?4)",
                        rusqlite::params![kind, id, json, now as i64 * 1000],
                    )?;
                }
                Ok(())
            })
            .await?;
        *self.cache.write().expect("model catalog") = next;
        Ok(())
    }
}

/// What rig's reviewed catalog knows of a model's reasoning, by normalized
/// model ID: its effort levels and, where documented, its default level.
/// models.dev lists levels but not defaults, so the default comes from here.
fn rig_reasoning(id: &str) -> Option<&'static (Vec<String>, Option<String>)> {
    static INDEX: OnceLock<BTreeMap<String, (Vec<String>, Option<String>)>> = OnceLock::new();
    INDEX
        .get_or_init(|| {
            let mut index: BTreeMap<String, (Vec<String>, Option<String>)> = BTreeMap::new();
            for spec in rig_core::catalog::Catalog::builtin().iter() {
                let reasoning = &spec.reasoning;
                if reasoning.levels.is_empty() {
                    continue;
                }
                let entry = (
                    reasoning
                        .levels
                        .iter()
                        .map(|level| level.as_str().to_string())
                        .collect(),
                    reasoning
                        .default
                        .as_ref()
                        .map(|level| level.as_str().to_string()),
                );
                // Hosts list the same model; prefer a listing with a documented default.
                let current = index.entry(normalize(&spec.id)).or_insert(entry.clone());
                if current.1.is_none() && entry.1.is_some() {
                    *current = entry;
                }
            }
            index
        })
        .get(&normalize(id))
}

/// The effort levels a models.dev row's `reasoning_options` lists, weakest first.
fn effort_levels(item: &Value) -> Vec<String> {
    let listed: Vec<&str> = item["reasoning_options"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|option| option["type"] == "effort")
        .flat_map(|option| option["values"].as_array().into_iter().flatten())
        .filter_map(Value::as_str)
        .collect();
    EFFORTS
        .iter()
        .filter(|level| listed.contains(level))
        .map(|level| level.to_string())
        .collect()
}

/// The documented default when it is one of `levels`; otherwise `medium`,
/// or the middle level when there is no `medium`. The fallbacks never pick
/// `none`: turning reasoning off is a choice, not something to do for a model
/// that documents no default.
fn default_effort(levels: &[String], documented: Option<&str>) -> Option<String> {
    let active: Vec<&String> = levels
        .iter()
        .filter(|level| level.as_str() != "none")
        .collect();
    documented
        .filter(|level| levels.iter().any(|known| known == level))
        .map(str::to_string)
        .or_else(|| {
            active
                .iter()
                .find(|level| level.as_str() == "medium")
                .map(|level| level.to_string())
        })
        .or_else(|| active.get(active.len() / 2).map(|level| level.to_string()))
}

/// Capability detection, distinct from the DeepSeek wire routing in rig.rs:
/// only V4 advertises an off switch. DeepSeek V4 takes `thinking: {type: "disabled"}`
/// (which `rig.rs` sends for `none`), while its effort values stop at
/// low/high/max, so listings never carry `none` for it.
fn can_disable_reasoning(id: &str) -> bool {
    normalize(id).starts_with("deepseek-v4")
}

fn convert(id: &str, item: &Value) -> Option<ModelMetadata> {
    let cost = &item["cost"];
    let reasons = item["reasoning"].as_bool().unwrap_or(false);
    let rig = rig_reasoning(id);
    let mut reasoning_levels = match effort_levels(item) {
        _ if !reasons => Vec::new(),
        levels if !levels.is_empty() => levels,
        _ => rig.map(|(levels, _)| levels.clone()).unwrap_or_default(),
    };
    if can_disable_reasoning(id)
        && !reasoning_levels.is_empty()
        && !reasoning_levels.iter().any(|level| level == "none")
    {
        reasoning_levels.insert(0, "none".into());
    }
    let reasoning_default = default_effort(
        &reasoning_levels,
        rig.and_then(|(_, default)| default.as_deref()),
    );
    let metadata = ModelMetadata {
        context_window: item["limit"]["context"].as_u64()?.try_into().ok()?,
        max_output: item["limit"]["output"].as_u64()?.try_into().ok()?,
        tools: item["tool_call"].as_bool().unwrap_or(false),
        vision: item["modalities"]["input"]
            .as_array()
            .is_some_and(|inputs| inputs.iter().any(|input| input == "image")),
        reasoning_style: if reasons {
            "native".into()
        } else {
            "none".into()
        },
        input_price: cost["input"].as_f64(),
        output_price: cost["output"].as_f64(),
        cache_read_price: cost["cache_read"].as_f64(),
        cache_write_price: cost["cache_write"].as_f64(),
        name: item["name"]
            .as_str()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string),
        reasoning_levels,
        reasoning_default,
    };
    metadata.validate().ok().map(|()| metadata)
}

fn provider_models(source: &Value) -> impl Iterator<Item = (&String, &Value)> {
    source
        .as_object()
        .into_iter()
        .flat_map(|providers| providers.values())
        .filter_map(|provider| provider["models"].as_object())
        .flatten()
}

/// Squire's provider kinds and the models.dev providers that describe them.
/// The GLM UI profile points at BigModel's API; models.dev calls it zhipuai.
/// OpenCode Zen and OpenCode Go have separate models.dev listings.
const UPSTREAMS: &[(&str, &str)] = &[
    ("openai", "openai"),
    ("anthropic", "anthropic"),
    ("google", "google"),
    ("xai", "xai"),
    ("deepseek", "deepseek"),
    ("glm", "zai"),
    ("glm", "zhipuai"),
    ("meta", "meta"),
    ("openrouter", "openrouter"),
    ("opencode", "opencode-go"),
    ("opencode-zen", "opencode"),
];

/// Effective SDK package for every model: the model override or the
/// provider default declared by models.dev.
fn extract_wires(source: &Value) -> BTreeMap<String, BTreeMap<String, String>> {
    let mut found: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for (kind, upstream) in UPSTREAMS {
        let provider = &source[*upstream];
        let default = provider["npm"].as_str();
        let Some(models) = provider["models"].as_object() else {
            continue;
        };
        for (id, item) in models {
            if let Some(package) = item["provider"]["npm"]
                .as_str()
                .or(default)
                .filter(|package| !package.is_empty())
            {
                found
                    .entry((*kind).to_string())
                    .or_default()
                    .insert(id.clone(), package.to_string());
            }
        }
    }
    found
}

fn extract(source: &Value) -> Result<Models> {
    let mut found = Models::new();
    for (kind, upstream) in UPSTREAMS.iter().copied() {
        let Some(models) = source[upstream]["models"].as_object() else {
            continue;
        };
        let converted: BTreeMap<_, _> = models
            .iter()
            .filter_map(|(id, item)| convert(id, item).map(|metadata| (id.clone(), metadata)))
            .collect();
        if !converted.is_empty() {
            found.insert(kind.into(), converted);
        }
    }
    Ok(found)
}

/// The value most listings agree on, the larger on a tie.
fn most_listed(values: impl Iterator<Item = u32>) -> Option<u32> {
    let mut votes: BTreeMap<u32, usize> = BTreeMap::new();
    for value in values {
        *votes.entry(value).or_default() += 1;
    }
    votes
        .into_iter()
        .max_by_key(|&(value, count)| (count, value))
        .map(|(value, _)| value)
}

/// One entry per model name across every provider. Hosts disagree on limits,
/// so the context window most of them list wins, then the output limit most
/// of them list at that window. Never the largest: a few gateways list an
/// output limit near the whole window, and the context budget reserves it.
fn index(source: &Value) -> BTreeMap<String, ModelMetadata> {
    let mut listings: BTreeMap<String, Vec<ModelMetadata>> = BTreeMap::new();
    for (id, item) in provider_models(source) {
        if let Some(metadata) = convert(id, item) {
            listings.entry(normalize(id)).or_default().push(metadata);
        }
    }
    listings
        .into_iter()
        .filter_map(|(name, mut candidates)| {
            let window = most_listed(candidates.iter().map(|model| model.context_window))?;
            candidates.retain(|model| model.context_window == window);
            let output = most_listed(candidates.iter().map(|model| model.max_output))?;
            candidates.retain(|model| model.max_output == output);
            Some((name, candidates.swap_remove(0)))
        })
        .collect()
}
