//! Identity of this running Squire installation with hosted Squire services.
//! This is distinct from device-local MCP OAuth and the local Squire MCP OAuth password.
//!
//! Linking uses the OAuth device authorization grant (RFC 8628) served by
//! Better Auth on use-squire.com: Squire asks for a code, the user approves it
//! in the browser, and Squire receives a session token it sends as a bearer
//! token to hosted services.
use crate::store::Store;
use anyhow::{bail, Context, Result};
use reqwest::{Client, Response, StatusCode};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fmt,
    sync::{Arc, LazyLock},
    time::Duration,
};
use tokio::sync::{broadcast, Mutex};
use tokio_util::sync::CancellationToken;
use url::Url;

const SESSION_TOKEN: &str = "installation:session_token";
/// The device-flow client the hosted service accepts from Squire.
const CLIENT_ID: &str = "squire-desktop";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
const EXPIRED_MESSAGE: &str = "It wasn't approved in time. Start again for a new link.";
const REVOKED_MESSAGE: &str =
    "This installation's access was revoked from your Squire account. Connect again to restore it.";

/// Desktop event telling clients to re-read `/desktop/account`.
pub(crate) static ACCOUNT_EVENT: LazyLock<Arc<str>> =
    LazyLock::new(|| Arc::from(r#"{"type":"account"}"#));

/// The hosted service no longer recognises this installation. Its local
/// identity has already been removed when this error is returned.
#[derive(Debug)]
pub struct Revoked;

impl fmt::Display for Revoked {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(REVOKED_MESSAGE)
    }
}

impl std::error::Error for Revoked {}

#[derive(Clone)]
pub struct AccountManager {
    store: Arc<Store>,
    client: Client,
    origin: Url,
    events: broadcast::Sender<Arc<str>>,
    pending: Arc<Mutex<Option<PendingLink>>>,
    /// Set when the hosted service revoked this installation, until the user
    /// connects again or dismisses it. In memory: a restart shows the plain
    /// disconnected state, which is still accurate.
    revoked: Arc<Mutex<bool>>,
}

struct PendingLink {
    device_code: String,
    user_code: String,
    approval_url: String,
    expires_at: i64,
    cancel: CancellationToken,
    outcome: Option<Outcome>,
}

/// How a link attempt ended without connecting.
#[derive(Clone)]
struct Outcome {
    state: &'static str,
    message: String,
}

impl Outcome {
    fn failed(message: impl Into<String>) -> Self {
        Self {
            state: "failed",
            message: message.into(),
        }
    }

    fn expired() -> Self {
        Self {
            state: "expired",
            message: EXPIRED_MESSAGE.to_string(),
        }
    }
}

struct Installation {
    /// The hosted session's id.
    id: String,
    token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub(crate) state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    installation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    account_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    approval_url: Option<String>,
    /// The code the approval page shows, for the user to compare.
    #[serde(skip_serializing_if = "Option::is_none")]
    user_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl AccountStatus {
    fn bare(state: &'static str) -> Self {
        Self {
            state,
            installation_id: None,
            account_id: None,
            approval_url: None,
            user_code: None,
            expires_at: None,
            error: None,
        }
    }
}

/// Who this installation is connected as, read live from the hosted service.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfile {
    pub(crate) name: String,
    given_name: Option<String>,
    pub(crate) email: String,
    /// The account picture's URL (the Google photo), when there is one.
    image: Option<String>,
    device_name: String,
    os: String,
    connected_at: i64,
    manage_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectResult {
    pub revoked_remotely: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Deserialize)]
struct DeviceCode {
    device_code: String,
    user_code: String,
    verification_uri_complete: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize)]
struct DeviceToken {
    access_token: String,
}

/// RFC 8628 token-endpoint errors (`authorization_pending`, `slow_down`, ...).
#[derive(Deserialize)]
struct DeviceError {
    error: String,
    error_description: Option<String>,
}

