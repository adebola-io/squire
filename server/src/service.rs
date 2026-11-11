//! `squire service install | uninstall | status`: keep Squire running without a terminal.
//!
//! Linux gets a systemd user service, macOS a launchd agent, Termux on Android a runit
//! service through termux-services, and Windows a Task Scheduler task. Each runs this same
//! binary with `--no-browser`, restarts it if it crashes, and carries the PATH and shell of the
//! terminal that installed it, so tools Squire runs are found as they are there. systemd and
//! launchd start it at boot or login, Task Scheduler at login; Termux starts it with Termux,
//! and at boot when the Termux:Boot app is installed.
// Elsewhere every command reports that it is unsupported, so the shared helpers go unused.
#![cfg_attr(
    not(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "android",
        target_os = "windows"
    )),
    allow(dead_code, unused_imports)
)]

use crate::{storage::StoragePaths, store};
use anyhow::{bail, Context, Result};
use std::{env, fs, path::PathBuf, process::Command};

/// Runs `squire service ...` and returns the process exit code.
pub fn run(args: &[String]) -> Result<i32> {
    match args.first().map(String::as_str) {
        Some("install") => install().map(|()| 0),
        Some("uninstall") => uninstall().map(|()| 0),
        Some("status") => status(),
        // What the Windows task runs; not for people, so not in the help.
        #[cfg(target_os = "windows")]
        Some("run") => task_scheduler::supervise(args.get(1).map(String::as_str)),
        None | Some("-h" | "--help") => {
            print_help();
            Ok(0)
        }
        Some(other) => {
            eprintln!("error: unknown service command `{other}`");
            eprintln!();
            print_help();
            Ok(2)
        }
    }
}

fn print_help() {
    println!("Run Squire in the background, without a terminal.");
    println!();
    println!("USAGE:");
    println!("    squire service install      Start Squire now and whenever this computer starts");
    println!("    squire service uninstall    Stop it and remove the service");
    println!("    squire service status       Show whether it is running");
}

/// The environment the service runs with: this terminal's PATH and shell, so commands resolve
/// the same way, and the Squire home when it was chosen with SQUIRE_HOME.
fn environment() -> Vec<(&'static str, String)> {
    let mut vars = Vec::new();
    for name in ["PATH", "SHELL", "SQUIRE_HOME"] {
        if let Ok(value) = env::var(name) {
            if !value.is_empty() {
                vars.push((name, value));
            }
        }
    }
    vars
}

fn executable() -> Result<PathBuf> {
    let exe = env::current_exe().context("finding the squire executable")?;
    // dunce: Windows' canonical form is a `\\?\C:\...` path, which tools print oddly.
    Ok(dunce::canonicalize(&exe).unwrap_or(exe))
}

/// A Squire started from a terminal holds the home lock, and the service could not start
/// alongside it.
fn refuse_if_running_elsewhere() -> Result<()> {
    let paths = StoragePaths::resolve()?;
    if store::home_in_use(&paths)? {
        let stop = if cfg!(target_os = "windows") {
            "Ctrl+C in its window"
        } else {
            "`pkill -INT squire`"
        };
        bail!(
            "Squire is already running (started from a terminal). Stop it first with {stop}, \
             then run `squire service install` again."
        );
    }
    Ok(())
}

/// Escapes text for an XML document: launchd's plist and Task Scheduler's task.
#[cfg(any(target_os = "macos", target_os = "windows", test))]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

