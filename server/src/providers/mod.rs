//! Model providers: a core subsystem with its own interface, not plugins
//! (plans 006 and 008). The registry holds the provider profile configured
//! under `agent` in `settings.json`.

pub mod builtin;
pub mod catalog;
pub mod opencode;
pub mod rig;
pub mod store;
pub mod types;
pub(crate) mod wire;

use serde::Serialize;
use std::{collections::BTreeMap, sync::Arc};
use types::{ModelProvider, ModelRef};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    pub id: String,
    pub display_name: String,
    pub kind: String,
    pub base_url: String,
    /// Code-defined directory entry (see `builtin`); never deleted.
    pub builtin: bool,
    /// Whether an API key is stored for this profile.
    pub configured: bool,
    /// The stored key's last four characters, so the settings page can show
    /// which key is saved without revealing it. Empty when there is no key
    /// or it is too short to hint at safely.
    pub key_hint: String,
    /// Key field label and placeholder for the settings UI.
    pub key_label: String,
    pub key_placeholder: String,
    /// Where to get a key.
    pub doc_url: String,
    /// Icon name in the shared set; empty falls back to a letter tile.
    pub icon: String,
}

/// The last four characters of a key at least twelve long; otherwise empty,
/// since a hint on a short key would give away too much of it.
pub(crate) fn key_hint(api_key: &str) -> String {
    let key = api_key.trim();
    let count = key.chars().count();
    if count < 12 {
        return String::new();
    }
    key.chars().skip(count - 4).collect()
}

struct ProfileEntry {
    info: ProfileInfo,
    provider: Arc<dyn ModelProvider>,
}

#[derive(Default)]
pub struct ProviderRegistry {
    storage: Option<Arc<crate::store::Store>>,
    pub(crate) catalog: Arc<catalog::ModelCatalog>,
    profiles: BTreeMap<String, ProfileEntry>,
    default_model: Option<ModelRef>,
    chatgpt: Option<Arc<crate::chatgpt::Manager>>,
}

impl ProviderRegistry {
    pub(crate) fn insert(&mut self, info: ProfileInfo, provider: Arc<dyn ModelProvider>) {
        self.profiles
            .insert(info.id.clone(), ProfileEntry { info, provider });
    }

    pub fn chatgpt(&self) -> Option<Arc<crate::chatgpt::Manager>> {
        self.chatgpt.clone()
    }

    pub fn get(&self, profile_id: &str) -> Option<Arc<dyn ModelProvider>> {
        self.profiles
            .get(profile_id)
            .map(|entry| entry.provider.clone())
    }

    pub fn profile_kind(&self, id: &str) -> Option<&str> {
        self.profiles.get(id).map(|entry| entry.info.kind.as_str())
    }

    pub fn profiles(&self) -> Vec<ProfileInfo> {
        self.profiles
            .values()
            .map(|entry| {
                let mut info = entry.info.clone();
                if info.kind == "chatgpt" {
                    info.configured = self.chatgpt.as_ref().is_some_and(|auth| auth.configured());
                }
                info
            })
            .collect()
    }

    pub fn default_model(&self) -> Option<ModelRef> {
        self.default_model.clone()
    }
}