#[derive(Deserialize)]
struct HostedSession {
    session: SessionInfo,
    user: UserInfo,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    id: String,
    created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserInfo {
    id: String,
    name: String,
    /// The part of the name to greet by, from Google; absent for other sign-ups.
    given_name: Option<String>,
    email: String,
    image: Option<String>,
}

impl AccountManager {
    /// `origin` is the configured hosted service (`Config::service_url`),
    /// never inferred from a tunnel URL.
    pub fn new(
        store: Arc<Store>,
        origin: Url,
        events: broadcast::Sender<Arc<str>>,
    ) -> Result<Self> {
        let client = Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            store,
            client,
            origin,
            events,
            pending: Arc::new(Mutex::new(None)),
            revoked: Arc::new(Mutex::new(false)),
        })
    }

    /// Authenticated JSON request to a Squire-hosted service. A refused
    /// session means the installation was revoked.
    pub(crate) async fn post_hosted_json<T: Serialize + ?Sized>(
        &self,
        path: &str,
        payload: &T,
    ) -> Result<Response> {
        let installation = self.connected()?;
        let response = self
            .client
            .post(self.endpoint(path)?)
            .bearer_auth(&installation.token)
            .json(payload)
            .send()
            .await?;
        if response.status() == StatusCode::UNAUTHORIZED {
            self.mark_revoked(&installation.id).await?;
            return Err(Revoked.into());
        }
        Ok(response)
    }

    /// Resolve endpoints on the configured hosted service, shared by account and marketplace.
    pub(crate) fn endpoint(&self, path: &str) -> Result<Url> {
        self.origin
            .join(path)
            .context("invalid hosted service path")
    }

    /// The hosted service's name as people see it in their browser.
    fn site(&self) -> &str {
        self.origin.host_str().unwrap_or("the Squire website")
    }

    /// Tells desktop clients the account status changed, so none of them
    /// has to poll for approval progress.
    fn emit(&self) {
        if self.events.receiver_count() > 0 {
            let _ = self.events.send(ACCOUNT_EVENT.clone());
        }
    }

    /// The linked installation and its account id, if any.
    fn installation(&self) -> Result<Option<(Installation, Option<String>)>> {
        let row: Option<(String, Option<String>)> = self.store.read_blocking(|db| {
            Ok(db
                .query_row(
                    "SELECT installation_id, account_id FROM installation \
                     WHERE id = 1 AND installation_id IS NOT NULL AND secret_ref = ?1",
                    [SESSION_TOKEN],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?)
        })?;
        let Some((id, account_id)) = row else {
            return Ok(None);
        };
        let token = self
            .store
            .secrets
            .get(SESSION_TOKEN)?
            .context("Installation session token missing")?;
        Ok(Some((Installation { id, token }, account_id)))
    }

    fn connected(&self) -> Result<Installation> {
        Ok(self
            .installation()?
            .context("Connect this installation to a Squire account first")?
            .0)
    }

    /// The hosted service refused this installation's session outside an
    /// account request (the Remote Access socket, say). Treated exactly like a
    /// refused account request, so the next sign-in starts fresh.
    pub(crate) async fn session_refused(&self) -> Result<()> {
        let installation = self.connected()?;
        self.mark_revoked(&installation.id).await
    }

    pub async fn status(&self) -> Result<AccountStatus> {
        if let Some((installation, account_id)) = self.installation()? {
            return Ok(AccountStatus {
                installation_id: Some(installation.id),
                account_id,
                ..AccountStatus::bare("connected")
            });
        }
        {
            let pending = self.pending.lock().await;
            if let Some(value) = pending.as_ref() {
                // The poll loop records expiry on its next tick; report it
                // from the deadline itself so a status read is never stale.
                let outcome = value.outcome.clone().or_else(|| {
                    (value.expires_at <= chrono::Utc::now().timestamp()).then(Outcome::expired)
                });
                return Ok(match outcome {
                    Some(outcome) => AccountStatus {
                        error: Some(outcome.message),
                        ..AccountStatus::bare(outcome.state)
                    },
                    None => AccountStatus {
                        approval_url: Some(value.approval_url.clone()),
                        user_code: Some(value.user_code.clone()),
                        expires_at: Some(value.expires_at),
                        ..AccountStatus::bare("awaitingApproval")
                    },
                });
            }
        }
        if *self.revoked.lock().await {
            return Ok(AccountStatus {
                error: Some(REVOKED_MESSAGE.to_string()),
                ..AccountStatus::bare("revoked")
            });
        }
        Ok(AccountStatus::bare("disconnected"))
    }

    /// Starts one browser-approval flow. Repeated requests reuse the pending flow.
    pub async fn connect(&self) -> Result<AccountStatus> {
        let mut pending = self.pending.lock().await;
        if self.installation()?.is_some() {
            bail!("This installation is already connected");
        }
        if let Some(existing) = pending.as_ref() {
            if existing.outcome.is_none() && existing.expires_at > chrono::Utc::now().timestamp() {
                drop(pending);
                return self.status().await;
            }
            existing.cancel.cancel();
            *pending = None;
        }

        let response = self
            .client
            .post(self.endpoint("/api/auth/device/code")?)
            .json(&json!({ "client_id": CLIENT_ID }))
            .send()
            .await
            .context("Could not reach Squire authentication")?;
        let code: DeviceCode = response_json(response).await?;
        let approval_url =
            Url::parse(&code.verification_uri_complete).context("Invalid approval URL")?;
        if approval_url.origin() != self.origin.origin()
            || approval_url.path() != "/device"
            || code.expires_in == 0
            || code.expires_in > 1800
        {
            bail!("Untrusted Squire approval URL");
        }
        let cancel = CancellationToken::new();
        let expires_at = chrono::Utc::now().timestamp() + code.expires_in as i64;
        *pending = Some(PendingLink {
            device_code: code.device_code.clone(),
            user_code: code.user_code,
            approval_url: approval_url.to_string(),
            expires_at,
            cancel: cancel.clone(),
            outcome: None,
        });
        // A new attempt replaces any earlier revocation notice.
        *self.revoked.lock().await = false;
        drop(pending);
        self.emit();
        let manager = self.clone();
        let interval = Duration::from_secs(code.interval.max(1));
        tokio::spawn(async move {
            manager
                .poll_approval(code.device_code, interval, cancel, expires_at)
                .await;
        });
        self.status().await
    }

    /// Polls the token endpoint at the interval the service asks for until
    /// the user approves, denies, or the code expires.
    async fn poll_approval(
        &self,
        device_code: String,
        mut interval: Duration,
        cancel: CancellationToken,
        expires: i64,
    ) {
        let Ok(token_url) = self.endpoint("/api/auth/device/token") else {
            return;
        };
        // The account page lists this installation by its User-Agent.
        let agent = user_agent(&device_name().await);
        loop {
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = tokio::time::sleep(interval) => {},
            }
            if chrono::Utc::now().timestamp() >= expires {
                self.finish_pending(&device_code, Outcome::expired()).await;
                return;
            }
            let response = self
                .client
                .post(token_url.clone())
                .header(reqwest::header::USER_AGENT, &agent)
                .json(&json!({
                    "grant_type": DEVICE_GRANT,
                    "device_code": device_code,
                    "client_id": CLIENT_ID,
                }))
                .send()
                .await;
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    tracing::warn!("Squire approval poll failed: {error:#}");
                    continue;
                }
            };
            if response.status().is_success() {
                let result = match response.json::<DeviceToken>().await {
                    Ok(token) => self.link(&token.access_token, &cancel).await,
                    Err(error) => Err(error.into()),
                };
                if let Err(error) = result {
                    self.finish_pending(
                        &device_code,
                        Outcome::failed(format!(
                            "Approved, but this installation could not be saved: {error:#}"
                        )),
                    )
                    .await;
                }
                return;
            }
            if response.status().is_server_error() {
                tracing::warn!("Squire approval service returned {}", response.status());
                continue;
            }
            let status = response.status();
            let error = response.json::<DeviceError>().await.ok();
            let outcome = match error.as_ref().map(|e| e.error.as_str()) {
                Some("authorization_pending") => continue,
                Some("slow_down") => {
                    interval += Duration::from_secs(5);
                    continue;
                }
                Some("expired_token") => Outcome::expired(),
                Some("access_denied") => Outcome::failed(format!(
                    "The connection request was denied on {}.",
                    self.site()
                )),
                _ => Outcome::failed(format!(
                    "{} (HTTP {status})",
                    error
                        .and_then(|e| e.error_description)
                        .unwrap_or_else(|| "Squire could not approve this installation".into())
                )),
            };
            self.finish_pending(&device_code, outcome).await;
            return;
        }
    }

    /// Saves an approved session after confirming which session it is.
    async fn link(&self, token: &str, cancel: &CancellationToken) -> Result<()> {
        let session = self
            .read_session(token)
            .await?
            .context("Squire did not accept the new session")?;
        // Cancel can race an in-flight approval; never persist a cancelled link.
        let mut pending = self.pending.lock().await;
        if cancel.is_cancelled() {
            return Ok(());
        }
        let (id, account, token) = (session.session.id, session.user.id, token.to_string());
        self.store
            .write(move |tx| {
                tx.execute(
                    "INSERT INTO secrets(key,value) VALUES (?1,?2) \
                     ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    params![SESSION_TOKEN, token],
                )?;
                tx.execute(
                    "INSERT INTO installation(id,installation_id,account_id,public_key,secret_ref) \
                     VALUES (1,?1,?2,NULL,?3) ON CONFLICT(id) DO UPDATE SET \
                     installation_id=excluded.installation_id,account_id=excluded.account_id,\
                     public_key=NULL,secret_ref=excluded.secret_ref,lease=NULL,lease_expires_at=NULL,\
                     last_validated_at=NULL,plan=NULL,remote_endpoint_id=NULL,remote_enabled=0",
                    params![id, account, SESSION_TOKEN],
                )?;
                Ok(())
            })
            .await?;
        *pending = None;
        drop(pending);
        self.emit();
        Ok(())
    }

    async fn finish_pending(&self, device_code: &str, outcome: Outcome) {
        let mut pending = self.pending.lock().await;
        if let Some(current) = pending.as_mut().filter(|p| p.device_code == device_code) {
            current.outcome = Some(outcome);
            drop(pending);
            self.emit();
        }
    }

    /// The hosted session behind `token`, or `None` once it has ended.
    async fn read_session(&self, token: &str) -> Result<Option<HostedSession>> {
        let response = self
            .client
            .get(self.endpoint("/api/auth/get-session")?)
            .bearer_auth(token)
            .send()
            .await
            .context("Could not reach Squire")?;
        response_json(response).await
    }

    /// The session token this installation sends to hosted services. It stays
    /// in Rust and is never exposed to browser code.
    pub async fn access_token(&self) -> Result<String> {
        Ok(self.connected()?.token)
    }

    /// Reads the connected account from the hosted service. The check is
    /// authoritative: an ended or revoked session is detected here.
    pub async fn profile(&self) -> Result<AccountProfile> {
        let installation = self.connected()?;
        let Some(session) = self
            .read_session(&installation.token)
            .await?
            .filter(|session| session.session.id == installation.id)
        else {
            self.mark_revoked(&installation.id).await?;
            return Err(Revoked.into());
        };
        Ok(AccountProfile {
            name: session.user.name,
            given_name: session.user.given_name,
            email: session.user.email,
            image: session.user.image,
            device_name: device_name().await,
            os: std::env::consts::OS.to_string(),
            connected_at: session.session.created_at.timestamp(),
            manage_url: self.endpoint("/account")?.to_string(),
        })
    }

    /// Removes the local identity after the hosted service refused it. Only
    /// the installation that was refused is removed: a response that arrives
    /// after the user disconnected and connected again leaves the new one alone.
    async fn mark_revoked(&self, installation_id: &str) -> Result<()> {
        let id = installation_id.to_string();
        let removed = self
            .store
            .write(move |tx| {
                let removed = tx.execute(
                    "DELETE FROM installation WHERE id = 1 AND installation_id = ?1",
                    [&id],
                )?;
                if removed > 0 {
                    tx.execute("DELETE FROM secrets WHERE key = ?1", [SESSION_TOKEN])?;
                }
                Ok(removed > 0)
            })
            .await?;
        if removed {
            *self.revoked.lock().await = true;
            self.emit();
        }
        Ok(())
    }

    /// Cancels a pending link, signs out a connected installation, or
    /// dismisses a revocation notice. Every case ends disconnected.
    pub async fn disconnect(&self) -> Result<DisconnectResult> {
        let mut pending = self.pending.lock().await;
        if let Some(current) = pending.take() {
            current.cancel.cancel();
        }
        let mut warning = None;
        let mut revoked_remotely = false;
        if let Some((installation, _)) = self.installation()? {
            let response = self
                .client
                .post(self.endpoint("/api/auth/sign-out")?)
                .bearer_auth(&installation.token)
                .json(&json!({}))
                .send()
                .await;
            match response {
                Ok(response)
                    if response.status().is_success()
                        || response.status() == StatusCode::UNAUTHORIZED =>
                {
                    revoked_remotely = true
                }
                Ok(response) => warning = Some(format!(
                    "Disconnected here, but Squire returned HTTP {} when signing this installation out. Remove it from your account on {}.",
                    response.status(),
                    self.site()
                )),
                Err(_) => warning = Some(format!(
                    "Disconnected here, but Squire could not be reached to sign this installation out. Remove it from your account on {}.",
                    self.site()
                )),
            }
        }
        self.store
            .write(|tx| {
                tx.execute("DELETE FROM installation WHERE id = 1", [])?;
                tx.execute("DELETE FROM secrets WHERE key = ?1", [SESSION_TOKEN])?;
                Ok(())
            })
            .await?;
        *self.revoked.lock().await = false;
        drop(pending);
        self.emit();
        Ok(DisconnectResult {
            revoked_remotely,
            warning,
        })
    }
}

