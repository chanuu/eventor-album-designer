//! Newer versions of the app: finding one, and installing it when the studio says so.
//!
//! Every update is signed with Eventor's own key, and one that is not is never installed.
//! The screens offer updates only where no album is open, since installing closes the app.

use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

/// The update that was found, kept so that what is installed is what was offered.
#[derive(Default)]
pub struct FoundUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
pub struct UpdateOffer {
    version: String,
    current: String,
    notes: String,
}

/// None in a debug copy, which must not replace itself with the released app. A test may
/// point one at its own address and key.
#[cfg(debug_assertions)]
fn updater(app: &AppHandle) -> Result<Option<Updater>, String> {
    let (Ok(address), Ok(key)) = (
        std::env::var("EVENTOR_UPDATE_URL"),
        std::env::var("EVENTOR_UPDATE_KEY"),
    ) else {
        return Ok(None);
    };
    let address = tauri::Url::parse(&address).map_err(|e| e.to_string())?;
    app.updater_builder()
        .endpoints(vec![address])
        .map_err(|e| e.to_string())?
        .pubkey(key)
        .build()
        .map(Some)
        .map_err(|e| e.to_string())
}

#[cfg(not(debug_assertions))]
fn updater(app: &AppHandle) -> Result<Option<Updater>, String> {
    app.updater().map(Some).map_err(|e| e.to_string())
}

/// The version this copy is.
#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// The newer version there is, if there is one.
#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    found: State<'_, FoundUpdate>,
) -> Result<Option<UpdateOffer>, String> {
    let Some(updater) = updater(&app)? else {
        return Ok(None);
    };
    let update = updater.check().await.map_err(|e| e.to_string())?;
    let offer = update.as_ref().map(|u| UpdateOffer {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone().unwrap_or_default(),
    });
    *found.0.lock().map_err(|e| e.to_string())? = update;
    Ok(offer)
}

/// Downloads the update that was offered, installs it and starts it. `progress` is told
/// how much has arrived, from 0 to 100.
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    found: State<'_, FoundUpdate>,
    progress: Channel<u8>,
) -> Result<(), String> {
    let update = found
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("There is no update to install. Check again.")?;
    let mut arrived = 0u64;
    let mut told = 0u8;
    let bytes = update
        .download(
            |chunk, total| {
                arrived += chunk as u64;
                let share = total.map_or(0, |t| (arrived * 100 / t.max(1)).min(100) as u8);
                if share > told {
                    told = share;
                    let _ = progress.send(share);
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    // On Windows this closes the app, and the installer starts the new one.
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart()
}
