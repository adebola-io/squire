//! Windows paths across the WASM boundary.
//!
//! WASI resolves a path by matching its leading components against the names
//! of the preopened directories, splitting only at `/`. Each Windows drive is
//! preopened as `C:`, so a plugin sees `/C:/Users/me`: absolute to Rust's WASI
//! `Path`, resolved through that drive's preopen, and the form
//! `fs::canonicalize` itself returns there. Paths leaving a plugin (command
//! lines, attachments, results) drop that leading `/` again, giving
//! `C:/Users/me`, which Windows programs, the host and the agent all accept.
//! On other systems every function here returns its input unchanged.

use serde_json::Value;
use std::{borrow::Cow, path::Path};

/// A host path as the plugin sees it.
pub fn to_guest(path: &Path) -> String {
    let path = path.to_string_lossy();
    if cfg!(windows) {
        if let Some(guest) = drive_path_to_guest(&path) {
            return guest;
        }
    }
    path.into_owned()
}

/// Invocation arguments with every value that is a Windows path, such as one
/// the agent copied from a workspace root, in the plugin's form.
pub fn arguments_to_guest(arguments_json: &str) -> Cow<'_, str> {
    if !cfg!(windows) {
        return Cow::Borrowed(arguments_json);
    }
    let Ok(mut value) = serde_json::from_str::<Value>(arguments_json) else {
        return Cow::Borrowed(arguments_json);
    };
    map_strings(&mut value, &drive_path_to_guest);
    Cow::Owned(value.to_string())
}

/// Text leaving a plugin, with each path it holds in Windows form.
pub fn text_to_host(text: &str) -> Cow<'_, str> {
    if cfg!(windows) {
        strip_drive_roots(text)
    } else {
        Cow::Borrowed(text)
    }
}

/// [`text_to_host`] for every string in a JSON value.
pub fn json_to_host(value: &mut Value) {
    if cfg!(windows) {
        map_strings(value, &|text| match strip_drive_roots(text) {
            Cow::Owned(text) => Some(text),
            Cow::Borrowed(_) => None,
        });
    }
}

fn map_strings(value: &mut Value, convert: &impl Fn(&str) -> Option<String>) {
    match value {
        Value::String(text) => {
            if let Some(converted) = convert(text) {
                *text = converted;
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| map_strings(item, convert)),
        Value::Object(fields) => fields
            .values_mut()
            .for_each(|field| map_strings(field, convert)),
        _ => {}
    }
}

/// `C:\Users\me`, `c:/Users/me` or `\\?\C:\Users\me` as `/C:/Users/me`.
/// Anything else, including a path inside a longer text, is not one.
fn drive_path_to_guest(text: &str) -> Option<String> {
    let path = text.strip_prefix(r"\\?\").unwrap_or(text);
    let bytes = path.as_bytes();
    let rest = path.get(2..)?;
    let drive = bytes
        .first()
        .filter(|letter| letter.is_ascii_alphabetic())?;
    if bytes[1] != b':'
        || !(rest.is_empty() || rest.starts_with(['\\', '/']))
        || rest.contains(['\n', '\r'])
    {
        return None;
    }
    Some(format!(
        "/{}:{}",
        drive.to_ascii_uppercase() as char,
        rest.replace('\\', "/")
    ))
}

/// Drops the `/` before each `/C:` that starts a path: one at the start of the
/// text or after a character that cannot be part of a path, and followed by
/// `/` or the end of the path. URLs and relative paths that merely contain
/// `/C:` are left alone.
fn strip_drive_roots(text: &str) -> Cow<'_, str> {
    let bytes = text.as_bytes();
    let path_byte = |byte: u8| {
        byte.is_ascii_alphanumeric() || !byte.is_ascii() || b"/\\._-~%+@".contains(&byte)
    };
    let root_at = |index: usize| {
        bytes[index] == b'/'
            && bytes.get(index + 1).is_some_and(u8::is_ascii_uppercase)
            && bytes.get(index + 2) == Some(&b':')
            && bytes
                .get(index + 3)
                .map_or(true, |&next| next == b'/' || !path_byte(next))
            && (index == 0 || !path_byte(bytes[index - 1]))
    };
    let mut converted = String::new();
    let mut copied = 0;
    for index in 0..bytes.len() {
        if root_at(index) {
            converted.push_str(&text[copied..index]);
            copied = index + 1;
        }
    }
    if copied == 0 {
        return Cow::Borrowed(text);
    }
    converted.push_str(&text[copied..]);
    Cow::Owned(converted)
}
