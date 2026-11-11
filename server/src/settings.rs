use crate::storage::StoragePaths;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    num::{NonZeroI64, NonZeroU16, NonZeroU64, NonZeroUsize},
};

const DEFAULT_WEB_PORT: u16 = 4296;
const DEFAULT_MAX_FILE_SIZE_BYTES: usize = 200_000;
const DEFAULT_MAX_READ_FILE_SIZE_BYTES: usize = 100_000;
const DEFAULT_MAX_SEARCH_LINE_LENGTH: usize = 300;
const DEFAULT_COMMAND_TIMEOUT_MS: u64 = 50_000;
const DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES: usize = 100_000;
const DEFAULT_TREE_MAX_RESULTS: usize = 200;

/// Unknown keys are ignored, so settings written by older builds (which also
/// configured the local MCP listener, its OAuth and a tunnel) still load; the
/// next save drops them.
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub ports: PortSettings,
    pub limits: LimitSettings,
    /// Host names, besides loopback, that the web UI answers on: a reverse
    /// proxy in front of this machine, such as a VM's private port
    /// forwarding (`"workstation.example.com"`). The UI has no login, so whatever
    /// serves these names must control who can reach them.
    pub allowed_hosts: Vec<String>,
    /// The name Claude and the account page show for this device. Unset uses
    /// the name the system reports, which on Android is only the model: apps
    /// cannot read the name set in the phone's settings.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PortSettings {
    /// The loopback port of the local web UI, Squire's only listener.
    pub web: NonZeroU16,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LimitSettings {
    pub max_file_size_bytes: NonZeroUsize,
    pub max_read_file_size_bytes: NonZeroUsize,
    pub max_search_line_length: NonZeroUsize,
    pub command_timeout_ms: NonZeroU64,
    pub action_max_runtime_ms: NonZeroU64,
    pub command_output_limit_bytes: NonZeroUsize,
    pub tree_max_results: NonZeroUsize,
    pub connection_payload_retention_days: NonZeroI64,
}

impl Settings {
    pub fn load(storage: &StoragePaths) -> Result<Self> {
        let path = storage.settings();
        if path.exists() {
            let raw = fs::read_to_string(&path)?;
            // Migrate pre-NonZero configs: `0` meant "unset" and failed serde
            // with a cryptic message. Coerce zeros to defaults with a clear
            // path in the error if the shape is otherwise invalid.
            let mut value: serde_json::Value =
                serde_json::from_str(&raw).context("Invalid settings.json")?;
            migrate_zeros(&mut value);
            let settings: Self = serde_json::from_value(value).map_err(|e| {
                anyhow::anyhow!(
                    "Invalid settings.json ({}); delete it to regenerate defaults",
                    e
                )
            })?;
            return Ok(settings);
        }

        let settings = Self::default();
        settings.save(storage)?;
        Ok(settings)
    }

    pub fn save(&self, storage: &StoragePaths) -> Result<()> {
        let path = storage.settings();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        crate::util::write_json(path, self)
    }

    /// Positivity of ports and limits is enforced by NonZero* types at
    /// deserialization time; nothing else needs checking.
    pub fn validate(&self) -> Result<()> {
        Ok(())
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ports: PortSettings::default(),
            limits: LimitSettings::default(),
            allowed_hosts: Vec::new(),
            device_name: None,
        }
    }
}

impl Default for PortSettings {
    fn default() -> Self {
        Self {
            web: NonZeroU16::new(DEFAULT_WEB_PORT).expect("default port must be positive"),
        }
    }
}

impl Default for LimitSettings {
    fn default() -> Self {
        Self {
            max_file_size_bytes: NonZeroUsize::new(DEFAULT_MAX_FILE_SIZE_BYTES)
                .expect("default must be positive"),
            max_read_file_size_bytes: NonZeroUsize::new(DEFAULT_MAX_READ_FILE_SIZE_BYTES)
                .expect("default must be positive"),
            max_search_line_length: NonZeroUsize::new(DEFAULT_MAX_SEARCH_LINE_LENGTH)
                .expect("default must be positive"),
            command_timeout_ms: NonZeroU64::new(DEFAULT_COMMAND_TIMEOUT_MS)
                .expect("default must be positive"),
            action_max_runtime_ms: NonZeroU64::new(20 * 60 * 1000)
                .expect("default must be positive"),
            command_output_limit_bytes: NonZeroUsize::new(DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES)
                .expect("default must be positive"),
            tree_max_results: NonZeroUsize::new(DEFAULT_TREE_MAX_RESULTS)
                .expect("default must be positive"),
            connection_payload_retention_days: NonZeroI64::new(90)
                .expect("default must be positive"),
        }
    }
}

/// Replace explicit `0` values for NonZero fields with defaults before
/// deserialization, so old configs fail forward instead of failing to boot.
fn migrate_zeros(value: &mut serde_json::Value) {
    let defaults = Settings::default();
    let default_value = serde_json::to_value(&defaults).expect("defaults serialize");
    fn fix_zero(target: &mut serde_json::Value, fallback: &serde_json::Value) {
        match (target, fallback) {
            (serde_json::Value::Number(n), _) => {
                if n.as_u64() == Some(0) || n.as_i64() == Some(0) {
                    *n = fallback
                        .as_number()
                        .cloned()
                        .unwrap_or_else(|| serde_json::Number::from(1));
                }
            }
            (serde_json::Value::Object(map), serde_json::Value::Object(fallback_map)) => {
                for (k, v) in map.iter_mut() {
                    if let Some(f) = fallback_map.get(k) {
                        fix_zero(v, f);
                    }
                }
            }
            _ => {}
        }
    }
    fix_zero(value, &default_value);
}
