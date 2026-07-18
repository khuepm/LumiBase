//! LumiBase Shell — unified Tauri 2 entry point.
//!
//! The shell is a thin native wrapper around the LumiBase Studio SPA.
//!
//! Frontend delivery is **hybrid**:
//! * The compiled Studio SPA is bundled into the app (`frontendDist`) and is what
//!   loads first — instantly, and fully offline-capable.
//! * On desktop release builds, once the window is up we probe the configured
//!   remote Studio deployment; if it is reachable we navigate the webview there,
//!   so the always-current hosted UI is used when online without any app update.
//! * In `dev` the webview points at the Studio Vite dev server (port 2026) and
//!   the remote upgrade is skipped.
//!
//! Desktop builds add signed auto-update (with a confirm-and-restart prompt) via
//! `tauri-plugin-updater`; mobile builds rely on the app stores. Deep links
//! (`lumibase://…`) are delivered to the SPA on all platforms.

use tauri::Emitter;

/// Event emitted to the webview when the app is opened via a deep link.
const DEEP_LINK_EVENT: &str = "shell://deep-link";

/// Shared entry point used by both the desktop binary (`main.rs`) and the
/// mobile app harness (`tauri::mobile_entry_point`).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // The single-instance plugin MUST be registered first: on a second launch
    // it focuses the running window (and forwards the deep link) rather than
    // opening a duplicate. Desktop only — mobile is inherently single-instance.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
        }
    }));

    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        );

    // Desktop-only plugins + auto-update + hybrid remote upgrade + keychain.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            secure_store::secure_get,
            secure_store::secure_set,
            secure_store::secure_delete,
        ]);

    builder
        .setup(|app| {
            deep_link::forward_to_webview(app.handle());

            #[cfg(desktop)]
            {
                let handle = app.handle().clone();

                // Check for updates in the background so we never block window
                // creation or the first paint of the Studio SPA.
                {
                    let handle = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) = update::check(handle).await {
                            log::error!("update check failed: {error}");
                        }
                    });
                }

                // Hybrid: upgrade the bundled SPA to the hosted deployment when
                // it is reachable. Release only — dev uses the Vite dev server.
                #[cfg(not(debug_assertions))]
                tauri::async_runtime::spawn(async move {
                    remote::upgrade_if_reachable(handle).await;
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running LumiBase Shell");
}

/// Deliver deep links (`lumibase://…`) to the SPA as a `shell://deep-link`
/// event carrying the opened URLs.
mod deep_link {
    use super::{Emitter, DEEP_LINK_EVENT};
    use tauri::AppHandle;
    use tauri_plugin_deep_link::DeepLinkExt;

    pub fn forward_to_webview(app: &AppHandle) {
        let handle = app.clone();
        app.deep_link().on_open_url(move |event| {
            let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
            log::info!("deep link opened: {urls:?}");
            if let Err(error) = handle.emit(DEEP_LINK_EVENT, urls) {
                log::error!("failed to forward deep link to webview: {error}");
            }
        });
    }
}

/// Hybrid frontend delivery: prefer the hosted Studio deployment when online,
/// fall back to the bundled assets when it is not. Compiled in debug builds
/// (for type-checking) but only invoked from release builds, where dev's Vite
/// server is not in play.
#[cfg(desktop)]
#[cfg_attr(debug_assertions, allow(dead_code))]
mod remote {
    use std::time::Duration;
    use tauri::{AppHandle, Manager};

    /// Production Studio deployment. Override at build time with
    /// `LUMIBASE_STUDIO_URL` to target dev/staging/self-hosted, or set it empty
    /// to force pure-bundled (never navigate away from the embedded assets).
    const DEFAULT_STUDIO_URL: &str = "https://studio.lumibase.dev";

    /// How long to wait for the remote deployment before staying on bundled
    /// assets. Kept short so a slow network never leaves the user waiting.
    const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

    fn studio_url() -> Option<String> {
        let configured = option_env!("LUMIBASE_STUDIO_URL").unwrap_or(DEFAULT_STUDIO_URL);
        let trimmed = configured.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }

    pub async fn upgrade_if_reachable(app: AppHandle) {
        let Some(url) = studio_url() else {
            log::info!("remote Studio disabled; serving bundled assets");
            return;
        };

        if !is_reachable(&url).await {
            log::info!("remote Studio unreachable; serving bundled assets");
            return;
        }

        let parsed = match url.parse() {
            Ok(parsed) => parsed,
            Err(error) => {
                log::error!("invalid LUMIBASE_STUDIO_URL {url:?}: {error}");
                return;
            }
        };

        let Some(window) = app.get_webview_window("main") else {
            log::error!("main window missing; cannot load remote Studio");
            return;
        };

        match window.navigate(parsed) {
            Ok(()) => log::info!("navigated to remote Studio at {url}"),
            Err(error) => log::error!("failed to navigate to remote Studio: {error}"),
        }
    }

    /// A remote deployment counts as reachable if it answers with any non-server
    /// -error status within the timeout. A captive portal or offline network
    /// fails the request and we quietly stay on the bundled SPA.
    async fn is_reachable(url: &str) -> bool {
        let client = match reqwest::Client::builder().timeout(PROBE_TIMEOUT).build() {
            Ok(client) => client,
            Err(error) => {
                log::error!("failed to build probe client: {error}");
                return false;
            }
        };

        match client.get(url).send().await {
            Ok(response) => !response.status().is_server_error(),
            Err(error) => {
                log::info!("remote Studio probe failed: {error}");
                false
            }
        }
    }
}

/// OS-keychain-backed storage for the Studio session tokens, exposed to the SPA
/// as `secure_get` / `secure_set` / `secure_delete` commands. Desktop only —
/// on mobile the commands are not registered, so the frontend falls back to the
/// sandboxed webview storage.
#[cfg(desktop)]
mod secure_store {
    use keyring::Entry;

    /// Keychain service namespace; the `key` (e.g. "token") is the account.
    const SERVICE: &str = "com.lumibase.studio";

    fn entry(key: &str) -> Result<Entry, String> {
        Entry::new(SERVICE, key).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn secure_get(key: String) -> Result<Option<String>, String> {
        match entry(&key)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    #[tauri::command]
    pub fn secure_set(key: String, value: String) -> Result<(), String> {
        entry(&key)?.set_password(&value).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn secure_delete(key: String) -> Result<(), String> {
        match entry(&key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[cfg(desktop)]
mod update {
    use tauri::AppHandle;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    use tauri_plugin_updater::UpdaterExt;

    /// Check the configured update endpoint; if a newer signed release exists,
    /// download and install it, then ask the user to restart. The download runs
    /// in the background so editing is never interrupted, and the relaunch only
    /// happens on explicit confirmation.
    pub async fn check(app: AppHandle) -> tauri_plugin_updater::Result<()> {
        let Some(update) = app.updater()?.check().await? else {
            log::info!("no update available");
            return Ok(());
        };

        let version = update.version.clone();
        log::info!(
            "installing update {} (current {})",
            version,
            update.current_version
        );

        let mut downloaded = 0usize;
        update
            .download_and_install(
                |chunk, total| {
                    downloaded += chunk;
                    match total {
                        Some(total) => log::info!("downloaded {downloaded}/{total} bytes"),
                        None => log::info!("downloaded {downloaded} bytes"),
                    }
                },
                || log::info!("update download complete"),
            )
            .await?;

        prompt_restart(app, version);
        Ok(())
    }

    /// Ask the user whether to restart now to apply the freshly-installed update.
    fn prompt_restart(app: AppHandle, version: String) {
        let restart_handle = app.clone();
        app.dialog()
            .message(format!(
                "LumiBase Studio {version} has been installed. Restart now to apply it?"
            ))
            .title("Update ready")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Restart now".to_string(),
                "Later".to_string(),
            ))
            .show(move |restart_now| {
                if restart_now {
                    restart_handle.restart();
                }
            });
    }
}
