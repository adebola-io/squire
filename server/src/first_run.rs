//! Defaults for a new installation: the user's Documents, Desktop and Downloads
//! folders become workspaces, and core plugins are installed from the marketplace
//! as ordinary managed installs, so they receive updates like any other.
//! Defaults are applied once; a workspace the user removes or a plugin they
//! uninstall is never restored.

use crate::{marketplace, plugins, roots, state::AppState};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use std::{collections::HashSet, time::Duration};

/// Integrations installed on first run.
const DEFAULT_PLUGINS: &[&str] = &["documents", "python", "git", "browser", "vision"];

/// Present once the defaults have been applied.
const APPLIED_KEY: &str = "first_run_defaults_applied";
/// JSON array of default plugin IDs not yet installed.
const PENDING_KEY: &str = "first_run_plugins_pending";
/// Only new installations receive onboarding; existing installations have no marker.
const ONBOARDING_KEY: &str = "onboarding_pending";

pub fn onboarding_pending(state: &AppState) -> Result<bool> {
    state.store.read_blocking(|db| {
        Ok(db
            .prepare("SELECT 1 FROM meta WHERE key = ?1")?
            .exists([ONBOARDING_KEY])?)
    })
}

pub fn complete_onboarding(state: &AppState) -> Result<()> {
    state.store.write_blocking(|tx| {
        tx.execute("DELETE FROM meta WHERE key = ?1", [ONBOARDING_KEY])?;
        Ok(())
    })
}

const RETRY_MIN: Duration = Duration::from_secs(30);
const RETRY_MAX: Duration = Duration::from_secs(10 * 60);

/// Applies the defaults on a new installation, then installs any default
/// plugins still pending in the background, retrying until the marketplace
/// is reachable.
pub fn start(state: &AppState) -> Result<()> {
    let applied = state.store.read_blocking(|db| {
        Ok(db
            .prepare("SELECT 1 FROM meta WHERE key = ?1")?
            .exists([APPLIED_KEY])?)
    })?;
    if !applied {
        add_default_workspaces(state);
        let pending = serde_json::to_string(DEFAULT_PLUGINS)?;
        state.store.write_blocking(move |tx| {
            tx.execute(
                "INSERT INTO meta(key, value) VALUES (?1, ?2)",
                params![PENDING_KEY, pending],
            )?;
            tx.execute(
                "INSERT INTO meta(key, value) VALUES (?1, '1')",
                [APPLIED_KEY],
            )?;
            tx.execute(
                "INSERT INTO meta(key, value) VALUES (?1, '1')",
                [ONBOARDING_KEY],
            )?;
            Ok(())
        })?;
    }
    if !state.store.read_blocking(|db| read_pending(db))?.is_empty() {
        tokio::spawn(install_pending(state.clone()));
    }
    Ok(())
}

/// Use OS-specific user folder locations, including redirected folders on
/// Windows and XDG user directories on Linux.
fn add_default_workspaces(state: &AppState) {
    for folder in [
        dirs::document_dir(),
        dirs::desktop_dir(),
        dirs::download_dir(),
    ]
    .into_iter()
    .flatten()
    .filter(|folder| folder.is_dir())
    {
        if let Err(error) = roots::add(state, &folder.to_string_lossy()) {
            tracing::warn!(%error, folder = %folder.display(), "Could not add a default workspace");
        }
    }
}

async fn install_pending(state: AppState) {
    let mut delay = RETRY_MIN;
    loop {
        match queue_pending(&state).await {
            Ok(true) => return,
            Ok(false) => {}
            Err(error) => tracing::warn!(%error, "Default plugins are not installed yet"),
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(RETRY_MAX);
    }
}

/// One pass: forgets defaults that are already installed or no longer
/// published, and queues the rest. Returns whether none remain.
async fn queue_pending(state: &AppState) -> Result<bool> {
    let installed: HashSet<String> = plugins::catalog(state)?
        .index
        .plugins
        .iter()
        .map(|plugin| plugin.id.clone())
        .collect();
    let (done, pending): (Vec<String>, Vec<String>) = state
        .store
        .read_blocking(|db| read_pending(db))?
        .into_iter()
        .partition(|id| installed.contains(id));
    remove_pending(state, done)?;
    if pending.is_empty() {
        return Ok(true);
    }

    let intents = marketplace::new_install_intents(state, &pending).await?;
    let unlisted: Vec<String> = pending
        .into_iter()
        .filter(|id| !intents.iter().any(|intent| intent.id() == id))
        .collect();
    if !unlisted.is_empty() {
        tracing::warn!(
            ?unlisted,
            "Default plugins are not published; skipping them"
        );
        remove_pending(state, unlisted)?;
    }
    for intent in intents {
        let id = intent.id().to_owned();
        let finished = id.clone();
        let queued = state.clone();
        let result = state
            .marketplace_operations
            .enqueue(id.clone(), move |context| async move {
                marketplace::change_wasm(queued.clone(), intent, context).await?;
                remove_pending(&queued, vec![finished])
            });
        if let Err(error) = result {
            // Already queued by an earlier pass, or Squire is shutting down.
            tracing::debug!(%error, integration = %id, "Default plugin not queued");
        }
    }
    Ok(false)
}

fn read_pending(db: &Connection) -> Result<Vec<String>> {
    let value: Option<String> = db
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            [PENDING_KEY],
            |row| row.get(0),
        )
        .optional()?;
    Ok(match value {
        Some(value) => serde_json::from_str(&value)?,
        None => Vec::new(),
    })
}

/// Drops `ids` from the pending list in one transaction, so concurrent
/// installs finishing never restore each other's entries.
fn remove_pending(state: &AppState, ids: Vec<String>) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    state.store.write_blocking(move |tx| {
        let mut pending = read_pending(tx)?;
        pending.retain(|id| !ids.contains(id));
        if pending.is_empty() {
            tx.execute("DELETE FROM meta WHERE key = ?1", [PENDING_KEY])?;
        } else {
            tx.execute(
                "UPDATE meta SET value = ?2 WHERE key = ?1",
                params![PENDING_KEY, serde_json::to_string(&pending)?],
            )?;
        }
        Ok(())
    })
}
