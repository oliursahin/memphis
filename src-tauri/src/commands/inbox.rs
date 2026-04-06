use base64::engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use futures::stream::{self, StreamExt};
use tauri::State;

use crate::error::Error;
use crate::integrations::gmail::client::{GmailClient, GmailMessage, MessagePayload, MessagePart, ThreadStub};
use crate::integrations::gmail::oauth;
use crate::state::AppState;

// ── Shared helpers ──

/// Resolve the active account ID: prefer the user-chosen `active_account_id` setting,
/// fall back to the first active account by creation date.
pub fn resolve_account_id(conn: &rusqlite::Connection) -> Result<String, Error> {
    // Check if user has explicitly selected an account
    if let Ok(json) = conn.query_row(
        "SELECT value FROM settings WHERE key = 'active_account_id'",
        [],
        |row| row.get::<_, String>(0),
    ) {
        if let Ok(id) = serde_json::from_str::<String>(&json) {
            // Verify the account still exists and is active
            let exists: bool = conn.query_row(
                "SELECT COUNT(*) > 0 FROM accounts WHERE id = ?1 AND is_active = 1",
                [&id],
                |row| row.get(0),
            ).unwrap_or(false);
            if exists {
                return Ok(id);
            }
        }
    }
    // Fallback: first active account
    conn.query_row(
        "SELECT id FROM accounts WHERE is_active = 1 ORDER BY created_at ASC LIMIT 1",
        [],
        |row| row.get::<_, String>(0),
    )
    .map_err(|_| Error::Auth("No active account. Please sign in.".into()))
}

/// Get a GmailClient for the active account.
async fn get_gmail_client(state: &AppState) -> Result<GmailClient, Error> {
    let account_id = {
        let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        resolve_account_id(&conn)?
    };
    let token = oauth::get_valid_token(&state.db, &account_id).await?;
    Ok(GmailClient::new(token))
}

/// Get a GmailClient plus the sender's email and display name (for compose/reply).
async fn get_gmail_client_with_sender(state: &AppState) -> Result<(GmailClient, String, String), Error> {
    let (account_id, email, name) = {
        let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        let aid = resolve_account_id(&conn)?;
        let row: (String, Option<String>) = conn
            .query_row(
                "SELECT email, display_name FROM accounts WHERE id = ?1",
                [&aid],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| Error::Auth("No active account.".into()))?;
        (aid, row.0, row.1)
    };
    let token = oauth::get_valid_token(&state.db, &account_id).await?;
    let display = name.unwrap_or_else(|| email.clone());
    Ok((GmailClient::new(token), email, display))
}

/// Fetch thread metadata for a list of stubs concurrently, returning ThreadRows.
async fn fetch_thread_with_retry(
    client: &GmailClient,
    thread_id: &str,
    max_retries: u32,
) -> Result<crate::integrations::gmail::client::GmailThread, Error> {
    let mut attempt = 0;
    loop {
        match client.get_thread(thread_id).await {
            Ok(thread) => return Ok(thread),
            Err(e) => {
                let is_rate_limit = format!("{e}").contains("429");
                if is_rate_limit && attempt < max_retries {
                    attempt += 1;
                    let delay = std::time::Duration::from_millis(500 * 2u64.pow(attempt - 1));
                    log::info!("Rate limited fetching thread {thread_id}, retry {attempt}/{max_retries} after {delay:?}");
                    tokio::time::sleep(delay).await;
                } else {
                    return Err(e);
                }
            }
        }
    }
}

