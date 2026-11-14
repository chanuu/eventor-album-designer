//! Which computer this is, so Eventor can count a studio's computers against its plan.
//!
//! The id is derived from the operating system's own machine id, so it survives
//! reinstalling the app or clearing its data, and is the same for every person who
//! signs in on that computer. It is hashed with a salt of the app's own, so the raw
//! machine id never leaves the computer and cannot be matched with other software.

use std::fs;
use std::path::Path;
use std::process::Command;

use serde::Serialize;

const SALT: &str = "eventor-album-designer/device/v1";

#[derive(Serialize)]
pub struct DeviceIdentity {
    pub id: String,
    pub name: Option<String>,
    pub platform: &'static str,
}

pub fn identity(data_dir: &Path) -> DeviceIdentity {
    let raw = machine_id().unwrap_or_else(|| fallback_id(data_dir));
    let id = blake3::hash(format!("{SALT}:{raw}").as_bytes()).to_hex().to_string();
    DeviceIdentity { id, name: computer_name(), platform: std::env::consts::OS }
}

/// Runs a system tool without flashing a console window over the app on Windows.
fn quiet(program: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command.output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(windows)]
fn machine_id() -> Option<String> {
    let out = quiet(
        "reg",
        &["query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid", "/reg:64"],
    )?;
    out.lines()
        .find(|l| l.contains("MachineGuid"))
        .and_then(|l| l.split_whitespace().last())
        .map(str::to_owned)
        .filter(|id| id.len() >= 16)
}

#[cfg(target_os = "macos")]
fn machine_id() -> Option<String> {
    let out = quiet("ioreg", &["-rd1", "-c", "IOPlatformExpertDevice"])?;
    out.lines()
        .find(|l| l.contains("IOPlatformUUID"))
        .and_then(|l| l.split('"').nth(3))
        .map(str::to_owned)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn machine_id() -> Option<String> {
    ["/etc/machine-id", "/var/lib/dbus/machine-id"]
        .iter()
        .find_map(|p| fs::read_to_string(p).ok())
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

/// When the system will not say, a random id kept with the app's data. Clearing that data
/// makes the computer look new, which only costs the studio one of its places.
fn fallback_id(data_dir: &Path) -> String {
    let file = data_dir.join("device-id");
    if let Ok(id) = fs::read_to_string(&file) {
        if id.trim().len() >= 16 {
            return id.trim().to_owned();
        }
    }
    let seed = format!(
        "{:?}:{}:{:p}",
        std::time::SystemTime::now(),
        std::process::id(),
        &file
    );
    let id = blake3::hash(seed.as_bytes()).to_hex().to_string();
    let _ = fs::create_dir_all(data_dir);
    let _ = fs::write(&file, &id);
    id
}

fn computer_name() -> Option<String> {
    #[cfg(target_os = "macos")]
    if let Some(name) = quiet("scutil", &["--get", "ComputerName"]) {
        return Some(name.trim().to_owned()).filter(|n| !n.is_empty());
    }
    std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| quiet("hostname", &[]).map(|n| n.trim().to_owned()))
        .filter(|n| !n.is_empty())
}
