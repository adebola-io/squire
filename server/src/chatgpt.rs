//! ChatGPT subscription authentication is owned by Rig Core.
//! Squire only manages the connection UI and invokes the authenticated client.
use crate::providers::{
    rig::RigProvider,
    types::{ModelProvider, ModelRequest, ModelStream},
    wire,
};
use anyhow::{ensure, Context, Result};
use async_trait::async_trait;
use rig_core::providers::chatgpt::auth::{AuthSource, Authenticator, DeviceCodeHandler};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::{sync::Mutex as AsyncMutex, task::JoinHandle};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub pending: bool,
    pub error: Option<String>,
    pub connected: bool,
    pub verification_uri: Option<String>,
    pub user_code: Option<String>,
}

#[derive(Deserialize)]
struct ChatGPTModelCatalog {
    models: Vec<ChatGPTModel>,
}

#[derive(Deserialize)]
struct ChatGPTModel {
    slug: String,
    visibility: Option<String>,
}

pub struct Manager {
    auth_file: PathBuf,
    login_file: PathBuf,
    login_auth: Authenticator,
    token_auth: Authenticator,
    status: Arc<Mutex<Status>>,
    login_task: Mutex<Option<JoinHandle<()>>>,
    credential_access: AsyncMutex<()>,
}

impl Manager {
    pub fn new(auth_file: PathBuf) -> Result<Arc<Self>> {
        let parent = auth_file
            .parent()
            .context("ChatGPT credential directory is missing")?;
        fs::create_dir_all(parent)?;
        #[cfg(unix)]
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;

        let login_file = auth_file.with_extension("pending.json");
        let status = Arc::new(Mutex::new(Status::default()));
        let callback_status = status.clone();
        let callback = DeviceCodeHandler::new(move |prompt| {
            let mut current = callback_status.lock().unwrap();
            current.verification_uri = Some(prompt.verification_uri);
            current.user_code = Some(prompt.user_code);
        });

        Ok(Arc::new(Self {
            login_auth: Authenticator::new(
                AuthSource::OAuth,
                Some(login_file.clone()),
                callback,
                true,
            ),
            token_auth: Authenticator::new(
                AuthSource::OAuth,
                Some(auth_file.clone()),
                DeviceCodeHandler::default(),
                false,
            ),
            auth_file,
            login_file,
            status,
            login_task: Mutex::new(None),
            credential_access: AsyncMutex::new(()),
        }))
    }

    pub fn configured(&self) -> bool {
        self.auth_file.is_file()
    }

    pub fn status(&self) -> Status {
        let mut status = self.status.lock().unwrap().clone();
        status.connected = self.configured();
        status
    }

    pub fn start(self: &Arc<Self>) -> Result<()> {
        {
            let mut status = self.status.lock().unwrap();
            ensure!(!status.pending, "ChatGPT sign-in is already in progress");
            ensure!(
                !self.configured(),
                "Sign out before connecting another ChatGPT account"
            );
            status.pending = true;
            status.error = None;
            status.verification_uri = None;
            status.user_code = None;
        }
        // The SDK owns the record; Squire only gives it an owner-only
        // temporary file that is promoted after successful authorization.
        let prepared = (|| -> Result<()> {
            let mut options = OpenOptions::new();
            options.create(true).write(true).truncate(true);
            #[cfg(unix)]
            options.mode(0o600);
            let mut file = options.open(&self.login_file)?;
            file.write_all(b"{}")?;
            Ok(())
        })();
        if let Err(error) = prepared {
            self.status.lock().unwrap().pending = false;
            return Err(error);
        }
        let manager = self.clone();
        let task = tokio::spawn(async move {
            let result = async {
                let _access = manager.credential_access.lock().await;
                let http = rig_reqwest::ReqwestClient::from(wire::client()?);
                manager.login_auth.auth_context(&http).await?;
                fs::rename(&manager.login_file, &manager.auth_file)?;
                Ok::<(), anyhow::Error>(())
            }
            .await;
            let mut status = manager.status.lock().unwrap();
            status.pending = false;
            status.error = result.err().map(|error| format!("{error:#}"));
            if status.error.is_some() {
                let _ = fs::remove_file(&manager.login_file);
            }
            status.verification_uri = None;
            status.user_code = None;
        });
        *self.login_task.lock().unwrap() = Some(task);
        Ok(())
    }

    pub async fn sign_out(&self) -> Result<()> {
        if let Some(task) = self.login_task.lock().unwrap().take() {
            task.abort();
        }
        let _access = self.credential_access.lock().await;
        for file in [&self.auth_file, &self.login_file] {
            match fs::remove_file(file) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        *self.status.lock().unwrap() = Status::default();
        Ok(())
    }

    pub async fn auth_context(&self) -> Result<rig_core::providers::chatgpt::auth::AuthContext> {
        let _access = self.credential_access.lock().await;
        let http = rig_reqwest::ReqwestClient::from(wire::client()?);
        Ok(self.token_auth.auth_context(&http).await?)
    }

    pub async fn model_ids(&self) -> Result<Vec<String>> {
        // Rig 0.44.0's model listing assumes OpenAI's /models response.
        // The ChatGPT subscription catalog requires client_version and returns
        // { models: [{ slug, visibility }] } instead.
        let context = self.auth_context().await?;
        let mut request = wire::client()?
            .get("https://chatgpt.com/backend-api/codex/models?client_version=1.0.0")
            .bearer_auth(context.access_token.expose())
            .header("originator", "rig");
        if let Some(account_id) = context.account_id.as_deref() {
            request = request.header("ChatGPT-Account-Id", account_id);
        }
        let catalog = request
            .send()
            .await?
            .error_for_status()?
            .json::<ChatGPTModelCatalog>()
            .await?;
        let mut ids: Vec<String> = catalog
            .models
            .into_iter()
            .filter(|model| model.visibility.as_deref() == Some("list"))
            .map(|model| model.slug)
            .collect();
        ids.sort();
        ids.dedup();
        Ok(ids)
    }
}

pub struct ChatGPTProvider {
    auth: Arc<Manager>,
}

impl ChatGPTProvider {
    pub fn new(auth: Arc<Manager>) -> Self {
        Self { auth }
    }
}

#[async_trait]
impl ModelProvider for ChatGPTProvider {
    async fn list_models(&self) -> Result<Vec<String>> {
        self.auth.model_ids().await
    }

    async fn stream(
        &self,
        request: ModelRequest,
        cancel: CancellationToken,
    ) -> Result<ModelStream> {
        let context = self.auth.auth_context().await?;
        RigProvider::new(
            "https://chatgpt.com/backend-api/codex",
            Some(context.access_token.expose().to_owned()),
            "chatgpt",
            None,
        )?
        .with_chatgpt_account_id(context.account_id)
        .stream(request, cancel)
        .await
    }
}
