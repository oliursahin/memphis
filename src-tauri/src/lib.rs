mod commands;
mod db;
mod email;
mod error;
mod integrations;
mod models;
mod search;
mod state;
mod sync;

use tauri::Manager;

use state::AppState;
use sync::engine::SyncEngine;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load .env file from project root (for GOOGLE_CLIENT_ID etc.)
    let _ = dotenvy::from_path(
        std::env::current_dir()
            .unwrap_or_default()
            .join(".env"),
    );
    // Also try the parent dir (when running from src-tauri/)
    let _ = dotenvy::from_path(
        std::env::current_dir()
            .unwrap_or_default()
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join(".env"),
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Initialize app state with SQLite + migrations
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");

            let state = AppState::new(data_dir).expect("failed to initialize app state");

            // Run migrations
            {
                let conn = state.db.lock().expect("db lock failed");
                db::migrations::run_migrations(&conn).expect("failed to run migrations");
            }

            let sync_db = state.db.clone();
            let sync_stop = state.sync_stop.clone();
            app.manage(state);

            // Spawn background sync engine
            let sync_handle = app.handle().clone();
            tokio::spawn(async move {
                let engine = SyncEngine::new(sync_handle, sync_db, sync_stop);
                engine.run_poll_loop(30).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::auth::start_oauth_flow,
            commands::auth::get_accounts,
            commands::auth::has_accounts,
            commands::auth::logout,
            commands::inbox::list_inbox,
            commands::inbox::archive_thread,
            commands::inbox::get_thread_detail,
            commands::inbox::send_reply,
            commands::inbox::search_threads,
            commands::inbox::mark_thread_read,
            commands::inbox::trash_thread,
            commands::inbox::send_email,
            commands::labels::list_labels,
            commands::settings::save_splits,
            commands::settings::get_splits,
            commands::settings::save_setting,
            commands::settings::get_setting,
            commands::sync::trigger_sync,
            commands::unsplash::get_inbox_zero_photo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
