use crate::{settings::Settings, storage::StoragePaths};
use anyhow::{ensure, Context, Result};
use std::{env, ffi::OsString};
#[cfg(unix)]
use std::{
    ffi::OsStr,
    os::unix::ffi::OsStringExt,
    os::unix::process::CommandExt,
    process::{Command, Stdio},
};
use url::Url;

#[derive(Clone)]
pub struct Config {
    /// The passwordless local web listener, Squire's only listener.
    pub web_port: u16,
    /// `allowedHosts` from the settings, as bare lowercase host names.
    pub allowed_hosts: Vec<String>,
    pub settings: Settings,
    pub storage: StoragePaths,
    pub command_path: OsString,
    /// The hosted Squire service: account linking, titles, web search and
    /// the marketplace.
    pub service_url: Url,
}

/// Hosted service origin. Unset means the public service.
pub const SERVICE_URL_VAR: &str = "SQUIRE_SERVICE_URL";
const DEFAULT_SERVICE_URL: &str = "https://use-squire.com";

/// Resolves the hosted service from an environment lookup. Sessions and
/// packages travel over it, so plain HTTP is accepted only for this machine.
pub fn service_url(var: impl Fn(&str) -> Option<String>) -> Result<Url> {
    let value = var(SERVICE_URL_VAR).unwrap_or_else(|| DEFAULT_SERVICE_URL.to_owned());
    let url = Url::parse(&value).with_context(|| format!("{SERVICE_URL_VAR} is not a URL"))?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    ensure!(
        url.scheme() == "https" || (url.scheme() == "http" && loopback),
        "{SERVICE_URL_VAR} must use https (plain http only for localhost)"
    );
    Ok(url)
}

impl Config {
    pub fn load() -> Result<Self> {
        let storage = StoragePaths::resolve()?;
        let mut config = Self::load_from_storage(storage)?;
        if let Some(path) = login_shell_path() {
            config.command_path = path;
        }
        Ok(config)
    }

    pub fn load_from_storage(storage: StoragePaths) -> Result<Self> {
        let settings = Settings::load(&storage)?;
        settings.validate()?;
        Ok(Self {
            service_url: service_url(|name| env::var(name).ok())?,
            web_port: settings.ports.web.get(),
            allowed_hosts: settings
                .allowed_hosts
                .iter()
                .filter_map(|entry| normalize_host(entry))
                .collect(),
            settings,
            storage,
            command_path: env::var_os("PATH").unwrap_or_default(),
        })
    }
}

/// An `allowedHosts` entry as a bare lowercase host name, so a pasted address
/// (`https://workstation.example.com:4296/`) works as well as the name itself.
fn normalize_host(entry: &str) -> Option<String> {
    let entry = entry.trim();
    let url = if entry.contains("://") {
        Url::parse(entry)
    } else {
        Url::parse(&format!("http://{entry}"))
    }
    .ok()?;
    let host = url.host_str()?.trim_matches(|c| c == '[' || c == ']');
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

#[cfg(unix)]
fn login_shell_path() -> Option<OsString> {
    login_shell_path_from(&env::var_os("SHELL")?)
}

#[cfg(unix)]
fn login_shell_path_from(shell: &OsStr) -> Option<OsString> {
    let mut command = Command::new(shell);
    command
        .args(["-l", "-i", "-c", "env"])
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    // The interactive shell can take the terminal's foreground process group.
    // Give it a separate session so Ctrl+C still reaches Squire after it exits.
    // SAFETY: setsid is async-signal-safe and runs in the child before exec.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }

    output
        .stdout
        .split(|byte| *byte == b'\n')
        .filter_map(|line| line.strip_prefix(b"PATH="))
        .next_back()
        .filter(|path| !path.is_empty())
        .map(|path| OsString::from_vec(path.to_vec()))
}

#[cfg(not(unix))]
fn login_shell_path() -> Option<OsString> {
    None
}
