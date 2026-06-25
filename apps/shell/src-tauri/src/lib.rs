//! LumiBase Shell — unified Tauri 2 entry point.
//!
//! The shell is a thin native wrapper around the LumiBase Studio SPA. In `dev`
//! it points the webview at the Studio Vite dev server (port 2026); in release
//! it serves the bundled `apps/studio/dist` assets. Desktop builds add silent,
//! signed auto-update via `tauri-plugin-updater`; mobile builds rely on the app
//! stores for distribution and updates.

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

    // Desktop-only plugins + auto-update wiring.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Check for updates in the background so we never block window
            // creation or the first paint of the Studio SPA.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = update::check(handle).await {
                    log::error!("update check failed: {error}");
                }
            });
            Ok(())
        });

    builder
        .run(tauri::generate_context!())
        .expect("error while running LumiBase Shell");
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
