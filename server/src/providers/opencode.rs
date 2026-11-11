//! OpenCode Zen and Go route models using models.dev's declared provider package.
//! Rig Core owns all four provider wire formats. A model without catalog
//! routing metadata is an explicit error, not a guessed protocol.

use super::catalog::ModelCatalog;
use super::rig::RigProvider;
use super::types::{ModelProvider, ModelRequest, ModelStream};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Wire {
    ChatCompletions,
    Responses,
    Messages,
    Gemini,
}

impl Wire {
    /// The format an AI SDK package speaks, as models.dev lists it.
    fn from_package(package: &str) -> Option<Self> {
        match package {
            "@ai-sdk/openai" => Some(Self::Responses),
            "@ai-sdk/anthropic" => Some(Self::Messages),
            "@ai-sdk/openai-compatible" => Some(Self::ChatCompletions),
            "@ai-sdk/google" => Some(Self::Gemini),
            _ => None,
        }
    }
}

pub struct OpenCodeProvider {
    chat: RigProvider,
    responses: RigProvider,
    messages: RigProvider,
    gemini: RigProvider,
    catalog: Arc<ModelCatalog>,
    catalog_kind: &'static str,
}

impl OpenCodeProvider {
    pub fn new(
        base_url: &str,
        api_key: Option<String>,
        session_header: Option<&str>,
        catalog: Option<Arc<ModelCatalog>>,
        catalog_kind: &'static str,
    ) -> Result<Self> {
        Ok(Self {
            chat: RigProvider::new(base_url, api_key.clone(), "chatCompletions", session_header)?
                .with_deepseek_gateway(),
            responses: RigProvider::new(base_url, api_key.clone(), "responses", session_header)?,
            gemini: RigProvider::new(base_url, api_key.clone(), "google", session_header)?
                .with_zen_gemini(),
            messages: RigProvider::new(base_url, api_key, "anthropic", session_header)?
                .with_model_catalog(catalog.clone(), catalog_kind),
            catalog: catalog.context("OpenCode requires model catalog routing metadata")?,
            catalog_kind,
        })
    }

    fn adapter(&self, wire: Wire) -> &dyn ModelProvider {
        match wire {
            Wire::ChatCompletions => &self.chat,
            Wire::Responses => &self.responses,
            Wire::Messages => &self.messages,
            Wire::Gemini => &self.gemini,
        }
    }

    fn route(&self, model: &str) -> Result<Wire> {
        let package = self
            .catalog
            .wire(self.catalog_kind, model)
            .with_context(|| {
                format!("No models.dev routing metadata for OpenCode model {model}")
            })?;
        Wire::from_package(&package).with_context(|| {
            format!("Unsupported models.dev package {package} for OpenCode model {model}")
        })
    }
}

#[async_trait]
impl ModelProvider for OpenCodeProvider {
    /// Only advertise models for which the catalog declares a supported
    /// protocol. Unknown routes cannot be sent through Rig without guessing.
    async fn list_models(&self) -> Result<Vec<String>> {
        if !self.catalog.has_wires(self.catalog_kind) {
            self.catalog.refresh().await?;
            anyhow::ensure!(
                self.catalog.has_wires(self.catalog_kind),
                "No model routing metadata for OpenCode {}",
                self.catalog_kind
            );
        }
        Ok(self
            .chat
            .list_models()
            .await?
            .into_iter()
            .filter(|model| self.route(model).is_ok())
            .collect())
    }

    async fn stream(
        &self,
        request: ModelRequest,
        cancel: CancellationToken,
    ) -> Result<ModelStream> {
        let wire = self.route(&request.model)?;
        self.adapter(wire).stream(request, cancel).await
    }
}
