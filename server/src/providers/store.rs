//! Local provider profiles and secrets. Secrets never enter public profile records.
use super::builtin::{BuiltinProvider, BUILTINS};
use super::catalog::{self, ModelMetadata};
use super::opencode::OpenCodeProvider;
use super::rig::RigProvider;
use super::types::{ModelProvider, ModelRef};
use super::{ProfileInfo, ProviderRegistry};
use crate::chatgpt::{ChatGPTProvider, Manager};
use anyhow::{ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

/// Kinds only custom profiles use; built-in kinds are valid too.
const CUSTOM_KINDS: [&str; 2] = ["chatCompletions", "custom"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileInput {
    pub id: Option<String>,
    pub kind: String,
    pub display_name: String,
    pub base_url: String,
    /// None preserves the old credential on update; an empty string clears it.
    pub api_key: Option<String>,
    pub session_header: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelPrefs {
    pub hidden: bool,
    pub alias: Option<String>,
    pub native_options: Value,
    pub metadata: Option<ModelMetadata>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub metadata: ModelMetadata,
    pub prefs: ModelPrefs,
}

fn build_provider(
    kind: &str,
    base_url: &str,
    api_key: String,
    session_header: Option<&str>,
    chatgpt: Option<Arc<Manager>>,
    catalog: Option<Arc<catalog::ModelCatalog>>,
) -> Result<Arc<dyn ModelProvider>> {
    let api_key = Some(api_key);
    let provider: Arc<dyn ModelProvider> = match kind {
        // One gateway serving models over three wire formats: routed per
        // model, from the appropriate OpenCode catalog entry.
        "opencode" | "opencode-zen" => Arc::new(OpenCodeProvider::new(
            base_url,
            api_key,
            session_header,
            catalog,
            if kind == "opencode" {
                "opencode"
            } else {
                "opencode-zen"
            },
        )?),
        "chatgpt" => Arc::new(ChatGPTProvider::new(
            chatgpt.context("ChatGPT authentication is unavailable")?,
        )),
        "responses" => Arc::new(RigProvider::new(
            base_url,
            api_key,
            "responses",
            session_header,
        )?),
        "anthropic" => Arc::new(
            RigProvider::new(base_url, api_key, "anthropic", session_header)?
                .with_model_catalog(catalog, "anthropic"),
        ),
        "google" => Arc::new(RigProvider::new(
            base_url,
            api_key,
            "google",
            session_header,
        )?),
        _ => Arc::new(RigProvider::new(base_url, api_key, kind, session_header)?),
    };
    Ok(provider)
}

type Entry = (ProfileInfo, Arc<dyn ModelProvider>);

/// Builds the stored profile `id`, or every stored profile. Built-ins take
/// their key guidance from code; everything else comes from the row.
fn read_profiles(
    db: &Connection,
    id: Option<&str>,
    chatgpt: Option<Arc<Manager>>,
    store: &crate::store::Store,
    catalog: Option<Arc<catalog::ModelCatalog>>,
) -> Result<Vec<Entry>> {
    let profile_sql = concat!(
        "SELECT public_id, kind, display_name, base_url, session_header, secret_ref ",
        "FROM provider_profiles ",
        "WHERE removed = 0 AND (?1 IS NULL OR public_id = ?1)",
    );
    let mut query = db.prepare(profile_sql)?;
    let rows = query.query_map([id], |row| {
        Ok((
            row.get(0)?,
            row.get::<_, String>(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
        ))
    })?;
    rows.map(|row| {
        let (id, kind, display_name, base_url, session_header, secret_ref) = row?;
        let api_key = secret_ref
            .map(|key| store.secrets.get(&key))
            .transpose()?
            .flatten()
            .unwrap_or_default();
        let builtin = BUILTINS.iter().find(|builtin| builtin.id == id);
        let guidance = |field: fn(&BuiltinProvider) -> &'static str, default: &'static str| {
            builtin.map_or(default, field).to_string()
        };
        let info = ProfileInfo {
            id,
            kind: kind.clone(),
            display_name,
            base_url,
            builtin: builtin.is_some(),
            configured: if kind == "chatgpt" {
                chatgpt.as_ref().is_some_and(|auth| auth.configured())
            } else {
                !api_key.trim().is_empty()
            },
            key_hint: super::key_hint(&api_key),
            key_label: guidance(|builtin| builtin.key_label, "API key"),
            key_placeholder: guidance(|builtin| builtin.key_placeholder, ""),
            doc_url: guidance(|builtin| builtin.doc_url, ""),
            icon: guidance(|builtin| builtin.icon, ""),
        };
        let provider = build_provider(
            &info.kind,
            &info.base_url,
            api_key,
            session_header.as_deref(),
            chatgpt.clone(),
            catalog.clone(),
        )?;
        Ok((info, provider))
    })
    .collect()
}

fn read_prefs(db: &Connection, model: &ModelRef) -> Result<ModelPrefs> {
    /// One `model_prefs` row: hidden flag, alias, native options JSON and
    /// metadata override JSON.
    type PrefsRow = (bool, Option<String>, Option<String>, Option<String>);
    let sql = concat!(
        "SELECT hidden, alias, native_options_json, metadata_override ",
        "FROM model_prefs ",
        "WHERE profile_id = (SELECT id FROM provider_profiles WHERE public_id = ?1) ",
        "AND model_id = ?2",
    );
    let row: Option<PrefsRow> = db
        .query_row(sql, params![model.profile_id, model.model_id], |r| {
            let options: Option<String> = r.get(2)?;
            let metadata: Option<String> = r.get(3)?;
            Ok((r.get(0)?, r.get(1)?, options, metadata))
        })
        .optional()?;
    let prefs = match row {
        None => ModelPrefs::default(),
        Some((hidden, alias, options, metadata)) => {
            let native_options = options
                .map(|s| serde_json::from_str(&s))
                .transpose()?
                .unwrap_or(Value::Null);
            let metadata = metadata.map(|s| serde_json::from_str(&s)).transpose()?;
            ModelPrefs {
                hidden,
                alias,
                native_options,
                metadata,
            }
        }
    };
    Ok(prefs)
}
fn save_prefs_in(db: &Connection, model: &ModelRef, prefs: &ModelPrefs) -> Result<()> {
    let native_options = serde_json::to_string(&prefs.native_options)?;
    let metadata = prefs
        .metadata
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let sql = concat!(
        "INSERT INTO model_prefs(",
        "profile_id, model_id, hidden, alias, native_options_json, metadata_override",
        ") VALUES (",
        "(SELECT id FROM provider_profiles WHERE public_id = ?1), ",
        "?2, ?3, ?4, ?5, ?6",
        ") ON CONFLICT(profile_id, model_id) DO UPDATE SET ",
        "hidden = excluded.hidden, alias = excluded.alias, ",
        "native_options_json = excluded.native_options_json, ",
        "metadata_override = excluded.metadata_override",
    );
    db.execute(
        sql,
        params![
            model.profile_id,
            model.model_id,
            prefs.hidden,
            prefs.alias,
            native_options,
            metadata
        ],
    )?;
    Ok(())
}
impl ProviderRegistry {
    pub fn from_store(store: Arc<crate::store::Store>) -> Result<Self> {
        store.write_blocking(|db| {
            for b in BUILTINS {
                let builtin_sql = concat!(
                    "INSERT INTO provider_profiles(",
                    "public_id, kind, display_name, base_url, session_header, created_at",
                    ") VALUES (?1, ?2, ?3, ?4, ?5, ?6) ",
                    "ON CONFLICT(public_id) DO UPDATE SET ",
                    "kind = excluded.kind, display_name = excluded.display_name, ",
                    "base_url = excluded.base_url, session_header = excluded.session_header",
                );
                let stamped = chrono::Utc::now().timestamp_millis();
                db.execute(
                    builtin_sql,
                    params![
                        b.id,
                        b.kind,
                        b.display_name,
                        b.base_url,
                        b.session_header,
                        stamped
                    ],
                )?;
            }
            Ok(())
        })?;
        let auth = Manager::new(store.chatgpt_auth_path.clone())?;
        let credentials = store.clone();
        let chatgpt = auth.clone();
        // Loaded first: gateway providers route models by it.
        let catalog = Arc::new(catalog::ModelCatalog::load_from_store(store.clone())?);
        let routes = catalog.clone();
        let entries = store.read_blocking(move |db| {
            read_profiles(db, None, Some(chatgpt), &credentials, Some(routes))
        })?;
        let mut registry = Self {
            chatgpt: Some(auth),
            storage: Some(store.clone()),
            catalog,
            ..Self::default()
        };
        for (info, provider) in entries {
            registry.insert(info, provider);
        }
        registry.default_model = store.read_blocking(|db| {
            let value: Option<String> = db
                .query_row("SELECT value FROM meta WHERE key='last_model'", [], |r| {
                    r.get(0)
                })
                .optional()?;
            Ok(value.map(|s| serde_json::from_str(&s)).transpose()?)
        })?;
        Ok(registry)
    }
    fn store(&self) -> Result<Arc<crate::store::Store>> {
        self.storage
            .clone()
            .context("Provider storage is unavailable")
    }
    fn read_profile(&self, id: &str) -> Result<Option<Entry>> {
        let store = self.store()?;
        let credentials = store.clone();
        let auth = self.chatgpt.clone();
        let routes = self.catalog.clone();
        let id = id.to_owned();
        store.read_blocking(move |db| {
            Ok(read_profiles(db, Some(&id), auth, &credentials, Some(routes))?.pop())
        })
    }
    pub fn save_profile(&mut self, id: Option<&str>, input: ProfileInput) -> Result<ProfileInfo> {
        let kind = input.kind.as_str();
        ensure!(
            CUSTOM_KINDS.contains(&kind) || BUILTINS.iter().any(|b| b.kind == kind),
            "Unsupported provider kind"
        );
        ensure!(
            !input.display_name.trim().is_empty(),
            "Profile name is required"
        );
        let url = url::Url::parse(&input.base_url).context("Invalid provider URL")?;
        ensure!(
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none(),
            "Use an HTTP or HTTPS base URL without credentials, query or fragment"
        );
        let key = id
            .map(str::to_owned)
            .or(input.id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        ensure!(!key.trim().is_empty(), "Profile ID is required");
        let builtin = BUILTINS.iter().any(|b| b.id == key);
        ensure!(
            kind != "chatgpt" || key == "chatgpt",
            "ChatGPT uses its built-in account connection"
        );
        if id.is_some() {
            ensure!(self.profiles.contains_key(&key), "Unknown provider profile")
        } else if !builtin {
            ensure!(
                !self.profiles.contains_key(&key),
                "Profile ID already exists"
            )
        }
        let store = self.store()?;
        let secret_ref = format!("provider:{key}");
        let old = store.secrets.get(&secret_ref)?;
        if let Some(value) = &input.api_key {
            if value.is_empty() {
                store.secrets.delete(&secret_ref)?;
            } else {
                store.secrets.set(&secret_ref, value)?;
            }
        }
        let saved_key = key.clone();
        let db_key = secret_ref.clone();
        let has_key = input
            .api_key
            .as_ref()
            .map_or(old.is_some(), |s| !s.is_empty());
        let saved = store.write_blocking(move |db| {
            if !builtin {
                let upsert_sql = concat!(
                    "INSERT INTO provider_profiles(",
                    "public_id, kind, display_name, base_url, session_header, created_at",
                    ") VALUES (?1, ?2, ?3, ?4, NULLIF(TRIM(?5), ''), ?6) ",
                    "ON CONFLICT(public_id) DO UPDATE SET ",
                    "kind = excluded.kind, ",
                    "display_name = excluded.display_name, ",
                    "base_url = excluded.base_url, ",
                    "session_header = CASE WHEN ?5 IS NULL ",
                    "THEN session_header ELSE excluded.session_header END, ",
                    "removed = 0",
                );
                let stamped = chrono::Utc::now().timestamp_millis();
                let display_name = input.display_name.trim();
                let base_url = input.base_url.trim_end_matches('/');
                db.execute(
                    upsert_sql,
                    params![
                        saved_key,
                        input.kind,
                        display_name,
                        base_url,
                        input.session_header,
                        stamped
                    ],
                )?;
            }
            let key_sql = "UPDATE provider_profiles SET secret_ref = ?2 WHERE public_id = ?1";
            db.execute(key_sql, params![saved_key, has_key.then_some(db_key)])?;
            Ok(())
        });
        if let Err(error) = saved {
            match old {
                Some(value) => store.secrets.set(&secret_ref, &value)?,
                None => store.secrets.delete(&secret_ref)?,
            }
            return Err(error);
        }
        let (info, provider) = self
            .read_profile(&key)?
            .context("Unknown provider profile")?;
        self.insert(info.clone(), provider);
        Ok(info)
    }
    pub fn delete_profile(&mut self, id: &str) -> Result<()> {
        ensure!(self.profiles.contains_key(id), "Unknown provider profile");
        let store = self.store()?;
        let builtin = BUILTINS.iter().any(|b| b.id == id);
        let clear = self
            .default_model
            .as_ref()
            .is_some_and(|m| m.profile_id == id);
        let key = id.to_owned();
        store.secrets.delete(&format!("provider:{id}"))?;
        store.write_blocking(move |db| {
            db.execute(
                if builtin {
                    "UPDATE provider_profiles SET secret_ref=NULL WHERE public_id=?1"
                } else {
                    "UPDATE provider_profiles SET removed=1,secret_ref=NULL WHERE public_id=?1"
                },
                [key],
            )?;
            if clear {
                db.execute("DELETE FROM meta WHERE key='last_model'", [])?;
            }
            Ok(())
        })?;
        self.profiles.remove(id);
        if clear {
            self.default_model = None
        }
        if let Some((info, provider)) = self.read_profile(id)? {
            self.insert(info, provider);
        }
        Ok(())
    }
    pub fn prefs(&self, model: &ModelRef) -> Result<ModelPrefs> {
        let Some(store) = &self.storage else {
            return Ok(ModelPrefs::default());
        };
        let model = model.clone();
        store.read_blocking(move |db| read_prefs(db, &model))
    }
    fn resolve(&self, kind: &str, id: &str, prefs: &ModelPrefs) -> ModelMetadata {
        let catalogued = self.catalog.lookup(kind, id);
        match prefs.metadata.clone() {
            // Edited limits keep the catalog's reasoning levels and default.
            Some(pinned) => ModelMetadata {
                name: pinned.name.or(catalogued.name),
                reasoning_levels: if pinned.reasoning_levels.is_empty() {
                    catalogued.reasoning_levels
                } else {
                    pinned.reasoning_levels
                },
                reasoning_default: pinned.reasoning_default.or(catalogued.reasoning_default),
                ..pinned
            },
            None => catalogued,
        }
    }
    pub fn metadata(&self, model: &ModelRef) -> Result<ModelMetadata> {
        let profile = self
            .profiles
            .get(&model.profile_id)
            .context("Unknown provider profile")?;
        Ok(self.resolve(&profile.info.kind, &model.model_id, &self.prefs(model)?))
    }
    pub fn save_prefs(&self, model: &ModelRef, prefs: &ModelPrefs) -> Result<()> {
        ensure!(
            self.profiles.contains_key(&model.profile_id) && !model.model_id.trim().is_empty(),
            "Unknown profile or empty model ID"
        );
        ensure!(
            prefs.native_options.is_null() || prefs.native_options.is_object(),
            "Native options must be a JSON object"
        );
        if let Some(m) = &prefs.metadata {
            m.validate()?;
        }
        let model = model.clone();
        let prefs = prefs.clone();
        self.store()?
            .write_blocking(move |db| save_prefs_in(db, &model, &prefs))
    }
    pub fn remember(&mut self, model: &ModelRef, options: &Value) -> Result<()> {
        if let Some(store) = &self.storage {
            let model = model.clone();
            let options = options.clone();
            store.write_blocking(move |db| {
                let mut prefs = read_prefs(db, &model)?;
                prefs.native_options = options;
                save_prefs_in(db, &model, &prefs)?;
                let last_model = serde_json::to_string(&model)?;
                let meta_sql = concat!(
                    "INSERT INTO meta VALUES ('last_model', ?1) ",
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                );
                db.execute(meta_sql, [last_model])?;
                let touch_sql = concat!(
                    "UPDATE model_prefs SET last_used_at = ?3 ",
                    "WHERE profile_id = ",
                    "(SELECT id FROM provider_profiles WHERE public_id = ?1) ",
                    "AND model_id = ?2",
                );
                let stamped = chrono::Utc::now().timestamp_millis();
                db.execute(
                    touch_sql,
                    params![model.profile_id, model.model_id, stamped],
                )?;
                Ok(())
            })?;
        }
        self.default_model = Some(model.clone());
        Ok(())
    }
    pub fn model_infos(&self, profile: &str, ids: Vec<String>) -> Result<Vec<ModelInfo>> {
        let kind = &self
            .profiles
            .get(profile)
            .context("Unknown provider profile")?
            .info
            .kind;
        ids.into_iter()
            .map(|id| {
                let prefs = self.prefs(&ModelRef {
                    profile_id: profile.into(),
                    model_id: id.clone(),
                })?;
                Ok(ModelInfo {
                    metadata: self.resolve(kind, &id, &prefs),
                    id,
                    prefs,
                })
            })
            .collect()
    }
    pub fn saved_models(&self, profile: &str) -> Result<Vec<String>> {
        let profile = profile.to_owned();
        let sql = concat!(
            "SELECT model_id FROM model_prefs ",
            "WHERE profile_id = (SELECT id FROM provider_profiles WHERE public_id = ?1) ",
            "ORDER BY model_id",
        );
        self.store()?.read_blocking(move |db| {
            let rows = db
                .prepare(sql)?
                .query_map([profile], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }
}