/// `Squire/<version> (<os>; <device name>)`, with the name percent-encoded so
/// any characters fit in a header. The account page parses this back.
fn user_agent(device_name: &str) -> String {
    let name = url::form_urlencoded::byte_serialize(device_name.as_bytes())
        .collect::<String>()
        .replace('+', "%20");
    format!(
        "Squire/{} ({}; {name})",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS
    )
}

/// The name the approval page and device list show for this computer: the
/// `deviceName` setting when set. On a Mac the network hostname is often just
/// the LAN address ("192.168.1.2"), which identifies nothing, so prefer the
/// Computer Name the user set. Android's hostname is `localhost` on every
/// phone, and apps cannot read the name set in its settings, so it is the
/// brand and model ("Samsung SM-N970U1").
pub(crate) async fn device_name() -> String {
    let configured = crate::storage::StoragePaths::resolve()
        .and_then(|paths| crate::settings::Settings::load(&paths))
        .ok()
        .and_then(|settings| settings.device_name)
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty());
    if let Some(name) = configured {
        return name;
    }
    #[cfg(target_os = "android")]
    if let Some(name) = crate::remote::device_identity::android_device_name().await {
        return name;
    }
    #[cfg(target_os = "macos")]
    {
        let named = tokio::process::Command::new("/usr/sbin/scutil")
            .args(["--get", "ComputerName"])
            .output()
            .await
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string());
        if let Some(name) = named.filter(|name| usable_device_name(name)) {
            return name;
        }
    }
    sysinfo::System::host_name()
        .map(|name| name.trim().trim_end_matches(".local").to_string())
        .filter(|name| usable_device_name(name))
        .unwrap_or_else(|| {
            match std::env::consts::OS {
                "macos" => "Mac",
                "windows" => "Windows PC",
                "linux" => "Linux computer",
                "android" => "Android device",
                _ => "Squire",
            }
            .to_string()
        })
}

fn usable_device_name(name: &str) -> bool {
    !name.is_empty() && name != "localhost" && name.parse::<std::net::IpAddr>().is_err()
}

/// The error text of a hosted JSON error body (`message` from Better Auth,
/// `error` from device-flow endpoints).
async fn error_message(response: Response) -> Option<String> {
    let body: serde_json::Value = serde_json::from_str(&response.text().await.ok()?).ok()?;
    ["message", "error_description", "error"]
        .iter()
        .find_map(|key| body.get(*key)?.as_str().map(ToOwned::to_owned))
}

async fn response_json<T: for<'de> Deserialize<'de>>(response: Response) -> Result<T> {
    let status = response.status();
    if !status.is_success() {
        let message = error_message(response)
            .await
            .unwrap_or_else(|| "Squire authentication request failed".to_string());
        bail!("{message} (HTTP {status})");
    }
    response
        .json()
        .await
        .context("Malformed Squire authentication response")
}
