//! Best-effort hardware identity reported on each hosted connection's hello.
//! An OS or user-supplied hostname alone does not identify the device class.

use serde::Serialize;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::time::Duration;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    /// The current device name. Registration records the name only when Remote
    /// Access is turned on; this keeps a renamed device's entry current.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

pub async fn detect() -> DeviceIdentity {
    let (kind, model) = hardware().await;
    DeviceIdentity {
        kind,
        model: model.and_then(|value| useful_model(&value)),
        os_version: sysinfo::System::os_version().and_then(|version| nonempty(&version)),
        name: Some(crate::account::device_name().await),
    }
}

fn nonempty(value: &str) -> Option<String> {
    let value = value.trim().trim_matches('\0').trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn useful_model(value: &str) -> Option<String> {
    let model = nonempty(value)?;
    let normalized = model.to_ascii_lowercase();
    if [
        "to be filled by o.e.m.",
        "system product name",
        "default string",
        "not specified",
        "not available",
        "unknown",
        "virtual machine",
        "kvm",
    ]
    .contains(&normalized.as_str())
    {
        return None;
    }
    Some(model)
}

#[cfg(any(target_os = "macos", test))]
fn mac_kind(name: &str) -> Option<&'static str> {
    let model = name.to_ascii_lowercase();
    if model.contains("macbook") {
        Some("laptop")
    } else if model.contains("imac")
        || model.contains("mac mini")
        || model.contains("macmini")
        || model.contains("mac studio")
        || model.contains("mac pro")
        || model.contains("macpro")
    {
        Some("desktop")
    } else {
        None
    }
}

#[cfg(any(target_os = "linux", target_os = "windows", test))]
fn chassis_kind(chassis: u16) -> Option<&'static str> {
    match chassis {
        8..=12 | 14 | 18 | 21 | 31 | 32 => Some("laptop"),
        30 => Some("tablet"),
        17 | 23 | 28 | 29 => Some("server"),
        3..=7 | 13 | 15 | 16 | 24 => Some("desktop"),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
async fn hardware() -> (Option<&'static str>, Option<String>) {
    use tokio::process::Command;
    // Stable JSON keys avoid locale-dependent system_profiler text parsing.
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new("/usr/sbin/system_profiler")
            .args(["-json", "SPHardwareDataType", "-detailLevel", "mini"])
            .kill_on_drop(true)
            .output(),
    )
    .await;
    if let Ok(Ok(output)) = output {
        if output.status.success() {
            if let Ok(data) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
                let row = &data["SPHardwareDataType"][0];
                let name = row["machine_name"].as_str().unwrap_or_default();
                let identifier = row["machine_model"].as_str().unwrap_or_default();
                if !name.is_empty() {
                    return (mac_kind(name), Some(name.to_string()));
                }
                if !identifier.is_empty() {
                    return (mac_kind(identifier), Some(identifier.to_string()));
                }
            }
        }
    }
    // On Apple Silicon, machine IDs alone may not reveal laptop vs desktop.
    let fallback = tokio::time::timeout(
        Duration::from_secs(2),
        Command::new("/usr/sbin/sysctl")
            .args(["-n", "hw.model"])
            .kill_on_drop(true)
            .output(),
    )
    .await;
    let model = fallback
        .ok()
        .and_then(Result::ok)
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string());
    (mac_kind(model.as_deref().unwrap_or_default()), model)
}

#[cfg(target_os = "linux")]
async fn hardware() -> (Option<&'static str>, Option<String>) {
    use std::fs;
    let chassis = fs::read_to_string("/sys/class/dmi/id/chassis_type")
        .ok()
        .and_then(|text| text.trim().parse::<u16>().ok());
    let model = fs::read_to_string("/sys/class/dmi/id/product_name")
        .ok()
        .or_else(|| fs::read_to_string("/sys/firmware/devicetree/base/model").ok());
    (
        linux_kind(chassis.and_then(chassis_kind), desktop_installed()),
        model,
    )
}

