use crate::epoch::EpochTicker;
use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;
use std::{collections::HashMap, path::Path, sync::Mutex, time::Instant};
use tokio_util::sync::CancellationToken;
use wasmtime::{
    component::{Component, Linker},
    Config, Engine, Store, StoreLimits, StoreLimitsBuilder,
};

wasmtime::component::bindgen!({
    path: "../wit/squire-mcp-transform.wit",
    world: "transformer",
});

pub use exports::squire::mcp_transform::transform::TransformInput;

const MAX_MEMORY_BYTES: usize = 64 * 1024 * 1024;
const MAX_TABLE_ELEMENTS: usize = 10_000;
const MAX_INSTANCES: usize = 8;
const MAX_MEMORIES: usize = 2;
const MAX_TABLES: usize = 2;

pub struct TransformState {
    limits: StoreLimits,
    deadline: Instant,
    cancellation: CancellationToken,
}

/// A compiled and linked transform, ready to instantiate.
pub type TransformComponent = TransformerPre<TransformState>;

pub struct McpTransformRuntime {
    engine: Engine,
    linker: Linker<TransformState>,
    components: Mutex<HashMap<String, TransformComponent>>,
    epoch: EpochTicker,
}

impl McpTransformRuntime {
    pub fn new() -> Result<Self> {
        let mut config = Config::new();
        config.epoch_interruption(true);
        let engine = Engine::new(&config)
            .map_err(|error| anyhow!("failed to create MCP transform engine: {error}"))?;
        let linker = Linker::new(&engine);
        let epoch = EpochTicker::new(engine.clone());
        Ok(Self {
            engine,
            linker,
            components: Mutex::new(HashMap::new()),
            epoch,
        })
    }

    /// Compiles and links a transform, rejecting components that import host
    /// capabilities or do not export the transform interface.
    pub fn compile(&self, path: &Path) -> Result<TransformComponent> {
        let component = Component::from_file(&self.engine, path).map_err(|error| {
            anyhow!(
                "{} is not a valid MCP transform component: {error}",
                path.display()
            )
        })?;
        let instance_pre = self.linker.instantiate_pre(&component).map_err(|error| {
            anyhow!("MCP transform imports capabilities or has an incompatible interface: {error}")
        })?;
        TransformerPre::new(instance_pre)
            .map_err(|error| anyhow!("MCP transform has incompatible exports: {error}"))
    }

    /// Caches an installed Plugin's compiled transform.
    pub fn insert(&self, plugin_id: &str, component: TransformComponent) {
        self.components
            .lock()
            .unwrap()
            .insert(plugin_id.to_string(), component);
    }

    pub fn evict(&self, plugin_id: &str) {
        self.components.lock().unwrap().remove(plugin_id);
    }

    /// Runs the transform and returns the parsed structured content together
    /// with the attachment indices it selected.
    pub fn invoke_blocking(
        &self,
        plugin_id: &str,
        path: &Path,
        input: TransformInput,
        deadline: Instant,
        cancellation: CancellationToken,
    ) -> Result<(Value, Vec<u32>)> {
        let component = self.component(plugin_id, path)?;
        let _active = self.epoch.begin();
        let limits = StoreLimitsBuilder::new()
            .memory_size(MAX_MEMORY_BYTES)
            .table_elements(MAX_TABLE_ELEMENTS)
            .instances(MAX_INSTANCES)
            .memories(MAX_MEMORIES)
            .tables(MAX_TABLES)
            .build();
        let mut store = Store::new(
            &self.engine,
            TransformState {
                limits,
                deadline,
                cancellation,
            },
        );
        store.limiter(|state| &mut state.limits);
        store.set_epoch_deadline(1);
        store.epoch_deadline_callback(|store| {
            if store.data().cancellation.is_cancelled() {
                return Err(wasmtime::Error::msg("invocation cancelled"));
            }
            if Instant::now() >= store.data().deadline {
                return Err(wasmtime::Error::msg("invocation deadline expired"));
            }
            Ok(wasmtime::UpdateDeadline::Continue(1))
        });
        let bindings = component
            .instantiate(&mut store)
            .map_err(|error| anyhow!("failed to instantiate MCP transform component: {error}"))?;
        let output = bindings
            .squire_mcp_transform_transform()
            .call_transform(&mut store, &input)
            .map_err(|error| anyhow!("MCP transform invocation failed: {error}"))?
            .map_err(anyhow::Error::msg)?;
        let structured_content: Value = serde_json::from_str(&output.structured_json)
            .context("MCP transform returned invalid structured JSON")?;
        if !structured_content.is_object() {
            bail!("MCP transform structured JSON must be an object");
        }
        if let Some(index) = output
            .attachments
            .iter()
            .find(|index| **index as usize >= input.attachments.len())
        {
            bail!("MCP transform returned unknown attachment index {index}");
        }
        Ok((structured_content, output.attachments))
    }

    fn component(&self, plugin_id: &str, path: &Path) -> Result<TransformComponent> {
        if let Some(component) = self.components.lock().unwrap().get(plugin_id).cloned() {
            return Ok(component);
        }
        let component = self.compile(path)?;
        self.insert(plugin_id, component.clone());
        Ok(component)
    }
}