// systemd, launchd and Task Scheduler are driven through their command-line
// tools; Termux's service code runs `sv` itself.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn command_ok(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .output()
        .is_ok_and(|output| output.status.success())
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows", test))]
fn run_checked(program: &str, args: &[&str]) -> Result<()> {
    let output = Command::new(program)
        .args(args)
        .output()
        .with_context(|| format!("running {program}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        bail!("`{program} {}` failed: {}", args.join(" "), detail.trim());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    /// The systemd unit name, `squire.service`.
    const NAME: &str = "squire";

    fn unit_path() -> Result<PathBuf> {
        let config = dirs::config_dir().context("finding ~/.config")?;
        Ok(config.join("systemd/user").join(format!("{NAME}.service")))
    }

    /// systemd unit values: `%` starts a specifier and must be doubled; quoted values escape
    /// backslashes and quotes.
    fn quoted(value: &str) -> String {
        let escaped = value
            .replace('%', "%%")
            .replace('\\', "\\\\")
            .replace('"', "\\\"");
        format!("\"{escaped}\"")
    }

    pub(super) fn unit(exe: &str, vars: &[(&str, String)]) -> String {
        // No network ordering: user units cannot order against the system's network target,
        // and Squire's Remote Access reconnects on its own once the network is up.
        let mut unit = String::from(
            "[Unit]\n\
             Description=Squire\n\n\
             [Service]\n",
        );
        unit.push_str(&format!("ExecStart={} --no-browser\n", quoted(exe)));
        for (name, value) in vars {
            unit.push_str(&format!(
                "Environment={}\n",
                quoted(&format!("{name}={value}"))
            ));
        }
        unit.push_str(
            "Restart=on-failure\n\
             RestartSec=5\n\n\
             [Install]\n\
             WantedBy=default.target\n",
        );
        unit
    }

    fn systemctl(args: &[&str]) -> Result<()> {
        let mut all = vec!["--user"];
        all.extend_from_slice(args);
        run_checked("systemctl", &all).map_err(|error| {
            error.context(
                "systemd's user manager is not reachable. Squire's service needs a systemd \
                 Linux and a login session (SSH works).",
            )
        })
    }

    fn active() -> bool {
        command_ok("systemctl", &["--user", "is-active", "--quiet", NAME])
    }

    /// Without lingering, a user's services stop at logout and start only at login.
    fn ensure_linger() {
        let user = env::var("USER").unwrap_or_default();
        let lingering = Command::new("loginctl")
            .args(["show-user", &user, "--property=Linger", "--value"])
            .output()
            .is_ok_and(|output| String::from_utf8_lossy(&output.stdout).trim() == "yes");
        if lingering {
            return;
        }
        if command_ok("loginctl", &["enable-linger"]) {
            println!(
                "Squire will keep running after you log out and start when the machine boots."
            );
        } else {
            println!(
                "Squire runs while you are logged in. To keep it running after you log out and"
            );
            println!("start it at boot, run once: sudo loginctl enable-linger {user}");
        }
    }

    pub(super) fn install() -> Result<()> {
        let running = active();
        if !running {
            refuse_if_running_elsewhere()?;
        }
        let exe = executable()?;
        let path = unit_path()?;
        fs::create_dir_all(path.parent().expect("unit path has a parent"))?;
        fs::write(&path, unit(&exe.to_string_lossy(), &environment()))
            .with_context(|| format!("writing {}", path.display()))?;
        systemctl(&["daemon-reload"])?;
        systemctl(&["enable", NAME])?;
        // An update or a changed PATH takes effect by restarting a running service.
        systemctl(&[if running { "restart" } else { "start" }, NAME])?;
        ensure_linger();
        println!("Squire is running as a service ({}).", path.display());
        println!("Logs: journalctl --user -u {NAME} -f");
        Ok(())
    }

    pub(super) fn uninstall() -> Result<()> {
        let path = unit_path()?;
        if !path.exists() {
            println!("Squire is not installed as a service.");
            return Ok(());
        }
        // Stopping an already-stopped service is fine; only removal must succeed.
        let _ = systemctl(&["disable", "--now", NAME]);
        fs::remove_file(&path).with_context(|| format!("removing {}", path.display()))?;
        let _ = systemctl(&["daemon-reload"]);
        println!("Stopped Squire and removed its service.");
        Ok(())
    }

    pub(super) fn status() -> Result<i32> {
        let status = Command::new("systemctl")
            .args(["--user", "status", "--no-pager", NAME])
            .status()
            .context("running systemctl")?;
        Ok(status.code().unwrap_or(1))
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    const LABEL: &str = "com.use-squire.squire";

    fn plist_path() -> Result<PathBuf> {
        let home = dirs::home_dir().context("finding the home folder")?;
        Ok(home
            .join("Library/LaunchAgents")
            .join(format!("{LABEL}.plist")))
    }

    fn domain() -> String {
        // SAFETY: getuid has no preconditions and cannot fail.
        format!("gui/{}", unsafe { libc::getuid() })
    }

    pub(super) fn plist(exe: &str, vars: &[(&str, String)], log: &str) -> String {
        let env: String = vars
            .iter()
            .map(|(name, value)| {
                format!(
                    "    <key>{name}</key><string>{}</string>\n",
                    xml_escape(value)
                )
            })
            .collect();
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \
             \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
             <plist version=\"1.0\">\n<dict>\n\
             \x20 <key>Label</key><string>{LABEL}</string>\n\
             \x20 <key>ProgramArguments</key>\n\
             \x20 <array><string>{}</string><string>--no-browser</string></array>\n\
             \x20 <key>EnvironmentVariables</key>\n  <dict>\n{env}  </dict>\n\
             \x20 <key>RunAtLoad</key><true/>\n\
             \x20 <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n\
             \x20 <key>StandardOutPath</key><string>{log}</string>\n\
             \x20 <key>StandardErrorPath</key><string>{log}</string>\n\
             </dict>\n</plist>\n",
            xml_escape(exe),
            log = xml_escape(log),
        )
    }

    fn loaded() -> bool {
        command_ok("launchctl", &["print", &format!("{}/{LABEL}", domain())])
    }

    pub(super) fn install() -> Result<()> {
        let running = loaded();
        if !running {
            refuse_if_running_elsewhere()?;
        }
        let exe = executable()?;
        let paths = StoragePaths::resolve()?;
        fs::create_dir_all(paths.log_dir())?;
        let log = paths.log_dir().join("service.log");
        let path = plist_path()?;
        fs::create_dir_all(path.parent().expect("plist path has a parent"))?;
        fs::write(
            &path,
            plist(
                &exe.to_string_lossy(),
                &environment(),
                &log.to_string_lossy(),
            ),
        )
        .with_context(|| format!("writing {}", path.display()))?;
        if running {
            // Reload so an update or a changed PATH takes effect.
            let _ = run_checked("launchctl", &["bootout", &format!("{}/{LABEL}", domain())]);
        }
        run_checked(
            "launchctl",
            &["bootstrap", &domain(), &path.to_string_lossy()],
        )?;
        println!("Squire is running in the background and starts when you log in.");
        println!("Logs: {}", log.display());
        Ok(())
    }

    pub(super) fn uninstall() -> Result<()> {
        let path = plist_path()?;
        if !path.exists() {
            println!("Squire is not installed as a service.");
            return Ok(());
        }
        let _ = run_checked("launchctl", &["bootout", &format!("{}/{LABEL}", domain())]);
        fs::remove_file(&path).with_context(|| format!("removing {}", path.display()))?;
        println!("Stopped Squire and removed its service.");
        Ok(())
    }

    pub(super) fn status() -> Result<i32> {
        if loaded() {
            println!("Squire's service is loaded ({LABEL}).");
            let _ = Command::new("launchctl")
                .args(["print", &format!("{}/{LABEL}", domain())])
                .status();
            Ok(0)
        } else {
            println!("Squire is not running as a service.");
            Ok(3)
        }
    }
}

/// Termux has no init system of its own. Its termux-services package runs runit's `runsvdir`
/// over `$PREFIX/var/service` whenever a Termux session starts, so a service is a directory
/// there with a `run` script. Compiled for tests everywhere, since Android builds only in CI.
#[cfg(any(target_os = "android", test))]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
mod termux {
    use super::*;
    use std::{os::unix::fs::PermissionsExt, path::Path, time::Duration};

    const NAME: &str = "squire";

    /// Single-quoted for `sh`, where only a single quote needs escaping.
    fn quoted(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }

    pub(super) fn run_script(prefix: &Path, exe: &str, vars: &[(&str, String)]) -> String {
        let mut script = format!(
            "#!{}/bin/sh\n# Written by `squire service install`; termux-services runs it.\n",
            prefix.display()
        );
        for (name, value) in vars {
            script.push_str(&format!("export {name}={}\n", quoted(value)));
        }
        // Android pauses Termux while the screen is off unless Termux holds a wake lock.
        script.push_str(&format!(
            "{}\nexec {} --no-browser 2>&1\n",
            quoted(&prefix.join("bin/termux-wake-lock").to_string_lossy()),
            quoted(exe)
        ));
        script
    }

    /// Termux:Boot runs every script in `~/.termux/boot` when the phone starts. This one
    /// starts termux-services, which starts Squire, before anyone opens Termux.
    pub(super) fn boot_script(prefix: &Path) -> String {
        let prefix_text = prefix.to_string_lossy();
        format!(
            "#!{prefix_text}/bin/sh\n\
             # Written by `squire service install`; Termux:Boot runs it at boot.\n\
             export PREFIX={}\n\
             {}\n\
             . {}\n",
            quoted(&prefix_text),
            quoted(&prefix.join("bin/termux-wake-lock").to_string_lossy()),
            quoted(
                &prefix
                    .join("etc/profile.d/start-services.sh")
                    .to_string_lossy()
            ),
        )
    }

    fn service_dir(prefix: &Path) -> PathBuf {
        prefix.join("var/service").join(NAME)
    }

    fn boot_path() -> Result<PathBuf> {
        let home = dirs::home_dir().context("finding the home folder")?;
        Ok(home.join(".termux/boot").join(NAME))
    }

    fn sv(prefix: &Path, args: &[&str]) -> Command {
        let mut command = Command::new(prefix.join("bin/sv"));
        command.args(args).env("SVDIR", prefix.join("var/service"));
        command
    }

    fn running(prefix: &Path) -> bool {
        sv(prefix, &["status", NAME])
            .output()
            .is_ok_and(|output| output.stdout.starts_with(b"run:"))
    }

    fn write_executable(path: &Path, text: &str) -> Result<()> {
        fs::write(path, text).with_context(|| format!("writing {}", path.display()))?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))
            .with_context(|| format!("making {} executable", path.display()))
    }

    fn ensure_termux_services(prefix: &Path) -> Result<()> {
        if prefix.join("bin/runsvdir").is_file()
            && prefix.join("share/termux-services/svlogger").is_file()
        {
            return Ok(());
        }
        println!("Installing termux-services, which keeps Squire running in the background...");
        let installed = Command::new(prefix.join("bin/pkg"))
            .args(["install", "-y", "termux-services"])
            .status()
            .is_ok_and(|status| status.success());
        if !installed {
            bail!(
                "Could not install termux-services. Install it with \
                 `pkg install termux-services`, then run `squire service install` again."
            );
        }
        Ok(())
    }

    /// Starts runsvdir now, as opening a new Termux session would. It refuses to start twice.
    fn start_service_daemon(prefix: &Path) -> Result<()> {
        let started = Command::new(prefix.join("bin/sh"))
            .args(["-c", ". \"$1\"", "sh"])
            .arg(prefix.join("etc/profile.d/start-services.sh"))
            .env("PREFIX", prefix)
            .status()
            .context("starting termux-services")?;
        if !started.success() {
            bail!("Could not start termux-services");
        }
        Ok(())
    }

    /// Retries `sv` until runsv supervises the service: runsvdir picks up a new service
    /// directory within 5 seconds.
    fn sv_until_supervised(prefix: &Path, command: &str) -> Result<()> {
        for _ in 0..30 {
            if sv(prefix, &[command, NAME])
                .output()
                .is_ok_and(|output| output.status.success())
            {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        bail!(
            "termux-services did not pick up Squire's service; try `squire service install` again"
        )
    }

    pub(super) fn install() -> Result<()> {
        let prefix = crate::util::termux_prefix();
        ensure_termux_services(&prefix)?;
        let running = running(&prefix);
        if !running {
            refuse_if_running_elsewhere()?;
        }
        let exe = executable()?;
        let dir = service_dir(&prefix);
        fs::create_dir_all(dir.join("log"))
            .with_context(|| format!("creating {}", dir.display()))?;
        write_executable(
            &dir.join("run"),
            &run_script(&prefix, &exe.to_string_lossy(), &environment()),
        )?;
        // termux-services' logger writes to $PREFIX/var/log/sv/<service>/current.
        let logger = dir.join("log/run");
        let _ = fs::remove_file(&logger);
        std::os::unix::fs::symlink(prefix.join("share/termux-services/svlogger"), &logger)
            .with_context(|| format!("linking {}", logger.display()))?;
        // A `down` file, which `sv-disable` writes, keeps a service from starting.
        let _ = fs::remove_file(dir.join("down"));
        let boot = boot_path()?;
        fs::create_dir_all(boot.parent().expect("boot path has a parent"))?;
        write_executable(&boot, &boot_script(&prefix))?;

        start_service_daemon(&prefix)?;
        // An update or a changed PATH takes effect by restarting a running service.
        sv_until_supervised(&prefix, if running { "restart" } else { "up" })?;
        println!("Squire is running in the background.");
        println!("It starts again whenever Termux starts. To start it when the phone starts, too,");
        println!("install the Termux:Boot app and open it once.");
        println!(
            "Logs: {}",
            prefix
                .join("var/log/sv")
                .join(NAME)
                .join("current")
                .display()
        );
        Ok(())
    }

    pub(super) fn uninstall() -> Result<()> {
        let prefix = crate::util::termux_prefix();
        let dir = service_dir(&prefix);
        if !dir.exists() {
            println!("Squire is not installed as a service.");
            return Ok(());
        }
        // Stopping an already-stopped service is fine; only removal must succeed. runsvdir
        // stops the service's supervisor once its directory is gone.
        let _ = sv(&prefix, &["down", NAME]).output();
        fs::remove_dir_all(&dir).with_context(|| format!("removing {}", dir.display()))?;
        if let Ok(boot) = boot_path() {
            let _ = fs::remove_file(boot);
        }
        println!("Stopped Squire and removed its service.");
        Ok(())
    }

    pub(super) fn status() -> Result<i32> {
        let prefix = crate::util::termux_prefix();
        if !service_dir(&prefix).exists() {
            println!("Squire is not running as a service.");
            return Ok(3);
        }
        let status = sv(&prefix, &["status", NAME])
            .status()
            .context("running sv")?;
        Ok(status.code().unwrap_or(1))
    }
}

/// Windows has no per-user service manager that works without an administrator, so a Task
/// Scheduler task starts Squire when the person logs in, under their own account. The task runs
/// `squire service run`, a small supervisor that restarts Squire if it crashes, inside a
/// headless console host so no window opens.
///
/// Stopping is graceful: `stop` leaves a stop file for the supervisor, which sends Squire
/// Ctrl+Break (they share the headless console) and waits for it to shut down. Only a supervisor
/// that does not finish in time is killed. Compiled for tests everywhere.
#[cfg(any(target_os = "windows", test))]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
mod task_scheduler {
    use super::*;
    use crate::browser::{same_process_start, system_process};
    use serde::{Deserialize, Serialize};
    use std::{
        collections::BTreeMap,
        io::Write,
        path::Path,
        process::{Child, Stdio},
        time::{Duration, Instant},
    };

    pub(super) const TASK: &str = "Squire";
    const LAUNCH_FILE: &str = "launch.json";
    const PID_FILE: &str = "supervisor.pid";
    const STOP_FILE: &str = "stop";
    /// How long Squire gets to shut down before it is killed.
    const SHUTDOWN_GRACE: Duration = Duration::from_secs(20);
    /// How long a new service gets to start Squire before install reports failure.
    const STARTUP_GRACE: Duration = Duration::from_secs(30);

    /// What the supervisor runs, written at install: the task's own arguments stay short.
    #[derive(Serialize, Deserialize)]
    pub(super) struct Launch {
        pub exe: PathBuf,
        pub log: PathBuf,
        pub vars: BTreeMap<String, String>,
    }

    /// One argument on a Windows command line, quoted the way programs split them.
    pub(super) fn arg(value: &str) -> String {
        if !value.is_empty() && !value.contains([' ', '\t', '"']) {
            return value.to_string();
        }
        let escaped = value.replace('"', "\\\"");
        // Backslashes before the closing quote would escape it, so they are doubled.
        let trailing = escaped.len() - escaped.trim_end_matches('\\').len();
        format!("\"{escaped}{}\"", "\\".repeat(trailing))
    }

    /// A task that starts at `user`'s logon, as that user, with no time limit (the default
    /// stops a task after three days) and on battery too. It runs `command` with `arguments`.
    pub(super) fn task_xml(user: &str, command: &str, arguments: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Keeps Squire running in the background. Written by `squire service install`.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{command}</Command>
      <Arguments>{arguments}</Arguments>
    </Exec>
  </Actions>
</Task>
"#,
            user = xml_escape(user),
            command = xml_escape(command),
            arguments = xml_escape(arguments),
        )
    }

    /// schtasks reads task XML as UTF-16.
    fn utf16(text: &str) -> Vec<u8> {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes
    }

    fn user() -> Result<String> {
        let name = env::var("USERNAME").context("finding the Windows user name")?;
        Ok(match env::var("USERDOMAIN") {
            Ok(domain) if !domain.is_empty() => format!("{domain}\\{name}"),
            _ => name,
        })
    }

    fn service_dir(paths: &StoragePaths) -> PathBuf {
        paths.squire_home.join("service")
    }

    /// Whether the task exists. A Task Scheduler that cannot be asked is an error, not an
    /// absent task. `schtasks /Query`, and asking for a task or folder by name, fail the same
    /// way for both, so this lists every task and looks for Squire's in the root folder.
    fn registered() -> Result<bool> {
        let filter = format!(r"$_.TaskPath -eq '\' -and $_.TaskName -eq '{TASK}'");
        let script =
            format!("@(Get-ScheduledTask -ErrorAction Stop | Where-Object {{ {filter} }}).Count");
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .context("asking Task Scheduler for Squire's task")?;
        let count = String::from_utf8_lossy(&output.stdout).trim().to_string();
        match (output.status.success(), count.as_str()) {
            (true, "0") => Ok(false),
            (true, "1") => Ok(true),
            _ => bail!(
                "Could not ask Task Scheduler for Squire's task: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        }
    }

    /// The running supervisor, if the one the PID file names is still that process: the same
    /// PID started in the same second, so a reused PID is never taken for it. Not the same
    /// executable path: an update renames the running one (see `same_process_start`).
    fn supervisor(dir: &Path) -> Option<u32> {
        let text = fs::read_to_string(dir.join(PID_FILE)).ok()?;
        let (pid, recorded) = text.trim().split_once('|')?;
        let pid = pid.parse().ok()?;
        same_process_start(&system_process(pid)?, recorded).then_some(pid)
    }

    fn wait_until(timeout: Duration, mut done: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if done() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    fn kill_tree(pid: u32) {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }

    /// Stops the service's Squire the way Ctrl+C would, then its supervisor and task.
    fn stop(paths: &StoragePaths) -> Result<()> {
        let dir = service_dir(paths);
        if let Some(pid) = supervisor(&dir) {
            fs::write(dir.join(STOP_FILE), "")
                .with_context(|| format!("writing {}", dir.join(STOP_FILE).display()))?;
            // The supervisor gives Squire SHUTDOWN_GRACE, then kills it; allow for both.
            if !wait_until(SHUTDOWN_GRACE + Duration::from_secs(10), || {
                supervisor(&dir).is_none()
            }) {
                kill_tree(pid);
            }
        }
        let _ = run_checked("schtasks", &["/End", "/TN", TASK]);
        let _ = fs::remove_file(dir.join(STOP_FILE));
        let _ = fs::remove_file(dir.join(PID_FILE));
        if !wait_until(Duration::from_secs(10), || {
            !store::home_in_use(paths).unwrap_or(true)
        }) {
            bail!(
                "Squire's service did not stop; its home folder is still in use. Stop Squire \
                 with `taskkill /IM squire.exe /F`, then run this command again."
            );
        }
        Ok(())
    }

    /// The last lines of the service log, to show why Squire did not start.
    fn log_tail(log: &Path) -> String {
        let text = fs::read_to_string(log).unwrap_or_default();
        let lines: Vec<&str> = text.lines().collect();
        lines[lines.len().saturating_sub(15)..].join("\n")
    }

    pub(super) fn install() -> Result<()> {
        let paths = StoragePaths::resolve()?;
        // Reinstalling restarts the service, so an update or a changed PATH takes effect.
        if registered()? {
            stop(&paths)?;
        }
        refuse_if_running_elsewhere()?;
        // conhost's headless mode, in Windows 10 1809 and later, gives Squire the console it
        // expects without opening a window, and lets the supervisor send it Ctrl+Break.
        let system_root = env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let conhost = format!("{system_root}\\System32\\conhost.exe");
        if !Path::new(&conhost).is_file() {
            bail!("{conhost} is missing; Squire's service needs Windows 10 version 1809 or later");
        }
        let exe = executable()?;
        let dir = service_dir(&paths);
        fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
        fs::create_dir_all(paths.log_dir())?;
        let log = paths.log_dir().join("service.log");
        let launch = Launch {
            exe: exe.clone(),
            log: log.clone(),
            vars: environment()
                .into_iter()
                .map(|(name, value)| (name.to_string(), value))
                .collect(),
        };
        let launch_path = dir.join(LAUNCH_FILE);
        fs::write(&launch_path, serde_json::to_vec_pretty(&launch)?)
            .with_context(|| format!("writing {}", launch_path.display()))?;
        let _ = fs::remove_file(dir.join(STOP_FILE));

        let arguments = format!(
            "--headless {} service run {}",
            arg(&exe.to_string_lossy()),
            arg(&launch_path.to_string_lossy())
        );
        let xml_path = dir.join("task.xml");
        fs::write(&xml_path, utf16(&task_xml(&user()?, &conhost, &arguments)))
            .with_context(|| format!("writing {}", xml_path.display()))?;
        let created = run_checked(
            "schtasks",
            &[
                "/Create",
                "/TN",
                TASK,
                "/XML",
                &xml_path.to_string_lossy(),
                "/F",
            ],
        );
        let _ = fs::remove_file(&xml_path);
        created?;
        run_checked("schtasks", &["/Run", "/TN", TASK])?;

        // Squire takes its home lock as it starts; until it does, it is not running.
        if !wait_until(STARTUP_GRACE, || {
            store::home_in_use(&paths).unwrap_or(false)
        }) {
            bail!(
                "Squire's service is installed, but Squire did not start within {} seconds. \
                 It will try again when you log in; `squire service uninstall` removes it.\n\
                 The end of {}:\n{}",
                STARTUP_GRACE.as_secs(),
                log.display(),
                log_tail(&log)
            );
        }
        println!("Squire is running in the background and starts when you log in.");
        println!("Logs: {}", log.display());
        Ok(())
    }

    pub(super) fn uninstall() -> Result<()> {
        let paths = StoragePaths::resolve()?;
        let dir = service_dir(&paths);
        let registered = registered()?;
        if !registered && !dir.exists() {
            println!("Squire is not installed as a service.");
            return Ok(());
        }
        stop(&paths)?;
        if registered {
            run_checked("schtasks", &["/Delete", "/TN", TASK, "/F"])?;
        }
        let _ = fs::remove_dir_all(&dir);
        println!("Stopped Squire and removed its service.");
        Ok(())
    }

    pub(super) fn status() -> Result<i32> {
        if !registered()? {
            println!("Squire is not running as a service.");
            return Ok(3);
        }
        let paths = StoragePaths::resolve()?;
        let log = paths.log_dir().join("service.log");
        let supervised = supervisor(&service_dir(&paths)).is_some();
        if supervised && store::home_in_use(&paths)? {
            println!(
                "Squire is running in the background (Task Scheduler task \"{TASK}\"). \
                 It starts when you log in."
            );
            println!("Logs: {}", log.display());
            return Ok(0);
        }
        if supervised {
            println!("Squire's service is waiting to restart Squire. The log says why it stopped:");
        } else {
            println!("Squire's service is installed but not running. It starts when you log in;");
            println!("to start it now, run: squire service install");
        }
        println!("Logs: {}", log.display());
        Ok(3)
    }

    fn note(log: &Path, message: &str) {
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(log) {
            let _ = writeln!(file, "[squire service] {message}");
        }
    }

    /// Starts Squire in its own process group, so Ctrl+Break can be sent to it alone.
    fn spawn(launch: &Launch) -> Result<Child> {
        let output = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&launch.log)
            .with_context(|| format!("opening {}", launch.log.display()))?;
        let mut command = Command::new(&launch.exe);
        command
            .arg("--no-browser")
            .envs(&launch.vars)
            .stdin(Stdio::null())
            .stdout(output.try_clone()?)
            .stderr(output);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            command.creation_flags(CREATE_NEW_PROCESS_GROUP);
        }
        command
            .spawn()
            .with_context(|| format!("starting {}", launch.exe.display()))
    }

    /// Sends Ctrl+Break to the process group `pid` leads, on the console both share.
    #[cfg(target_os = "windows")]
    fn ctrl_break(pid: u32) -> bool {
        const CTRL_BREAK_EVENT: u32 = 1;
        #[link(name = "kernel32")]
        extern "system" {
            fn GenerateConsoleCtrlEvent(event: u32, process_group: u32) -> i32;
        }
        // SAFETY: a plain Win32 call with no pointers; it fails cleanly for a bad group.
        unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid) != 0 }
    }

    #[cfg(not(target_os = "windows"))]
    fn ctrl_break(_pid: u32) -> bool {
        false
    }

    /// Asks Squire to shut down and waits for it; kills it only if it does not finish in time.
    fn shut_down(child: &mut Child, log: &Path) {
        if !ctrl_break(child.id()) {
            note(log, "could not send Ctrl+Break to Squire");
        }
        let stopped = wait_until(SHUTDOWN_GRACE, || {
            child.try_wait().is_ok_and(|s| s.is_some())
        });
        if !stopped {
            note(log, "Squire did not shut down in time; stopping it");
            kill_tree(child.id());
            let _ = child.wait();
        }
    }

    /// `squire service run <launch file>`: runs Squire and restarts it when it crashes, waiting
    /// longer after each quick crash. A clean exit, such as finding Squire already running,
    /// ends the supervisor, and so does a stop file, after Squire shuts down.
    pub(super) fn supervise(launch: Option<&str>) -> Result<i32> {
        let launch_path = PathBuf::from(launch.context("usage: squire service run <launch file>")?);
        let dir = launch_path
            .parent()
            .context("the launch file has no folder")?
            .to_path_buf();
        let text =
            fs::read(&launch_path).with_context(|| format!("reading {}", launch_path.display()))?;
        let launch: Launch = serde_json::from_slice(&text)
            .with_context(|| format!("reading {}", launch_path.display()))?;
        let me = std::process::id();
        let identity = system_process(me).context("reading this process's identity")?;
        fs::write(dir.join(PID_FILE), format!("{me}|{identity}"))?;
        if let Some(logs) = launch.log.parent() {
            let _ = fs::create_dir_all(logs);
        }
        let stop_requested = || dir.join(STOP_FILE).exists();
        let mut delay = Duration::from_secs(5);
        loop {
            let started = Instant::now();
            match spawn(&launch) {
                Ok(mut child) => loop {
                    if stop_requested() {
                        shut_down(&mut child, &launch.log);
                        return Ok(0);
                    }
                    match child.try_wait() {
                        Ok(Some(status)) if status.success() => return Ok(0),
                        Ok(Some(status)) => {
                            note(&launch.log, &format!("Squire stopped ({status})"));
                            break;
                        }
                        Ok(None) => std::thread::sleep(Duration::from_millis(250)),
                        Err(error) => {
                            note(&launch.log, &format!("lost track of Squire: {error}"));
                            break;
                        }
                    }
                },
                Err(error) => note(&launch.log, &format!("{error:#}")),
            }
            if started.elapsed() > Duration::from_secs(300) {
                delay = Duration::from_secs(5);
            }
            note(
                &launch.log,
                &format!("restarting in {} seconds", delay.as_secs()),
            );
            if wait_until(delay, stop_requested) {
                return Ok(0);
            }
            delay = (delay * 2).min(Duration::from_secs(300));
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    pub(super) use super::task_scheduler::{install, status, uninstall};
}

#[cfg(target_os = "android")]
mod platform {
    pub(super) use super::termux::{install, status, uninstall};
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "macos",
    target_os = "android",
    target_os = "windows"
)))]
mod platform {
    use super::*;

    const UNSUPPORTED: &str =
        "Running Squire as a service is supported on Linux (systemd), macOS, Windows and Android (Termux) so far.";

    pub(super) fn install() -> Result<()> {
        bail!(UNSUPPORTED)
    }

    pub(super) fn uninstall() -> Result<()> {
        bail!(UNSUPPORTED)
    }

    pub(super) fn status() -> Result<i32> {
        bail!(UNSUPPORTED)
    }
}

fn install() -> Result<()> {
    platform::install()
}

fn uninstall() -> Result<()> {
    platform::uninstall()
}

fn status() -> Result<i32> {
    platform::status()
}
