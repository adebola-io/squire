use anyhow::{Context, Result};
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    env,
    ffi::OsStr,
    fs,
    io::Write as _,
    path::{Path, PathBuf},
};

/// A fieldless enum stored and serialized as fixed text, with the
/// `as_str`/`parse` pair that round-trips it through storage.
#[macro_export]
macro_rules! text_enum {
    ($(#[$meta:meta])* $vis:vis enum $name:ident {
        $($(#[$doc:meta])* $variant:ident = $text:literal,)+
    }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
        $vis enum $name {
            $($(#[$doc])* #[serde(rename = $text)] $variant,)+
        }

        impl $name {
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text,)+
                }
            }

            pub fn parse(value: &str) -> Option<Self> {
                match value {
                    $($text => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

pub fn arg_str<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value
        .get(name)
        .and_then(Value::as_str)
        .with_context(|| format!("Missing {name}"))
}

pub fn arg_usize(value: &Value, name: &str, default: usize) -> Result<usize> {
    match value.get(name) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Number(n)) => n
            .as_u64()
            .map(|v| v as usize)
            .with_context(|| format!("{name} must be a non-negative integer")),
        Some(_) => anyhow::bail!("{name} must be a non-negative integer"),
    }
}

pub fn bounded_text(value: &str, max_len: usize) -> Option<String> {
    let value = value
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(max_len)
        .collect::<String>();
    (!value.is_empty()).then_some(value)
}

/// The program to start for `program`, searched for on `path` (or Squire's
/// own PATH). Windows only finds `.exe` files by itself, so a command
/// installed as a `.cmd` or `.bat` shim, like npm, npx, pnpm and yarn, is
/// resolved to its full path here, trying PATHEXT in order as the shell does.
/// A path, or a name with an extension, is started as given.
pub fn resolve_program(program: &OsStr, path: Option<&OsStr>) -> PathBuf {
    #[cfg(windows)]
    if let Some(found) = find_on_path(program, path) {
        return found;
    }
    #[cfg(not(windows))]
    let _ = path;
    PathBuf::from(program)
}

#[cfg(windows)]
fn find_on_path(program: &OsStr, path: Option<&OsStr>) -> Option<PathBuf> {
    let name = Path::new(program);
    if name.components().count() != 1 || name.extension().is_some() {
        return None;
    }
    let extensions = env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let path = path
        .map(OsStr::to_os_string)
        .or_else(|| env::var_os("PATH"))?;
    env::split_paths(&path).find_map(|directory| {
        extensions
            .split(';')
            .filter(|extension| !extension.is_empty())
            .map(|extension| {
                let mut file = program.to_os_string();
                file.push(extension);
                directory.join(file)
            })
            .find(|candidate| candidate.is_file())
    })
}

/// Where Termux installs its packages: `$PREFIX`, which Termux sets in every
/// session, or its fixed location when Squire runs without it (a service).
#[cfg(any(target_os = "android", test))]
pub fn termux_prefix() -> PathBuf {
    env::var_os("PREFIX")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/data/data/com.termux/files/usr"))
}

/// Starts a console program without a console window of its own, which
/// Windows opens for it whenever Squire itself runs without one.
pub fn hide_console(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

pub fn home_dir() -> Result<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .context("Could not determine the home directory")
}

pub fn write_json(path: PathBuf, value: impl Serialize) -> Result<()> {
    let parent = path.parent().context("Missing parent")?;
    fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer_pretty(&mut temp, &value)?;
    temp.write_all(b"\n")?;
    temp.as_file().sync_all()?;
    match temp.persist(&path) {
        Ok(_) => {}
        Err(e) => {
            // Windows `persist` fails when the destination exists; remove and
            // retry once. The temp file is retained in `e.file` on failure.
            let temp = e.file;
            let _ = fs::remove_file(&path);
            temp.persist(&path)
                .map(|_| ())
                .map_err(|e| anyhow::anyhow!("persist {}: {}", path.display(), e))?;
            // Directory sync below still applies.
            if let Ok(dir) = fs::File::open(parent) {
                let _ = dir.sync_all();
            }
            return Ok(());
        }
    }
    // Best-effort directory sync so the rename survives a crash.
    if let Ok(dir) = fs::File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

/// Escapes the five characters that are unsafe in HTML text and quoted
/// attribute values, so server-rendered pages can embed dynamic strings.
pub fn html_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

pub fn json_error(status: StatusCode, error: impl ToString) -> Response {
    (status, Json(json!({ "error": error.to_string() }))).into_response()
}

/// Creates a credential directory and tightens permissions even when it
/// exists. On Windows that takes a separate `icacls` run, so it happens only
/// when the directory is created.
pub fn create_private_dir(path: &Path) -> Result<()> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        anyhow::bail!(
            "private data directory cannot be a symlink: {}",
            path.display()
        );
    }
    #[cfg(windows)]
    let existed = path.is_dir();
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder
        .create(path)
        .with_context(|| format!("failed to create {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    if !existed {
        let owner = format!("{}\\{}", env::var("USERDOMAIN")?, env::var("USERNAME")?);
        let mut command = std::process::Command::new("icacls.exe");
        hide_console(&mut command);
        let status = command
            .arg(path)
            .args(["/inheritance:r", "/grant:r", &format!("{owner}:(OI)(CI)F")])
            .status()?;
        anyhow::ensure!(
            status.success(),
            "failed to restrict data directory permissions"
        );
    }
    Ok(())
}
