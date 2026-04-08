use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::db::calendar_events::{self, CalendarEventRow};
use crate::db::threads::{upsert_thread, delete_cached_thread, mark_calendar_threads};
use crate::error::Error;
use crate::integrations::calendar::client::CalendarClient;
use crate::integrations::gmail::client::GmailClient;
use crate::integrations::gmail::mapper::map_gmail_thread;
use crate::integrations::gmail::oauth;
use crate::integrations::gmail::sync as gmail_sync;

/// Accounts that got a 403 for Calendar API, with timestamp.
/// Suppresses retries for 5 minutes, then auto-retries (handles API propagation delays).
static CALENDAR_SCOPE_DENIED: std::sync::LazyLock<tokio::sync::Mutex<HashMap<String, Instant>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(HashMap::new()));

/// How long to suppress calendar retries after a 403.
const CALENDAR_DENY_COOLDOWN_SECS: u64 = 300;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEvent {
    pub event_type: String,
    pub changed_thread_ids: Vec<String>,
}

/// Result of syncing a single account within a poll cycle.
enum AccountSyncResult {
    NoChanges,
    Changes(Vec<String>),
    CalendarOnly,
    InitialComplete(Vec<String>),
}

/// Clear the calendar-scope-denied flag for an account after re-auth.
pub async fn clear_calendar_denied(account_id: &str) {
    CALENDAR_SCOPE_DENIED.lock().await.remove(account_id);
}