async fn stubs_to_thread_rows(
    stubs: Vec<ThreadStub>,
    client: &GmailClient,
    concurrency: usize,
) -> Vec<ThreadRow> {
    let results: Vec<Option<ThreadRow>> = stream::iter(stubs)
        .map(|stub| {
            let client = client.clone();
            async move {
                let snippet_text = stub.snippet.unwrap_or_default();
                match fetch_thread_with_retry(&client, &stub.id, 3).await {
                    Ok(thread) => {
                        let messages = thread.messages.unwrap_or_default();
                        if messages.is_empty() {
                            return None;
                        }
                        let last_msg = messages.last().unwrap();
                        let first_msg = messages.first().unwrap();

                        let subject = first_msg
                            .get_header("Subject")
                            .unwrap_or("(no subject)")
                            .to_string();
                        let from_raw = last_msg.get_header("From").unwrap_or("");
                        let (from_name, from_email) = parse_from(from_raw);

                        let date_display = last_msg
                            .internal_date
                            .as_ref()
                            .and_then(|d| d.parse::<i64>().ok())
                            .and_then(|ms| chrono::DateTime::from_timestamp_millis(ms))
                            .map(|dt| dt.format("%b %d").to_string())
                            .unwrap_or_default();

                        let is_read = last_msg
                            .label_ids
                            .as_ref()
                            .map(|labels| !labels.iter().any(|l| l == "UNREAD"))
                            .unwrap_or(true);

                        Some(ThreadRow {
                            id: thread.id.clone(),
                            gmail_thread_id: thread.id,
                            subject,
                            snippet: snippet_text,
                            from_name,
                            from_email,
                            date: date_display,
                            is_read,
                            message_count: messages.len() as u32,
                            label_ids: None,
                            sender_emails: None,
                            is_calendar: None,
                        })
                    }
                    Err(e) => {
                        log::warn!("Failed to fetch thread {}: {e}", stub.id);
                        None
                    }
                }
            }
        })
        .buffered(concurrency)
        .collect()
        .await;

    results.into_iter().flatten().collect()
}

/// Parameters for building an RFC 2822 email message.
struct EmailParams {
    from_display: String,
    from_email: String,
    to: String,
    cc: Option<String>,
    bcc: Option<String>,
    subject: String,
    body: String,
    body_html: Option<String>,
    in_reply_to: Option<String>,
}

/// Build an RFC 2822 MIME message (multipart/alternative with plain + HTML).
fn build_rfc2822(params: &EmailParams) -> String {
    let body_plain = params.body.clone();
    let body_html = if let Some(html) = &params.body_html {
        html.clone()
    } else {
        params.body
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('\n', "<br>")
    };

    let boundary = format!("----=_Part_{}", uuid::Uuid::new_v4().as_simple());
    let date = chrono::Utc::now().format("%a, %d %b %Y %H:%M:%S %z").to_string();

    let mut headers = format!(
        "From: {} <{}>\r\nTo: {}\r\n",
        params.from_display, params.from_email, params.to
    );
    if let Some(cc_val) = &params.cc {
        if !cc_val.trim().is_empty() {
            headers.push_str(&format!("Cc: {cc_val}\r\n"));
        }
    }
    if let Some(bcc_val) = &params.bcc {
        if !bcc_val.trim().is_empty() {
            headers.push_str(&format!("Bcc: {bcc_val}\r\n"));
        }
    }
    headers.push_str(&format!("Subject: {}\r\n", params.subject));
    if let Some(reply_id) = &params.in_reply_to {
        headers.push_str(&format!(
            "In-Reply-To: <{reply_id}>\r\nReferences: <{reply_id}>\r\n"
        ));
    }
    headers.push_str(&format!(
        "Date: {date}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=\"{boundary}\"\r\n"
    ));

    format!(
        "{headers}\r\n\
         --{boundary}\r\n\
         Content-Type: text/plain; charset=UTF-8\r\n\
         Content-Transfer-Encoding: base64\r\n\
         \r\n\
         {plain_b64}\r\n\
         --{boundary}\r\n\
         Content-Type: text/html; charset=UTF-8\r\n\
         Content-Transfer-Encoding: base64\r\n\
         \r\n\
         {html_b64}\r\n\
         --{boundary}--",
        plain_b64 = STANDARD.encode(body_plain.as_bytes()),
        html_b64 = STANDARD.encode(body_html.as_bytes()),
    )
}

