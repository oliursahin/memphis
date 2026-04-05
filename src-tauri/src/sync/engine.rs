use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;
use serde::Serialize;
use tauri::Emitter;

use crate::error::Error;
use crate::integrations::gmail::sync as gmail_sync;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEvent {
    pub event_type: String,
    pub changed_thread_ids: Vec<String>,
}

pub struct SyncEngine {
    app_handle: tauri::AppHandle,
    db: Arc<Mutex<Connection>>,
    stop_flag: Arc<AtomicBool>,
}

impl SyncEngine {
    pub fn new(
        app_handle: tauri::AppHandle,
        db: Arc<Mutex<Connection>>,
        stop_flag: Arc<AtomicBool>,
    ) -> Self {
        Self { app_handle, db, stop_flag }
    }

    /// Run the background poll loop. Blocks until stop_flag is set.
    pub async fn run_poll_loop(&self, base_interval_secs: u64) {
        // Initial delay to let the app finish startup loading
        tokio::time::sleep(Duration::from_secs(3)).await;

        let mut consecutive_errors: u32 = 0;

        loop {
            if self.stop_flag.load(Ordering::Relaxed) {
                break;
            }

            // Exponential backoff: base * 2^errors, capped at 300s
            let wait = Duration::from_secs(
                (base_interval_secs * 2u64.pow(consecutive_errors.min(3))).min(300),
            );
            tokio::time::sleep(wait).await;

            if self.stop_flag.load(Ordering::Relaxed) {
                break;
            }

            match self.do_sync_once().await {
                Ok(Some(event)) => {
                    consecutive_errors = 0;
                    let _ = self.app_handle.emit("sync:update", &event);
                }
                Ok(None) => {
                    consecutive_errors = 0;
                    // No changes, nothing to emit
                }
                Err(e) => {
                    consecutive_errors += 1;
                    log::warn!("Sync error (attempt {}): {e}", consecutive_errors);
                }
            }
        }
    }

    /// Perform a single sync cycle. Returns a SyncEvent if there are changes, None otherwise.
    pub async fn do_sync_once(&self) -> Result<Option<SyncEvent>, Error> {
        let account_id = {
            let conn = self.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
            conn.query_row(
                "SELECT id FROM accounts WHERE is_active = 1 ORDER BY created_at ASC LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .map_err(|_| Error::Internal("No active account for sync".into()))?
        };

        // Read existing checkpoint
        let checkpoint: Option<String> = {
            let conn = self.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
            conn.query_row(
                "SELECT checkpoint FROM sync_state WHERE account_id = ?1",
                rusqlite::params![account_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .unwrap_or(None)
        };

        match checkpoint {
            Some(ref cp) => {
                // Try incremental sync; fall back to re-seed on 404 (expired historyId)
                match gmail_sync::incremental_sync(&self.db, &account_id, cp).await {
                    Ok(result) => {
                        if result.has_changes() {
                            Ok(Some(SyncEvent {
                                event_type: "threads_changed".into(),
                                changed_thread_ids: result.changed_thread_ids,
                            }))
                        } else {
                            Ok(None)
                        }
                    }
                    Err(Error::Internal(msg)) if msg.contains("404") => {
                        log::warn!("History expired, re-seeding checkpoint");
                        gmail_sync::seed_checkpoint(&self.db, &account_id).await?;
                        Ok(None)
                    }
                    Err(e) => Err(e),
                }
            }
            None => {
                // No checkpoint yet — seed it
                gmail_sync::seed_checkpoint(&self.db, &account_id).await?;
                Ok(None)
            }
        }
    }
}
