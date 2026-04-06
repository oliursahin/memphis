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
    // Load .env for runtime secrets (Google OAuth, Unsplash, etc.)
    dotenvy::dotenv().ok();

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
            tauri::async_runtime::spawn(async move {
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
            commands::auth::disconnect_account,
            commands::auth::refresh_account_profiles,
            commands::auth::logout,
            commands::inbox::list_inbox,
            commands::inbox::list_inbox_cached,
            commands::inbox::archive_thread,
            commands::inbox::get_thread_detail,
            commands::inbox::send_reply,
            commands::inbox::search_threads,
            commands::inbox::mark_thread_read,
            commands::inbox::mark_thread_unread,
            commands::inbox::trash_thread,
            commands::inbox::spam_thread,
            commands::inbox::star_thread,
            commands::inbox::modify_thread_labels,
            commands::inbox::get_unsubscribe_url,
            commands::inbox::download_eml,
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
