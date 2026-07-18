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
//! Desktop builds add signed auto-update via `tauri-plugin-updater`; mobile
//! builds rely on the app stores for distribution and updates.

/// Shared entry point used by both the desktop binary (`main.rs`) and the
/// mobile app harness (`tauri::mobile_entry_point`).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        );

    // Desktop-only plugins + auto-update + hybrid remote upgrade.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
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

            // Hybrid: upgrade the bundled SPA to the hosted deployment when it
            // is reachable. Only in release — dev uses the Vite dev server.
            #[cfg(not(debug_assertions))]
            tauri::async_runtime::spawn(async move {
                remote::upgrade_if_reachable(handle).await;
            });

            Ok(())
        });

    builder
        .run(tauri::generate_context!())
        .expect("error while running LumiBase Shell");
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

#[cfg(desktop)]
mod update {
    use tauri::AppHandle;
    use tauri_plugin_updater::UpdaterExt;

    /// Check the configured update endpoint, and if a newer signed release is
    /// available, download and install it. The relaunch is left to the user
    /// (or a follow-up prompt) so we don't interrupt in-flight editing.
    pub async fn check(app: AppHandle) -> tauri_plugin_updater::Result<()> {
        let Some(update) = app.updater()?.check().await? else {
            log::info!("no update available");
            return Ok(());
        };

        log::info!(
            "installing update {} (current {})",
            update.version,
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
                || log::info!("update download complete; ready to relaunch"),
            )
            .await?;

        Ok(())
    }
}