// ── Data types ──

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRow {
    pub id: String,
    pub gmail_thread_id: String,
    pub subject: String,
    pub snippet: String,
    pub from_name: String,
    pub from_email: String,
    pub date: String,
    pub is_read: bool,
    pub message_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_emails: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_calendar: Option<bool>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxResponse {
    pub threads: Vec<ThreadRow>,
    pub next_page_token: Option<String>,
}

// ── Commands ──

/// Fetch inbox threads directly from Gmail API (no local cache yet — live fetch for design iteration).
#[tauri::command]
pub async fn list_inbox(
    state: State<'_, AppState>,
    max_results: Option<u32>,
    label_id: Option<String>,
    query: Option<String>,
) -> Result<InboxResponse, Error> {
    let client = get_gmail_client(&state).await?;

    // Fetch threads from Gmail, filtered by label or query
    let limit = max_results.unwrap_or(30);
    let list = if let Some(q) = &query {
        // Only prepend in:inbox for category split queries — all other queries
        // (search, label:, in:*) either manage their own scope or should search globally
        let full_query = if q.starts_with("category:") {
            format!("in:inbox {q}")
        } else {
            q.clone()
        };
        log::info!("list_inbox query: {full_query}");
        client.list_threads(Some(&full_query), limit, None, None).await?
    } else {
        let label_ids: Vec<&str> = match &label_id {
            Some(id) => vec!["INBOX", id.as_str()],
            None => vec!["INBOX"],
        };
        client.list_threads(None, limit, None, Some(&label_ids)).await?
    };

    let stubs = list.threads.unwrap_or_default();
    let stubs_count = stubs.len();
    log::info!("list_inbox: {} thread stubs from Gmail, next_page_token={}", stubs_count, list.next_page_token.as_deref().unwrap_or("none"));

    let threads = stubs_to_thread_rows(stubs, &client, 4).await;
    log::info!("list_inbox: returning {} threads (dropped {} failed/empty)", threads.len(), stubs_count - threads.len());

    Ok(InboxResponse {
        threads,
        next_page_token: list.next_page_token,
    })
}

/// Fetch all cached threads from SQLite for the active account.
/// The frontend filters these into splits locally — one call replaces N split queries.
#[tauri::command]
pub async fn list_inbox_cached(
    state: State<'_, AppState>,
) -> Result<Vec<ThreadRow>, Error> {
    let threads = {
        let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        let account_id = resolve_account_id(&conn)?;

        let mut stmt = conn.prepare(
            "SELECT provider_thread_id, subject, snippet, from_name, from_email,
                    last_message_at, message_count, is_read, label_ids, sender_emails,
                    is_calendar
             FROM threads
             WHERE account_id = ?1
             ORDER BY CAST(last_message_at AS INTEGER) DESC
             LIMIT 1000"
        )?;

        let rows = stmt.query_map([&account_id], |row| {
            let provider_id: String = row.get(0)?;
            let last_message_at: String = row.get(5)?;
            let is_read: bool = row.get(7)?;
            let label_ids_json: String = row.get(8)?;
            let sender_emails_json: String = row.get(9)?;
            let is_calendar: bool = row.get(10)?;

            let date_display = last_message_at
                .parse::<i64>()
                .ok()
                .and_then(|ms| chrono::DateTime::from_timestamp_millis(ms))
                .map(|dt| dt.format("%b %d").to_string())
                .unwrap_or_default();

            let label_ids: Vec<String> =
                serde_json::from_str(&label_ids_json).unwrap_or_default();
            let sender_emails: Vec<String> =
                serde_json::from_str(&sender_emails_json).unwrap_or_default();

            Ok(ThreadRow {
                id: provider_id.clone(),
                gmail_thread_id: provider_id,
                subject: row.get(1)?,
                snippet: row.get(2)?,
                from_name: row.get(3)?,
                from_email: row.get(4)?,
                date: date_display,
                is_read,
                message_count: row.get(6)?,
                label_ids: Some(label_ids),
                sender_emails: Some(sender_emails),
                is_calendar: Some(is_calendar),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
        rows
    };

    log::info!("list_inbox_cached: returning {} threads", threads.len());
    Ok(threads)
}

/// Archive a thread (remove INBOX label in Gmail).
#[tauri::command]
pub async fn archive_thread(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<(), Error> {
    // Optimistic cache update
    {
        let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        let account_id = resolve_account_id(&conn)?;
        let _ = crate::db::threads::update_cached_labels(&conn, &account_id, &thread_id, &[], &["INBOX"]);
    }
    let client = get_gmail_client(&state).await?;
    client.modify_thread(&thread_id, &[], &["INBOX"]).await?;
    log::info!("Archived thread {thread_id}");
    Ok(())
}

/// Move a thread to trash in Gmail.
#[tauri::command]
pub async fn trash_thread(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<(), Error> {
    {
        let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        let account_id = resolve_account_id(&conn)?;
        let _ = crate::db::threads::update_cached_labels(&conn, &account_id, &thread_id, &["TRASH"], &["INBOX"]);
    }
    let client = get_gmail_client(&state).await?;
    client.modify_thread(&thread_id, &["TRASH"], &["INBOX"]).await?;
    log::info!("Trashed thread {thread_id}");
    Ok(())
}

/// Mark a thread as read (remove UNREAD label in Gmail).
#[tauri::command]
pub async fn mark_thread_read(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<(), Error> {
    {
        let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        let account_id = resolve_account_id(&conn)?;
        let _ = crate::db::threads::update_cached_labels(&conn, &account_id, &thread_id, &[], &["UNREAD"]);
    }
    let client = get_gmail_client(&state).await?;
    client.modify_thread(&thread_id, &[], &["UNREAD"]).await?;
    log::info!("Marked thread {thread_id} as read");
    Ok(())
}

/// Mark a thread as unread (add UNREAD label in Gmail).
#[tauri::command]
pub async fn mark_thread_unread(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<(), Error> {
    {
        let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        let account_id = resolve_account_id(&conn)?;
        let _ = crate::db::threads::update_cached_labels(&conn, &account_id, &thread_id, &["UNREAD"], &[]);
    }
    let client = get_gmail_client(&state).await?;
    client.modify_thread(&thread_id, &["UNREAD"], &[]).await?;
    log::info!("Marked thread {thread_id} as unread");
    Ok(())
}

/// Star or unstar a thread in Gmail.
#[tauri::command]
pub async fn star_thread(
    state: State<'_, AppState>,
    thread_id: String,
    starred: bool,
) -> Result<(), Error> {
    {
        let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        let account_id = resolve_account_id(&conn)?;
        if starred {
            let _ = crate::db::threads::update_cached_labels(&conn, &account_id, &thread_id, &["STARRED"], &[]);
        } else {
            let _ = crate::db::threads::update_cached_labels(&conn, &account_id, &thread_id, &[], &["STARRED"]);
        }
    }
    let client = get_gmail_client(&state).await?;
    if starred {
        client.modify_thread(&thread_id, &["STARRED"], &[]).await?;
    } else {
        client.modify_thread(&thread_id, &[], &["STARRED"]).await?;
    }
    log::info!("Set starred={starred} on thread {thread_id}");
    Ok(())
}

/// Report a thread as spam (add SPAM, remove INBOX).
#[tauri::command]
pub async fn spam_thread(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<(), Error> {
    {
        let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        let account_id = resolve_account_id(&conn)?;
        let _ = crate::db::threads::update_cached_labels(&conn, &account_id, &thread_id, &["SPAM"], &["INBOX"]);
    }
    let client = get_gmail_client(&state).await?;
    client.modify_thread(&thread_id, &["SPAM"], &["INBOX"]).await?;
    log::info!("Reported thread {thread_id} as spam");
    Ok(())
}

/// Add or remove labels on a thread.
#[tauri::command]
pub async fn modify_thread_labels(
    state: State<'_, AppState>,
    thread_id: String,
    add_label_ids: Vec<String>,
    remove_label_ids: Vec<String>,
) -> Result<(), Error> {
    {
        let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        let account_id = resolve_account_id(&conn)?;
        let add: Vec<&str> = add_label_ids.iter().map(|s| s.as_str()).collect();
        let remove: Vec<&str> = remove_label_ids.iter().map(|s| s.as_str()).collect();
        let _ = crate::db::threads::update_cached_labels(&conn, &account_id, &thread_id, &add, &remove);
    }
    let client = get_gmail_client(&state).await?;
    let add: Vec<&str> = add_label_ids.iter().map(|s| s.as_str()).collect();
    let remove: Vec<&str> = remove_label_ids.iter().map(|s| s.as_str()).collect();
    client.modify_thread(&thread_id, &add, &remove).await?;
    log::info!("Modified labels on thread {thread_id}: +{add_label_ids:?} -{remove_label_ids:?}");
    Ok(())
}

/// Get the List-Unsubscribe URL from the last message in a thread.
#[tauri::command]
pub async fn get_unsubscribe_url(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<Option<String>, Error> {
    let client = get_gmail_client(&state).await?;
    let thread = client.get_thread_full(&thread_id).await?;
    let messages = thread.messages.unwrap_or_default();
    let last = match messages.last() {
        Some(m) => m,
        None => return Ok(None),
    };
    // Look for List-Unsubscribe header
    let header = last.get_header("List-Unsubscribe").unwrap_or("");
    // Extract HTTP URL from header (may contain mailto: and http:// variants)
    let url = header
        .split(',')
        .map(|s| s.trim().trim_start_matches('<').trim_end_matches('>'))
        .find(|s| s.starts_with("http://") || s.starts_with("https://"));
    Ok(url.map(|s| s.to_string()))
}

/// Download a thread's last message as raw RFC 2822 (.eml format).
#[tauri::command]
pub async fn download_eml(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<String, Error> {
    let client = get_gmail_client(&state).await?;
    let thread = client.get_thread(&thread_id).await?;
    let messages = thread.messages.unwrap_or_default();
    let last = messages.last().ok_or(Error::Internal("No messages in thread".into()))?;
    let raw_b64 = client.get_message_raw(&last.id).await?;
    let bytes = URL_SAFE_NO_PAD.decode(&raw_b64).or_else(|_| URL_SAFE.decode(&raw_b64)).or_else(|_| STANDARD.decode(&raw_b64)).map_err(|e| Error::Internal(format!("Base64 decode: {e}")))?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

// ── Fast search (lightweight, 10 results max, high concurrency) ──

#[tauri::command]
pub async fn search_threads(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<ThreadRow>, Error> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }

    let client = get_gmail_client(&state).await?;
    let list = client.list_threads(Some(&query), 10, None, None).await?;
    let stubs = list.threads.unwrap_or_default();

    let threads = stubs_to_thread_rows(stubs, &client, 4).await;
    Ok(threads)
}

// ── Thread detail (full message bodies) ──

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDetail {
    pub id: String,
    pub subject: String,
    pub messages: Vec<MessageDetail>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDetail {
    pub id: String,
    pub from_name: String,
    pub from_email: String,
    pub to: String,
    pub cc: String,
    pub date: String,
    pub body_html: String,
}

/// Fetch a thread with full message bodies from Gmail.
#[tauri::command]
pub async fn get_thread_detail(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<ThreadDetail, Error> {
    let client = get_gmail_client(&state).await?;
    let thread = client.get_thread_full(&thread_id).await?;

    let messages = thread.messages.unwrap_or_default();
    let subject = messages
        .first()
        .and_then(|m| m.get_header("Subject"))
        .unwrap_or("(no subject)")
        .to_string();

    let mut details: Vec<MessageDetail> = Vec::with_capacity(messages.len());
    for msg in &messages {
        let from_raw = msg.get_header("From").unwrap_or("");
        let (from_name, from_email) = parse_from(from_raw);

        let to = msg.get_header("To").unwrap_or("").to_string();
        let cc = msg.get_header("Cc").unwrap_or("").to_string();

        let date = msg
            .internal_date
            .as_ref()
            .and_then(|d| d.parse::<i64>().ok())
            .and_then(|ms| chrono::DateTime::from_timestamp_millis(ms))
            .map(|dt| dt.format("%b %d, %l:%M %p").to_string())
            .unwrap_or_else(|| {
                msg.get_header("Date").unwrap_or("").to_string()
            });

        let body_html = extract_body(msg, &client).await;

        details.push(MessageDetail {
            id: msg.id.clone(),
            from_name,
            from_email,
            to,
            cc,
            date,
            body_html,
        });
    }

    log::info!(
        "get_thread_detail: {} messages for thread {}",
        details.len(),
        thread_id
    );

    Ok(ThreadDetail {
        id: thread.id,
        subject,
        messages: details,
    })
}

/// Extract HTML or plain-text body from a Gmail message, sanitize it.
/// Fetches large bodies from the attachment endpoint when inline data is missing.
async fn extract_body(msg: &GmailMessage, client: &GmailClient) -> String {
    let payload = match &msg.payload {
        Some(p) => p,
        None => {
            log::warn!("Message {} has no payload, using snippet", msg.id);
            let snippet = msg.snippet.clone().unwrap_or_default();
            return format!("<p>{}</p>", ammonia::clean(&snippet));
        }
    };

    log::info!(
        "extract_body msg={} mime={} has_body_data={} has_parts={}",
        msg.id,
        payload.mime_type.as_deref().unwrap_or("?"),
        payload.body.as_ref().and_then(|b| b.data.as_ref()).map(|d| d.len()).unwrap_or(0),
        payload.parts.as_ref().map(|p| p.len()).unwrap_or(0),
    );

    // Try to find text/html, then text/plain — check parts tree first, then payload body
    let html = resolve_part_data(payload, "text/html", &msg.id, client).await;
    let plain = if html.is_some() {
        None
    } else {
        resolve_part_data(payload, "text/plain", &msg.id, client).await
    };

    if let Some(data) = html {
        let decoded = decode_base64url(&data);
        if !decoded.is_empty() {
            return sanitize_html(&decoded);
        }
        log::warn!("HTML body decoded to empty for message {}", msg.id);
    }

    if let Some(data) = plain {
        let text = decode_base64url(&data);
        if !text.is_empty() {
            // Escape HTML entities and wrap — no need to run through sanitize_html
            // since we're producing the HTML ourselves from plain text
            let escaped = text
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
                .replace('\n', "<br>");
            return format!("<div style=\"white-space:pre-wrap;word-break:break-word\">{escaped}</div>");
        }
        log::warn!("Plain text body decoded to empty for message {}", msg.id);
    }

    // Last resort: use the snippet (already HTML-safe from Gmail)
    log::warn!(
        "No body found for message {}, mime={}, using snippet",
        msg.id,
        payload.mime_type.as_deref().unwrap_or("?")
    );
    let snippet = msg.snippet.clone().unwrap_or_default();
    format!("<p>{}</p>", ammonia::clean(&snippet))
}

/// Look for a MIME type in parts tree, then payload body. If body has an
/// attachmentId instead of inline data, fetch it from the Gmail attachment API.
async fn resolve_part_data(
    payload: &MessagePayload,
    mime_type: &str,
    message_id: &str,
    client: &GmailClient,
) -> Option<String> {
    // 1. Search recursively in parts
    if let Some(found) = find_part_data_or_attachment(payload.parts.as_deref(), mime_type) {
        return match found {
            PartData::Inline(data) => Some(data),
            PartData::AttachmentId(aid) => {
                client.get_attachment(message_id, &aid).await.ok()
            }
        };
    }

    // 2. Check the payload body directly (non-multipart messages)
    if payload.mime_type.as_deref() == Some(mime_type) {
        if let Some(body) = &payload.body {
            if let Some(data) = &body.data {
                if !data.is_empty() {
                    return Some(data.clone());
                }
            }
            if let Some(aid) = &body.attachment_id {
                return client.get_attachment(message_id, aid).await.ok();
            }
        }
    }

    None
}

enum PartData {
    Inline(String),
    AttachmentId(String),
}

/// Recursively find a MIME part by type, returning either inline data or attachment ID.
fn find_part_data_or_attachment(parts: Option<&[MessagePart]>, mime_type: &str) -> Option<PartData> {
    let parts = parts?;
    for part in parts {
        if part.mime_type.as_deref() == Some(mime_type) {
            if let Some(body) = &part.body {
                if let Some(data) = &body.data {
                    if !data.is_empty() {
                        return Some(PartData::Inline(data.clone()));
                    }
                }
                if let Some(aid) = &body.attachment_id {
                    return Some(PartData::AttachmentId(aid.clone()));
                }
            }
        }
        // Recurse into nested parts (multipart/alternative, multipart/related, etc.)
        if let Some(found) = find_part_data_or_attachment(part.parts.as_deref(), mime_type) {
            return Some(found);
        }
    }
    None
}

/// Decode Gmail's base64url-encoded body data.
/// Tries URL-safe no-pad first, then URL-safe with pad, then standard base64.
fn decode_base64url(data: &str) -> String {
    let bytes = URL_SAFE_NO_PAD
        .decode(data)
        .or_else(|_| URL_SAFE.decode(data))
        .or_else(|_| STANDARD.decode(data))
        .unwrap_or_else(|e| {
            log::warn!("Base64 decode failed (len={}): {e}", data.len());
            Vec::new()
        });
    String::from_utf8(bytes).unwrap_or_else(|e| {
        log::warn!("UTF-8 decode failed: {e}");
        String::new()
    })
}

fn sanitize_html(raw: &str) -> String {
    ammonia::Builder::default()
        .add_tag_attributes("a", &["href", "style"])
        .add_tag_attributes("img", &["src", "alt", "width", "height", "style"])
        .add_tag_attributes("p", &["style"])
        .add_tag_attributes("div", &["style", "dir"])
        .add_tag_attributes("span", &["style", "dir"])
        .add_tag_attributes("td", &["style", "colspan", "rowspan", "width", "align", "valign"])
        .add_tag_attributes("th", &["style", "colspan", "rowspan", "width", "align", "valign"])
        .add_tag_attributes("table", &["style", "width", "cellpadding", "cellspacing", "border"])
        .add_tag_attributes("tr", &["style"])
        .add_tag_attributes("font", &["color", "size", "face"])
        .add_tags(&["table", "thead", "tbody", "tr", "td", "th", "font", "center", "hr", "br"])
        .link_rel(Some("noopener noreferrer"))
        .url_relative(ammonia::UrlRelative::Deny)
        .clean(raw)
        .to_string()
}

/// Send a new email (not a reply).
#[tauri::command]
pub async fn send_email(
    state: State<'_, AppState>,
    to: String,
    cc: Option<String>,
    bcc: Option<String>,
    subject: String,
    body: String,
    body_html: Option<String>,
) -> Result<(), Error> {
    let (client, from_email, from_display) = get_gmail_client_with_sender(&state).await?;
    let raw = build_rfc2822(&EmailParams {
        from_display: sanitize_header(&from_display),
        from_email: sanitize_header(&from_email),
        to: sanitize_header(&to),
        cc: cc.map(|v| sanitize_header(&v)),
        bcc: bcc.map(|v| sanitize_header(&v)),
        subject: sanitize_header(&subject),
        body,
        body_html: body_html,
        in_reply_to: None,
    });
    let encoded = URL_SAFE_NO_PAD.encode(raw.as_bytes());
    client.send_message(&encoded).await?;
    log::info!("Sent new email to {to}");
    Ok(())
}

/// Send a reply to the last message in a thread.
#[tauri::command]
pub async fn send_reply(
    state: State<'_, AppState>,
    thread_id: String,
    message_id: String,
    to: String,
    cc: Option<String>,
    bcc: Option<String>,
    subject: String,
    body: String,
) -> Result<(), Error> {
    let (client, from_email, from_display) = get_gmail_client_with_sender(&state).await?;
    let raw = build_rfc2822(&EmailParams {
        from_display: sanitize_header(&from_display),
        from_email: sanitize_header(&from_email),
        to: sanitize_header(&to),
        cc: cc.map(|v| sanitize_header(&v)),
        bcc: bcc.map(|v| sanitize_header(&v)),
        subject: sanitize_header(&subject),
        body,
        body_html: None,
        in_reply_to: Some(sanitize_header(&message_id)),
    });
    let encoded = URL_SAFE_NO_PAD.encode(raw.as_bytes());
    client.send_message(&encoded).await?;
    log::info!("Sent reply in thread {thread_id} to {to}");
    Ok(())
}

/// Save (create or update) a draft in Gmail.
/// Returns the draft ID so the frontend can update it in-place.
#[tauri::command]
pub async fn save_draft(
    state: State<'_, AppState>,
    draft_id: Option<String>,
    to: String,
    cc: Option<String>,
    bcc: Option<String>,
    subject: String,
    body: String,
    body_html: Option<String>,
) -> Result<String, Error> {
    let (client, from_email, from_display) = get_gmail_client_with_sender(&state).await?;
    let raw = build_rfc2822(&EmailParams {
        from_display: sanitize_header(&from_display),
        from_email: sanitize_header(&from_email),
        to: sanitize_header(&to),
        cc: cc.map(|v| sanitize_header(&v)),
        bcc: bcc.map(|v| sanitize_header(&v)),
        subject: sanitize_header(&subject),
        body,
        body_html,
        in_reply_to: None,
    });
    let encoded = URL_SAFE_NO_PAD.encode(raw.as_bytes());

    let id = if let Some(existing_id) = draft_id {
        client.update_draft(&existing_id, &encoded).await?;
        log::info!("Updated draft {existing_id}");
        existing_id
    } else {
        let new_id = client.create_draft(&encoded).await?;
        log::info!("Created draft {new_id}");
        new_id
    };

    Ok(id)
}

/// Delete a draft from Gmail.
#[tauri::command]
pub async fn delete_draft(
    state: State<'_, AppState>,
    draft_id: String,
) -> Result<(), Error> {
    let (client, _, _) = get_gmail_client_with_sender(&state).await?;
    client.delete_draft(&draft_id).await?;
    log::info!("Deleted draft {draft_id}");
    Ok(())
}

/// Strip CR/LF from a header value to prevent CRLF injection.
fn sanitize_header(val: &str) -> String {
    val.replace(['\r', '\n'], "")
}

/// Parse "Name <email>" or "email" format.
fn parse_from(raw: &str) -> (String, String) {
    if let Some(bracket_start) = raw.find('<') {
        let name = raw[..bracket_start].trim().trim_matches('"').to_string();
        let email = raw[bracket_start + 1..]
            .trim_end_matches('>')
            .trim()
            .to_string();
        (
            if name.is_empty() { email.clone() } else { name },
            email,
        )
    } else {
        (raw.trim().to_string(), raw.trim().to_string())
    }
}
