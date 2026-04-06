use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;
use serde::Serialize;
use tauri::Emitter;

use crate::db::threads::{upsert_thread, delete_cached_thread, mark_calendar_threads};
use crate::error::Error;
use crate::integrations::gmail::client::GmailClient;
use crate::integrations::gmail::mapper::map_gmail_thread;
use crate::integrations::gmail::oauth;
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
        // Small delay to let the app finish startup
        tokio::time::sleep(Duration::from_secs(1)).await;

        // Run the first sync immediately (populates cache on first launch)
        match self.do_sync_once().await {
            Ok(Some(event)) => {
                let _ = self.app_handle.emit("sync:update", &event);
            }
            Ok(None) => {}
            Err(e) => {
                log::warn!("Initial sync cycle failed: {e}");
            }
        }

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
            crate::commands::inbox::resolve_account_id(&conn)
                .map_err(|_| Error::Internal("No active account for sync".into()))?
        };

        // Read existing checkpoint and cached thread count
        let (checkpoint, cached_count) = {
            let conn = self.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
            let cp = conn.query_row(
                "SELECT checkpoint FROM sync_state WHERE account_id = ?1",
                rusqlite::params![account_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .unwrap_or(None);
            let count: u64 = conn.query_row(
                "SELECT COUNT(*) FROM threads WHERE account_id = ?1",
                rusqlite::params![account_id],
                |row| row.get(0),
            ).unwrap_or(0);
            (cp, count)
        };

        // If checkpoint exists but cache is empty (e.g. upgrade from old engine),
        // do a full initial sync to populate the cache
        if checkpoint.is_some() && cached_count == 0 {
            log::info!("Checkpoint exists but cache is empty — doing full initial sync");
            return self.do_initial_sync(&account_id).await;
        }

        match checkpoint {
            Some(ref cp) => {
                // Incremental sync: get changed thread IDs, fetch and cache them
                match gmail_sync::incremental_sync(&self.db, &account_id, cp).await {
                    Ok(result) => {
                        if result.has_changes() {
                            self.fetch_and_cache_threads(&account_id, &result.changed_thread_ids).await?;
                        }
                        // Always re-detect calendar threads (1 API call)
                        let cal_changed = self.detect_calendar_threads(&account_id).await
                            .unwrap_or_else(|e| { log::warn!("Calendar detection failed: {e}"); false });
                        gmail_sync::advance_checkpoint(&self.db, &account_id, &result.new_history_id)?;
                        Ok(if result.has_changes() {
                            Some(SyncEvent {
                                event_type: "threads_changed".into(),
                                changed_thread_ids: result.changed_thread_ids,
                            })
                        } else if cal_changed {
                            // Calendar flags changed — notify frontend to re-filter splits
                            Some(SyncEvent {
                                event_type: "calendar_updated".into(),
                                changed_thread_ids: vec!["_calendar_refresh".into()],
                            })
                        } else {
                            None
                        })
                    }
                    Err(Error::NotFound(_)) => {
                        log::warn!("History expired, doing full re-sync");
                        self.do_initial_sync(&account_id).await
                    }
                    Err(e) => Err(e),
                }
            }
            None => {
                // No checkpoint yet — do initial sync
                self.do_initial_sync(&account_id).await
            }
        }
    }

    /// Full initial sync: fetch inbox threads, cache in SQLite, seed checkpoint.
    async fn do_initial_sync(&self, account_id: &str) -> Result<Option<SyncEvent>, Error> {
        let token = oauth::get_valid_token(&self.db, account_id).await?;
        let client = GmailClient::new(token);

        log::info!("Starting initial sync for account {account_id}");

        // Fetch up to 200 inbox thread stubs (4 pages of 50)
        let mut all_stub_ids = Vec::new();
        let mut page_token: Option<String> = None;
        for _ in 0..4 {
            let list = client
                .list_threads(None, 50, page_token.as_deref(), Some(&["INBOX"]))
                .await?;
            let stubs = list.threads.unwrap_or_default();
            all_stub_ids.extend(stubs.into_iter().map(|s| s.id));
            page_token = list.next_page_token;
            if page_token.is_none() {
                break;
            }
        }

        log::info!("Initial sync: {} thread stubs fetched", all_stub_ids.len());

        // Fetch and cache in batches, emitting progress events
        for chunk in all_stub_ids.chunks(20) {
            self.fetch_and_cache_threads(account_id, chunk).await?;

            // Emit progress so the frontend can update progressively
            let _ = self.app_handle.emit(
                "sync:update",
                &SyncEvent {
                    event_type: "sync_progress".into(),
                    changed_thread_ids: chunk.to_vec(),
                },
            );
        }

        // Seed checkpoint with current historyId
        let profile = client.get_profile().await?;
        {
            let conn = self.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
            conn.execute(
                "INSERT INTO sync_state (account_id, checkpoint, last_full_sync, sync_status)
                 VALUES (?1, ?2, datetime('now'), 'idle')
                 ON CONFLICT(account_id) DO UPDATE SET
                   checkpoint = excluded.checkpoint,
                   last_full_sync = excluded.last_full_sync,
                   sync_status = excluded.sync_status",
                rusqlite::params![account_id, profile.history_id],
            )?;
        }

        // Detect calendar threads (1 extra API call)
        if let Err(e) = self.detect_calendar_threads(account_id).await {
            log::warn!("Calendar detection failed: {e}");
        }

        log::info!("Initial sync complete for account {account_id}");

        Ok(Some(SyncEvent {
            event_type: "initial_sync_complete".into(),
            changed_thread_ids: all_stub_ids,
        }))
    }

    /// Query Gmail for threads with .ics attachments and flag them in the cache.
    /// Returns true if any flags changed.
    async fn detect_calendar_threads(&self, account_id: &str) -> Result<bool, Error> {
        let token = oauth::get_valid_token(&self.db, account_id).await?;
        let client = GmailClient::new(token);

        // Single API call to get all inbox threads with .ics attachments
        let list = client
            .list_threads(Some("in:inbox filename:ics"), 200, None, None)
            .await?;
        let calendar_ids: Vec<String> = list
            .threads
            .unwrap_or_default()
            .into_iter()
            .map(|s| s.id)
            .collect();

        log::info!("Calendar detection: {} threads with .ics attachments", calendar_ids.len());

        let conn = self.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;

        // Check current set to detect changes (not just count — swaps would be missed)
        let mut stmt = conn.prepare(
            "SELECT provider_thread_id FROM threads WHERE account_id = ?1 AND is_calendar = 1"
        )?;
        let mut current_ids: Vec<String> = stmt.query_map(
            rusqlite::params![account_id],
            |row| row.get(0),
        )?.collect::<Result<Vec<_>, _>>()?;
        current_ids.sort();

        let mut new_ids = calendar_ids.clone();
        new_ids.sort();

        mark_calendar_threads(&conn, account_id, &calendar_ids)?;

        Ok(current_ids != new_ids)
    }

    /// Fetch thread metadata from Gmail and upsert into SQLite cache.
    async fn fetch_and_cache_threads(
        &self,
        account_id: &str,
        thread_ids: &[String],
    ) -> Result<(), Error> {
        if thread_ids.is_empty() {
            return Ok(());
        }

        let token = oauth::get_valid_token(&self.db, account_id).await?;
        let client = GmailClient::new(token);

        // Process in batches of 4 concurrent requests
        for chunk in thread_ids.chunks(4) {
            let futs: Vec<_> = chunk
                .iter()
                .map(|id| {
                    let client = client.clone();
                    let id = id.clone();
                    async move {
                        let mut attempt = 0u32;
                        loop {
                            match client.get_thread(&id).await {
                                Ok(thread) => return (id, Ok(Some(thread))),
                                Err(Error::NotFound(_)) => return (id, Ok(None)),
                                Err(e) => {
                                    let msg = format!("{e}");
                                    let is_rate = msg.contains("429") || msg.contains("403");
                                    if is_rate && attempt < 3 {
                                        attempt += 1;
                                        let delay = Duration::from_millis(
                                            500 * 2u64.pow(attempt - 1),
                                        );
                                        tokio::time::sleep(delay).await;
                                    } else {
                                        return (id, Err(e));
                                    }
                                }
                            }
                        }
                    }
                })
                .collect();

            let results = futures::future::join_all(futs).await;

            let conn = self
                .db
                .lock()
                .map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
            for (id, result) in results {
                match result {
                    Ok(Some(gmail_thread)) => {
                        if let Some(cached) = map_gmail_thread(&gmail_thread) {
                            if let Err(e) = upsert_thread(&conn, account_id, &cached) {
                                log::warn!("Failed to cache thread {id}: {e}");
                            }
                        }
                    }
                    Ok(None) => {
                        // Thread deleted — remove from cache
                        let _ = delete_cached_thread(&conn, account_id, &id);
                    }
                    Err(e) => {
                        log::warn!("Failed to fetch thread {id} for caching: {e}");
                    }
                }
            }
        }

        Ok(())
    }
}
