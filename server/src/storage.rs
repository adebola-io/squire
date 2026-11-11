use crate::util;
use anyhow::Result;
use std::{
    env,
    path::{Path, PathBuf},
};

macro_rules! path_methods {
    ($($name:ident => $path:literal),* $(,)?) => {
        $(pub fn $name(&self) -> PathBuf {
            self.squire_home.join($path)
        })*
    };
}

#[derive(Clone)]
pub struct StoragePaths {
    pub squire_home: PathBuf,
}

impl StoragePaths {
    pub fn resolve() -> Result<Self> {
        let squire_home = match env::var_os("SQUIRE_HOME") {
            Some(path) => PathBuf::from(path),
            None => util::home_dir()?.join(".squire"),
        };
        Ok(Self { squire_home })
    }

    pub fn from_home(squire_home: PathBuf) -> Self {
        Self { squire_home }
    }

    path_methods! {
        settings => "settings.json",
        db => "squire.db",
        blobs_dir => "blobs",
        attachments_dir => "attachments",
        plugins_dir => "plugins",
        log_dir => "logs",
    }

    pub fn plugin_dir(&self, plugin_id: impl AsRef<Path>) -> PathBuf {
        self.plugins_dir().join(plugin_id)
    }

    pub fn plugin_data_dir(&self, plugin_id: impl AsRef<Path>) -> PathBuf {
        self.squire_home.join("plugin-data").join(plugin_id)
    }
}