/// Check if calendar is suppressed for an account (returns true if still in cooldown).
async fn is_calendar_suppressed(account_id: &str) -> bool {
    let mut denied = CALENDAR_SCOPE_DENIED.lock().await;
    if let Some(denied_at) = denied.get(account_id) {
        if denied_at.elapsed().as_secs() < CALENDAR_DENY_COOLDOWN_SECS {
            return true;
        }
        // Cooldown expired — remove and allow retry
        denied.remove(account_id);
    }
    false
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

    /// Mark an account as having failed calendar auth — retry after cooldown.
    async fn suppress_calendar(&self, account_id: &str) {
        CALENDAR_SCOPE_DENIED.lock().await.insert(account_id.to_string(), Instant::now());
        let _ = self.app_handle.emit("calendar:needs_reauth", account_id);
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

    /// Perform a single sync cycle across ALL active accounts.
    /// Returns a SyncEvent if there are changes in any account, None otherwise.
    pub async fn do_sync_once(&self) -> Result<Option<SyncEvent>, Error> {
        let account_ids = {
            let conn = self.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
            let mut stmt = conn.prepare(
                "SELECT id FROM accounts WHERE is_active = 1 ORDER BY created_at ASC"
            )?;
            let ids: Vec<String> = stmt.query_map([], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| Error::Internal(format!("Failed to list accounts: {e}")))?;
            ids
        };

        if account_ids.is_empty() {
            return Ok(None);
        }

        let mut all_changed_ids = Vec::new();
        let mut any_calendar_changed = false;
        let mut had_initial_sync = false;

        for account_id in &account_ids {
            match self.do_sync_account(account_id).await {
                Ok(AccountSyncResult::Changes(thread_ids)) => {
                    all_changed_ids.extend(thread_ids);
                }
                Ok(AccountSyncResult::CalendarOnly) => {
                    any_calendar_changed = true;
                }
                Ok(AccountSyncResult::InitialComplete(thread_ids)) => {
                    all_changed_ids.extend(thread_ids);
                    had_initial_sync = true;
                }
                Ok(AccountSyncResult::NoChanges) => {}
                Err(e) => {
                    log::warn!("Sync failed for account {account_id}: {e}");
                }
            }

            // Sync calendar events (piggyback on every cycle)
            match self.sync_calendar_events(account_id).await {
                Ok(true) => any_calendar_changed = true,
                Ok(false) => {}
                Err(e) => log::warn!("Calendar sync failed for {account_id}: {e}"),
            }
        }

        if had_initial_sync {
            Ok(Some(SyncEvent {
                event_type: "initial_sync_complete".into(),
                changed_thread_ids: all_changed_ids,
            }))
        } else if !all_changed_ids.is_empty() {
            Ok(Some(SyncEvent {
                event_type: "threads_changed".into(),
                changed_thread_ids: all_changed_ids,
            }))
        } else if any_calendar_changed {
            Ok(Some(SyncEvent {
                event_type: "calendar_updated".into(),
                changed_thread_ids: vec!["_calendar_refresh".into()],
            }))
        } else {
            Ok(None)
        }
    }

    /// Sync a single account. Returns what changed.
    async fn do_sync_account(&self, account_id: &str) -> Result<AccountSyncResult, Error> {
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

        // If checkpoint exists but cache is empty, do a full initial sync
        if checkpoint.is_some() && cached_count == 0 {
            log::info!("Checkpoint exists but cache is empty for {account_id} — doing full initial sync");
            return self.do_initial_sync(account_id).await
                .map(|ev| AccountSyncResult::InitialComplete(
                    ev.map(|e| e.changed_thread_ids).unwrap_or_default()
                ));
        }

        match checkpoint {
            Some(ref cp) => {
                match gmail_sync::incremental_sync(&self.db, account_id, cp).await {
                    Ok(result) => {
                        if result.has_changes() {
                            self.fetch_and_cache_threads(account_id, &result.changed_thread_ids).await?;
                        }
                        // Fire native notifications for new inbox messages
                        if !result.new_inbox_thread_ids.is_empty() {
                            self.notify_new_threads(account_id, &result.new_inbox_thread_ids);
                        }
                        let cal_changed = self.detect_calendar_threads(account_id).await
                            .unwrap_or_else(|e| { log::warn!("Calendar detection failed for {account_id}: {e}"); false });
                        gmail_sync::advance_checkpoint(&self.db, account_id, &result.new_history_id)?;
                        Ok(if result.has_changes() {
                            AccountSyncResult::Changes(result.changed_thread_ids)
                        } else if cal_changed {
                            AccountSyncResult::CalendarOnly
                        } else {
                            AccountSyncResult::NoChanges
                        })
                    }
                    Err(Error::NotFound(_)) => {
                        log::warn!("History expired for {account_id}, doing full re-sync");
                        self.do_initial_sync(account_id).await
                            .map(|ev| AccountSyncResult::InitialComplete(
                                ev.map(|e| e.changed_thread_ids).unwrap_or_default()
                            ))
                    }
                    Err(e) => Err(e),
                }
            }
            None => {
                self.do_initial_sync(account_id).await
                    .map(|ev| AccountSyncResult::InitialComplete(
                        ev.map(|e| e.changed_thread_ids).unwrap_or_default()
                    ))
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

    /// Sync calendar events from Google Calendar API for an account.
    /// Fetches events for the next 7 days and upserts them into SQLite.
    /// Returns true if any events were synced.
    async fn sync_calendar_events(&self, account_id: &str) -> Result<bool, Error> {
        // Skip if recently denied (retries automatically after 5-min cooldown)
        if is_calendar_suppressed(account_id).await {
            return Ok(false);
        }

        let token = match oauth::get_valid_token(&self.db, account_id).await {
            Ok(t) => t,
            Err(e) => {
                let msg = format!("{e}");
                if msg.contains("403") || msg.contains("Calendar API") {
                    self.suppress_calendar(account_id).await;
                    return Ok(false);
                }
                return Err(e);
            }
        };

        let client = CalendarClient::new(token);

        // Fetch calendars, then events from each
        let calendars = match client.list_calendars().await {
            Ok(c) => c,
            Err(Error::Auth(ref msg)) => {
                log::warn!("Calendar API 403 for {account_id} — suppressing until re-auth. \
                    Ensure Google Calendar API is enabled in Cloud Console. Detail: {msg}");
                self.suppress_calendar(account_id).await;
                return Ok(false);
            }
            Err(e) => return Err(e),
        };

        let now = chrono::Utc::now();
        let time_min = now.to_rfc3339();
        let time_max = (now + chrono::Duration::days(7)).to_rfc3339();

        // Clean up old events
        {
            let conn = self.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
            let yesterday = (now - chrono::Duration::days(1)).to_rfc3339();
            let _ = calendar_events::delete_stale_events(&conn, account_id, &yesterday);
        }

        let mut count = 0usize;
        for cal in &calendars {
            let events = match client.list_events(&cal.id, &time_min, &time_max, 250).await {
                Ok(e) => e,
                Err(e) => {
                    log::warn!("Failed to fetch events for calendar {}: {e}", cal.id);
                    continue;
                }
            };

            let conn = self.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
            for event in &events {
                // Skip cancelled events
                if event.status.as_deref() == Some("cancelled") {
                    continue;
                }

                let (start_time, end_time, is_all_day) = match (&event.start, &event.end) {
                    (Some(s), Some(e)) => {
                        if let (Some(st), Some(et)) = (&s.date_time, &e.date_time) {
                            (st.clone(), et.clone(), false)
                        } else if let (Some(sd), Some(ed)) = (&s.date, &e.date) {
                            // All-day events: store as T00:00:00 UTC
                            (format!("{sd}T00:00:00Z"), format!("{ed}T00:00:00Z"), true)
                        } else {
                            continue;
                        }
                    }
                    _ => continue,
                };

                let attendees_json = event.attendees.as_ref().map(|att| {
                    serde_json::to_string(
                        &att.iter()
                            .filter_map(|a| a.email.clone())
                            .collect::<Vec<_>>(),
                    )
                    .unwrap_or_else(|_| "[]".to_string())
                });

                let row = CalendarEventRow {
                    id: format!("{}_{}", account_id, event.id),
                    account_id: account_id.to_string(),
                    provider_event_id: event.id.clone(),
                    calendar_id: cal.id.clone(),
                    calendar_name: cal.summary.clone(),
                    title: event.summary.clone().unwrap_or_default(),
                    start_time,
                    end_time,
                    location: event.location.clone(),
                    description: event.description.clone(),
                    status: event.status.clone(),
                    color: cal.background_color.clone(),
                    organizer_email: event.organizer.as_ref().and_then(|o| o.email.clone()),
                    attendees: attendees_json,
                    is_all_day,
                };

                if let Err(e) = calendar_events::upsert_event(&conn, &row) {
                    log::warn!("Failed to upsert calendar event {}: {e}", event.id);
                }
                count += 1;
            }
        }

        if count > 0 {
            log::info!("Calendar sync: upserted {count} events for {account_id}");
            let _ = self.app_handle.emit("calendar:events_updated", account_id);
        }

        Ok(count > 0)
    }

    /// Send native OS notifications for newly arrived inbox threads.
    /// Suppresses notifications when the app window is focused.
    fn notify_new_threads(&self, account_id: &str, new_thread_ids: &[String]) {
        // Skip if user is looking at the app
        if let Some(window) = self.app_handle.get_webview_window("main") {
            if window.is_focused().unwrap_or(false) {
                return;
            }
        }

        // Query cached thread details for notification content
        let threads_info: Vec<(String, String, String)> = {
            let conn = match self.db.lock() {
                Ok(c) => c,
                Err(_) => return,
            };
            new_thread_ids.iter().filter_map(|tid| {
                conn.query_row(
                    "SELECT from_name, subject, snippet FROM threads
                     WHERE account_id = ?1 AND provider_thread_id = ?2
                     AND is_archived = 0 AND is_trashed = 0",
                    rusqlite::params![account_id, tid],
                    |row| Ok((
                        row.get::<_, String>(0).unwrap_or_default(),
                        row.get::<_, String>(1).unwrap_or_default(),
                        row.get::<_, String>(2).unwrap_or_default(),
                    )),
                ).ok()
            }).collect()
        };

        if threads_info.is_empty() {
            return;
        }

        if threads_info.len() == 1 {
            let (from_name, subject, snippet) = &threads_info[0];
            let title = if from_name.is_empty() { "New email" } else { from_name.as_str() };
            let body = if snippet.is_empty() {
                subject.clone()
            } else {
                format!("{}\n{}", subject, snippet)
            };
            let _ = self.app_handle
                .notification()
                .builder()
                .title(title)
                .body(&body)
                .show();
        } else {
            let summary = threads_info.iter()
                .take(3)
                .map(|(name, subj, _)| {
                    let sender = if name.is_empty() { "Unknown" } else { name.as_str() };
                    format!("{}: {}", sender, subj)
                })
                .collect::<Vec<_>>()
                .join("\n");
            let _ = self.app_handle
                .notification()
                .builder()
                .title(&format!("{} new emails", threads_info.len()))
                .body(&summary)
                .show();
        }
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
