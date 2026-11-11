use crate::{
    account, agent, config::Config, connections, conversations, marketplace,
    marketplace_operations, mcp_runtime, mcp_transform, plugins, providers::ProviderRegistry,
    remote, roots, wasm,
};
use anyhow::Result;
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex, RwLock},
};
use tokio::sync::broadcast;

type Shared<T> = Arc<Mutex<T>>;

fn shared<T>(value: T) -> Shared<T> {
    Arc::new(Mutex::new(value))
}

const DESKTOP_EVENT_CAPACITY: usize = 256;

static ACTIVITY_EVENT: LazyLock<Arc<str>> = LazyLock::new(|| Arc::from(r#"{"type":"activity"}"#));
static RESYNC_EVENT: LazyLock<Arc<str>> = LazyLock::new(|| Arc::from(r#"{"type":"resync"}"#));
static PLUGINS_CHANGED_EVENT: LazyLock<Arc<str>> =
    LazyLock::new(|| Arc::from(r#"{"type":"plugins.changed"}"#));

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub settings_write_lock: Shared<()>,
    pub desktop_events: broadcast::Sender<Arc<str>>,
    /// Serializes Plugin index mutations.
    pub plugins: Shared<()>,
    pub plugin_catalog: Arc<RwLock<Option<Arc<plugins::PluginCatalog>>>>,
    pub plugin_credentials: Arc<plugins::PluginCredentials>,
    pub roots: Arc<RwLock<Option<Arc<roots::RootSet>>>>,
    pub store: Arc<crate::store::Store>,
    pub account: Arc<account::AccountManager>,
    pub remote: Arc<remote::Manager>,
    /// Revisions and live activity behind Conversation events.
    pub conversation_live: Arc<conversations::events::LiveState>,
    pub agent: Arc<agent::AgentRuntime>,
    pub jobs: Arc<crate::jobs::JobManager>,
    pub marketplace_operations: Arc<marketplace_operations::Operations>,
    pub marketplace_catalog: Arc<RwLock<marketplace::CatalogState>>,
    pub marketplace_client: reqwest::Client,
    /// Public-web egress for native tools such as page fetching.
    pub web_client: crate::wasm_network::NetworkClient,
    pub browser: Arc<crate::browser::BrowserService>,
    pub(crate) mcp_candidates: Arc<Mutex<HashMap<String, plugins::McpCandidate>>>,
    pub mcp_runtime: Arc<mcp_runtime::McpRuntime>,
    pub mcp_transform: Arc<mcp_transform::McpTransformRuntime>,
    pub wasm: Arc<wasm::WasmRuntime>,
    pub title_jobs: Arc<crate::auto_title::TitleJobs>,
}

impl AppState {
    /// Tells desktop clients that activity in `thread_id` changed.
    pub fn emit_thread_activity(&self, thread_id: &str) {
        if self.desktop_events.receiver_count() > 0 {
            let event = json!({ "type": "activity", "threadId": thread_id }).to_string();
            let _ = self.desktop_events.send(Arc::from(event));
        }
    }

    /// An installed plugin was added or replaced; desktop views reload the local index.
    pub fn emit_plugins_changed(&self) {
        if self.desktop_events.receiver_count() > 0 {
            let _ = self.desktop_events.send(PLUGINS_CHANGED_EVENT.clone());
        }
    }

    /// Events a lagging desktop client needs to fully resynchronize.
    pub fn resync_events() -> [Arc<str>; 6] {
        [
            ACTIVITY_EVENT.clone(),
            RESYNC_EVENT.clone(),
            account::ACCOUNT_EVENT.clone(),
            PLUGINS_CHANGED_EVENT.clone(),
            remote::manager::REMOTE_EVENT.clone(),
            Arc::from(r#"{"type":"browser.tabs.changed"}"#),
        ]
    }

    pub fn new() -> Result<Self> {
        Self::from_config(Config::load()?)
    }

    pub fn from_config(config: Config) -> Result<Self> {
        let (desktop_events, _) = broadcast::channel(DESKTOP_EVENT_CAPACITY);
        crate::logging::init(&config.storage.squire_home);
        let store = Arc::new(crate::store::Store::open(&config.storage)?);
        let providers = ProviderRegistry::from_store(store.clone())?;
        let account = Arc::new(account::AccountManager::new(
            store.clone(),
            config.service_url.clone(),
            desktop_events.clone(),
        )?);
        let remote = Arc::new(remote::Manager::new(
            store.clone(),
            account.clone(),
            desktop_events.clone(),
        )?);
        let component_cache = config.storage.squire_home.join("cache").join("components");
        let browser = Arc::new(crate::browser::BrowserService::new(
            config.storage.squire_home.clone(),
            config.command_path.clone(),
            store.clone(),
            desktop_events.clone(),
        ));
        let marketplace_cached = marketplace::load_cached(&config.storage.squire_home);
        let state = Self {
            config: Arc::new(config),
            settings_write_lock: shared(()),
            marketplace_operations: Arc::new(marketplace_operations::Operations::new(
                desktop_events.clone(),
            )),
            marketplace_catalog: Arc::new(RwLock::new(marketplace::CatalogState {
                catalog: marketplace_cached.map(Arc::new),
                etag: None,
                error: false,
            })),
            marketplace_client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            web_client: crate::wasm_network::NetworkClient::new(
                crate::wasm_network::NetworkPolicy::PublicWeb,
                crate::wasm::EGRESS_PROFILE,
            )?,
            desktop_events,
            plugins: shared(()),
            plugin_catalog: Arc::new(RwLock::new(None)),
            plugin_credentials: Arc::new(plugins::PluginCredentials::default()),
            roots: Arc::new(RwLock::new(None)),
            store,
            account,
            remote: remote.clone(),
            conversation_live: Arc::new(conversations::events::LiveState::default()),
            agent: Arc::new(agent::AgentRuntime::new(providers)),
            jobs: Arc::new(crate::jobs::JobManager::default()),
            browser,
            mcp_candidates: Arc::new(Mutex::new(HashMap::new())),
            mcp_runtime: Arc::new(mcp_runtime::McpRuntime::default()),
            mcp_transform: Arc::new(mcp_transform::McpTransformRuntime::new()?),
            wasm: Arc::new(wasm::WasmRuntime::new(component_cache)?),
            title_jobs: Arc::default(),
        };
        connections::interrupt_running(&state)?;
        conversations::interrupt_running(&state)?;
        remote.attach(state.clone());
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let store = Arc::downgrade(&state.store);
            let retention = state
                .config
                .settings
                .limits
                .connection_payload_retention_days
                .get();
            runtime.spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
                loop {
                    interval.tick().await;
                    let Some(store) = store.upgrade() else { break };
                    if let Err(error) = store.maintain(retention).await {
                        tracing::error!("Store maintenance failed: {error:#}");
                    }
                }
            });
        }
        Ok(state)
    }
}