/// Whether any graphical session can be started here: a desktop environment installs its
/// session files in these folders, and a server install has none.
#[cfg(target_os = "linux")]
fn desktop_installed() -> bool {
    ["/usr/share/xsessions", "/usr/share/wayland-sessions"]
        .iter()
        .any(|dir| std::fs::read_dir(dir).is_ok_and(|mut entries| entries.next().is_some()))
}

/// Firmware is trusted when it says laptop, tablet or server. Otherwise a Linux machine with no
/// desktop environment is a server: cloud VMs report their chassis as "Other" or have no DMI at
/// all, and some (Azure) report "Desktop".
#[cfg(any(target_os = "linux", test))]
fn linux_kind(chassis: Option<&'static str>, desktop_installed: bool) -> Option<&'static str> {
    match chassis {
        Some("laptop" | "tablet" | "server") => chassis,
        _ if !desktop_installed => Some("server"),
        other => other,
    }
}

#[cfg(target_os = "windows")]
async fn hardware() -> (Option<&'static str>, Option<String>) {
    use tokio::process::Command;
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new("powershell")
            .kill_on_drop(true)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$s = Get-CimInstance Win32_ComputerSystem; $c = Get-CimInstance Win32_SystemEnclosure; @{ model = $s.Model; chassis = @($c.ChassisTypes) } | ConvertTo-Json -Compress",
            ])
            .output(),
    )
    .await;
    if let Ok(Ok(output)) = output {
        if output.status.success() {
            if let Ok(data) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
                let chassis = data["chassis"]
                    .as_array()
                    .and_then(|chassis| chassis.first())
                    .and_then(|chassis| chassis.as_u64());
                let kind = chassis
                    .and_then(|value| u16::try_from(value).ok())
                    .and_then(chassis_kind);
                return (kind, data["model"].as_str().map(str::to_string));
            }
        }
    }
    (None, None)
}

/// Android's build properties: `ro.build.characteristics` says tablet on
/// tablets of every manufacturer (Samsung phones say `nosdcard`), and
/// `ro.product.model` is the model number (`SM-N970U1`).
#[cfg(target_os = "android")]
async fn hardware() -> (Option<&'static str>, Option<String>) {
    let characteristics = android_property("ro.build.characteristics")
        .await
        .unwrap_or_default();
    (
        android_kind(&characteristics),
        android_property("ro.product.model").await,
    )
}

/// A phone unless Android says otherwise; televisions, watches and cars get no kind.
#[cfg(any(target_os = "android", test))]
fn android_kind(characteristics: &str) -> Option<&'static str> {
    let traits: Vec<&str> = characteristics.split(',').map(str::trim).collect();
    if traits.contains(&"tablet") {
        Some("tablet")
    } else if traits
        .iter()
        .any(|value| matches!(*value, "tv" | "watch" | "automotive"))
    {
        None
    } else {
        Some("phone")
    }
}

#[cfg(target_os = "android")]
async fn android_property(name: &str) -> Option<String> {
    use tokio::process::Command;
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        Command::new("/system/bin/getprop")
            .arg(name)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    nonempty(&String::from_utf8_lossy(&output.stdout))
}

/// "Samsung SM-N970U1": the brand and model, since Android keeps the name set
/// in its settings from apps.
#[cfg(target_os = "android")]
pub async fn android_device_name() -> Option<String> {
    let model = android_property("ro.product.model").await?;
    let brand = android_property("ro.product.brand").await;
    Some(brand_and_model(brand.as_deref(), &model))
}

#[cfg(any(target_os = "android", test))]
fn brand_and_model(brand: Option<&str>, model: &str) -> String {
    let Some(brand) = brand.filter(|brand| !brand.is_empty()) else {
        return model.to_string();
    };
    // Models often carry the brand already ("Pixel 7" does not, "Redmi Note 12" does).
    if model.to_lowercase().starts_with(&brand.to_lowercase()) {
        return model.to_string();
    }
    let mut chars = brand.chars();
    let brand: String = chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default();
    format!("{brand} {model}")
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "linux",
    target_os = "windows",
    target_os = "android"
)))]
async fn hardware() -> (Option<&'static str>, Option<String>) {
    (None, None)
}
