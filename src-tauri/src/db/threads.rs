use rusqlite::Connection;

use crate::error::Error;
use crate::integrations::gmail::mapper::CachedThread;
use crate::models::thread::{ThreadSummary, ThreadDetail};

/// Insert or update a cached thread in SQLite.
pub fn upsert_thread(
    conn: &Connection,
    account_id: &str,
    thread: &CachedThread,
) -> Result<(), Error> {
    conn.execute(
        "INSERT INTO threads (id, account_id, provider_thread_id, subject, snippet,
         from_name, from_email, last_message_at, message_count,
         is_read, is_starred, is_archived, is_trashed, label_ids, sender_emails,
         category, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 'inbox', datetime('now'))
         ON CONFLICT(account_id, provider_thread_id) DO UPDATE SET
           subject = excluded.subject,
           snippet = excluded.snippet,
           from_name = excluded.from_name,
           from_email = excluded.from_email,
           last_message_at = excluded.last_message_at,
           message_count = excluded.message_count,
           is_read = excluded.is_read,
           is_starred = excluded.is_starred,
           is_archived = excluded.is_archived,
           is_trashed = excluded.is_trashed,
           label_ids = excluded.label_ids,
           sender_emails = excluded.sender_emails,
           updated_at = datetime('now')",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            account_id,
            thread.provider_thread_id,
            thread.subject,
            thread.snippet,
            thread.from_name,
            thread.from_email,
            thread.last_message_at,
            thread.message_count,
            thread.is_read,
            thread.is_starred,
            thread.is_archived,
            thread.is_trashed,
            serde_json::to_string(&thread.label_ids).unwrap_or_else(|_| "[]".to_string()),
            serde_json::to_string(&thread.sender_emails).unwrap_or_else(|_| "[]".to_string()),
        ],
    )?;
    Ok(())
}

/// Remove a thread from the local cache.
pub fn delete_cached_thread(
    conn: &Connection,
    account_id: &str,
    provider_thread_id: &str,
) -> Result<(), Error> {
    conn.execute(
        "DELETE FROM threads WHERE account_id = ?1 AND provider_thread_id = ?2",
        rusqlite::params![account_id, provider_thread_id],
    )?;
    Ok(())
}

/// Update label_ids and derived flags for a cached thread (optimistic update).
pub fn update_cached_labels(
    conn: &Connection,
    account_id: &str,
    provider_thread_id: &str,
    add_labels: &[&str],
    remove_labels: &[&str],
) -> Result<(), Error> {
    let current_json: String = match conn.query_row(
        "SELECT label_ids FROM threads WHERE account_id = ?1 AND provider_thread_id = ?2",
        rusqlite::params![account_id, provider_thread_id],
        |row| row.get(0),
    ) {
        Ok(json) => json,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(()), // thread not cached
        Err(e) => return Err(e.into()),
    };

    let mut labels: Vec<String> = serde_json::from_str(&current_json).unwrap_or_default();

    // Remove
    labels.retain(|l| !remove_labels.contains(&l.as_str()));

    // Add
    for label in add_labels {
        if !labels.iter().any(|l| l == label) {
            labels.push(label.to_string());
        }
    }

    let is_read = !labels.iter().any(|l| l == "UNREAD");
    let is_starred = labels.iter().any(|l| l == "STARRED");
    let is_archived = !labels.iter().any(|l| l == "INBOX");
    let is_trashed = labels.iter().any(|l| l == "TRASH");

    conn.execute(
        "UPDATE threads SET label_ids = ?1, is_read = ?2, is_starred = ?3,
         is_archived = ?4, is_trashed = ?5, updated_at = datetime('now')
         WHERE account_id = ?6 AND provider_thread_id = ?7",
        rusqlite::params![
            serde_json::to_string(&labels).unwrap_or_else(|_| "[]".to_string()),
            is_read,
            is_starred,
            is_archived,
            is_trashed,
            account_id,
            provider_thread_id,
        ],
    )?;

    Ok(())
}

/// Mark threads as calendar events based on Gmail's filename:ics detection.
/// Resets all threads for the account first, then sets the flag on matching IDs.
pub fn mark_calendar_threads(
    conn: &Connection,
    account_id: &str,
    calendar_thread_ids: &[String],
) -> Result<(), Error> {
    // Reset all calendar flags for this account
    conn.execute(
        "UPDATE threads SET is_calendar = 0 WHERE account_id = ?1",
        rusqlite::params![account_id],
    )?;

    // Set flag on matching threads
    for id in calendar_thread_ids {
        conn.execute(
            "UPDATE threads SET is_calendar = 1
             WHERE account_id = ?1 AND provider_thread_id = ?2",
            rusqlite::params![account_id, id],
        )?;
    }

    Ok(())
}

// ── Existing functions (kept for compatibility) ──

pub fn list_threads(
    conn: &Connection,
    account_id: &str,
    category: Option<&str>,
    page: u32,
    per_page: u32,
) -> Result<(Vec<ThreadSummary>, u64), Error> {
    let offset = (page.saturating_sub(1)) * per_page;

    let (where_clause, params): (String, Vec<Box<dyn rusqlite::types::ToSql>>) = match category {
        Some(cat) => (
            "WHERE t.account_id = ?1 AND t.is_archived = 0 AND t.is_trashed = 0 AND t.category = ?2".into(),
            vec![Box::new(account_id.to_string()), Box::new(cat.to_string())],
        ),
        None => (
            "WHERE t.account_id = ?1 AND t.is_archived = 0 AND t.is_trashed = 0".into(),
            vec![Box::new(account_id.to_string())],
        ),
    };

    let count_sql = format!("SELECT COUNT(*) FROM threads t {where_clause}");
    let total: u64 = conn.query_row(
        &count_sql,
        rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
        |row| row.get(0),
    )?;

    let query = format!(
        "SELECT t.id, t.subject, t.snippet, t.last_message_at, t.message_count,
                t.is_read, t.is_starred, t.category
         FROM threads t
         {where_clause}
         ORDER BY t.last_message_at DESC
         LIMIT ?{} OFFSET ?{}",
        params.len() + 1,
        params.len() + 2,
    );

    let mut all_params: Vec<Box<dyn rusqlite::types::ToSql>> = params;
    all_params.push(Box::new(per_page));
    all_params.push(Box::new(offset));

    let mut stmt = conn.prepare(&query)?;
    let threads = stmt
        .query_map(
            rusqlite::params_from_iter(all_params.iter().map(|p| p.as_ref())),
            |row| {
                Ok(ThreadSummary {
                    id: row.get(0)?,
                    subject: row.get(1)?,
                    snippet: row.get(2)?,
                    last_message_at: row.get(3)?,
                    message_count: row.get(4)?,
                    is_read: row.get(5)?,
                    is_starred: row.get(6)?,
                    category: row.get(7)?,
                })
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;

    Ok((threads, total))
}

pub fn get_thread(_conn: &Connection, _thread_id: &str) -> Result<ThreadDetail, Error> {
    todo!("Implement in Phase 5")
}
