use base64::engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use futures::stream::{self, StreamExt};
use tauri::State;

use crate::error::Error;
use crate::integrations::gmail::client::{GmailClient, GmailMessage, MessagePayload, MessagePart};
use crate::integrations::gmail::oauth;
use crate::state::AppState;

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
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxResponse {
    pub threads: Vec<ThreadRow>,
    pub next_page_token: Option<String>,
}

/// Fetch inbox threads directly from Gmail API (no local cache yet — live fetch for design iteration).
#[tauri::command]
pub async fn list_inbox(
    state: State<'_, AppState>,
    max_results: Option<u32>,
    label_id: Option<String>,
    query: Option<String>,
) -> Result<InboxResponse, Error> {
    // Get the first active account
    let account_id = {
        let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        let id: String = conn
            .query_row(
                "SELECT id FROM accounts WHERE is_active = 1 ORDER BY created_at ASC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .map_err(|_| Error::Auth("No active account. Please sign in.".into()))?;
        id
    };

    // Get a valid token (auto-refreshes if expired)
    let token = oauth::get_valid_token(&state.db, &account_id).await?;
    let client = GmailClient::new(token);

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

    // Fetch thread metadata concurrently (up to 10 in parallel to respect rate limits)
    let results: Vec<Option<ThreadRow>> = stream::iter(stubs)
        .map(|stub| {
            let client = client.clone();
            async move {
                let snippet_text = stub.snippet.unwrap_or_default();
                match client.get_thread(&stub.id).await {
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

                        let date = last_msg
                            .get_header("Date")
                            .unwrap_or("")
                            .to_string();

                        let date_display = last_msg
                            .internal_date
                            .as_ref()
                            .and_then(|d| d.parse::<i64>().ok())
                            .map(|ms| {
                                chrono::DateTime::from_timestamp_millis(ms)
                                    .map(|dt| dt.format("%b %d").to_string())
                                    .unwrap_or_default()
                            })
                            .unwrap_or(date);

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
                        })
                    }
                    Err(e) => {
                        log::warn!("Failed to fetch thread {}: {e}", stub.id);
                        None
                    }
                }
            }
        })
        .buffered(10)
        .collect()
        .await;

    let threads: Vec<ThreadRow> = results.into_iter().flatten().collect();
    log::info!("list_inbox: returning {} threads (dropped {} failed/empty)", threads.len(), stubs_count - threads.len());

    Ok(InboxResponse {
        threads,
        next_page_token: list.next_page_token,
    })
}

/// Lightweight unread-thread counts for each split (concurrent, 1 API call per split).
/// Receives pre-built queries from the frontend (already include exclusions).
#[tauri::command]
pub async fn get_unread_counts(
    state: State<'_, AppState>,
    splits: Vec<SplitQueryInput>,
) -> Result<Vec<SplitUnreadCount>, Error> {
    let account_id = {
        let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        conn.query_row(
            "SELECT id FROM accounts WHERE is_active = 1 ORDER BY created_at ASC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| Error::Auth("No active account.".into()))?
    };

    let token = oauth::get_valid_token(&state.db, &account_id).await?;
    let client = GmailClient::new(token);

    let counts: Vec<SplitUnreadCount> = stream::iter(splits)
        .map(|split| {
            let client = client.clone();
            async move {
                // The query already has the right scope (in:inbox or label:X) — just add is:unread
                let q = if split.query.is_empty() {
                    "in:inbox is:unread".to_string()
                } else if split.query.starts_with("label:") {
                    format!("is:unread {}", split.query)
                } else {
                    // Query already starts with "in:inbox ..." from frontend's buildQueryForSplit
                    format!("is:unread {}", split.query)
                };

                let count = client
                    .list_threads(Some(&q), 200, None, None)
                    .await
                    .map(|r| r.threads.map(|t| t.len() as u32).unwrap_or(0))
                    .unwrap_or(0);

                SplitUnreadCount { id: split.id, unread_count: count }
            }
        })
        .buffered(5)
        .collect()
        .await;

    Ok(counts)
}

#[derive(Debug, serde::Deserialize)]
pub struct SplitQueryInput {
    pub id: String,
    pub query: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitUnreadCount {
    pub id: String,
    pub unread_count: u32,
}

/// Archive a thread (remove INBOX label in Gmail).
#[tauri::command]
pub async fn archive_thread(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<(), Error> {
    let account_id = {
        let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        conn.query_row(
            "SELECT id FROM accounts WHERE is_active = 1 ORDER BY created_at ASC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| Error::Auth("No active account.".into()))?
    };

    let token = oauth::get_valid_token(&state.db, &account_id).await?;
    let client = GmailClient::new(token);
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
    let account_id = {
        let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        conn.query_row(
            "SELECT id FROM accounts WHERE is_active = 1 ORDER BY created_at ASC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| Error::Auth("No active account.".into()))?
    };

    let token = oauth::get_valid_token(&state.db, &account_id).await?;
    let client = GmailClient::new(token);
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
    let account_id = {
        let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        conn.query_row(
            "SELECT id FROM accounts WHERE is_active = 1 ORDER BY created_at ASC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| Error::Auth("No active account.".into()))?
    };

    let token = oauth::get_valid_token(&state.db, &account_id).await?;
    let client = GmailClient::new(token);
    client.modify_thread(&thread_id, &[], &["UNREAD"]).await?;
    log::info!("Marked thread {thread_id} as read");
    Ok(())
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

    let account_id = {
        let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        conn.query_row(
            "SELECT id FROM accounts WHERE is_active = 1 ORDER BY created_at ASC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| Error::Auth("No active account.".into()))?
    };

    let token = oauth::get_valid_token(&state.db, &account_id).await?;
    let client = GmailClient::new(token);

    let list = client.list_threads(Some(&query), 10, None, None).await?;
    let stubs = list.threads.unwrap_or_default();

    // Fetch all 10 in parallel — metadata only, very fast
    let results: Vec<Option<ThreadRow>> = stream::iter(stubs)
        .map(|stub| {
            let client = client.clone();
            async move {
                let snippet_text = stub.snippet.unwrap_or_default();
                match client.get_thread(&stub.id).await {
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
                        })
                    }
                    Err(e) => {
                        log::warn!("Search: failed to fetch thread {}: {e}", stub.id);
                        None
                    }
                }
            }
        })
        .buffered(10)
        .collect()
        .await;

    Ok(results.into_iter().flatten().collect())
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
    let account_id = {
        let conn = state
            .db
            .lock()
            .map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        conn.query_row(
            "SELECT id FROM accounts WHERE is_active = 1 ORDER BY created_at ASC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| Error::Auth("No active account.".into()))?
    };

    let token = oauth::get_valid_token(&state.db, &account_id).await?;
    let client = GmailClient::new(token);
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
) -> Result<(), Error> {
    let (account_id, from_email, from_name) = {
        let conn = state
            .db
            .lock()
            .map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        let row: (String, String, Option<String>) = conn
            .query_row(
                "SELECT id, email, display_name FROM accounts WHERE is_active = 1 ORDER BY created_at ASC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|_| Error::Auth("No active account.".into()))?;
        row
    };

    let token = oauth::get_valid_token(&state.db, &account_id).await?;
    let client = GmailClient::new(token);

    let from_display = sanitize_header(&from_name.unwrap_or_else(|| from_email.clone()));
    let from_email = sanitize_header(&from_email);
    let to = sanitize_header(&to);
    let subject = sanitize_header(&subject);
    let date = chrono::Utc::now().format("%a, %d %b %Y %H:%M:%S %z").to_string();

    let body_with_sig = format!("{body}\n\n---\nSent with Memphis");
    let body_plain = body_with_sig.clone();
    let body_html = body_with_sig
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\n', "<br>");

    let boundary = format!("----=_Part_{}", uuid::Uuid::new_v4().as_simple());

    let mut headers = format!(
        "From: {from_display} <{from_email}>\r\n\
         To: {to}\r\n"
    );
    if let Some(cc_val) = &cc {
        let cc_val = sanitize_header(cc_val);
        if !cc_val.trim().is_empty() {
            headers.push_str(&format!("Cc: {cc_val}\r\n"));
        }
    }
    if let Some(bcc_val) = &bcc {
        let bcc_val = sanitize_header(bcc_val);
        if !bcc_val.trim().is_empty() {
            headers.push_str(&format!("Bcc: {bcc_val}\r\n"));
        }
    }
    headers.push_str(&format!(
        "Subject: {subject}\r\n\
         Date: {date}\r\n\
         MIME-Version: 1.0\r\n\
         Content-Type: multipart/alternative; boundary=\"{boundary}\"\r\n"
    ));

    let raw_message = format!(
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
    );

    let encoded = URL_SAFE_NO_PAD.encode(raw_message.as_bytes());
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
    let (account_id, from_email, from_name) = {
        let conn = state
            .db
            .lock()
            .map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        let row: (String, String, Option<String>) = conn
            .query_row(
                "SELECT id, email, display_name FROM accounts WHERE is_active = 1 ORDER BY created_at ASC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|_| Error::Auth("No active account.".into()))?;
        row
    };

    let token = oauth::get_valid_token(&state.db, &account_id).await?;
    let client = GmailClient::new(token);

    // Build RFC 2822 message
    let from_display = sanitize_header(&from_name.unwrap_or_else(|| from_email.clone()));
    let from_email = sanitize_header(&from_email);
    let to = sanitize_header(&to);
    let subject = sanitize_header(&subject);
    let message_id = sanitize_header(&message_id);
    let date = chrono::Utc::now().format("%a, %d %b %Y %H:%M:%S %z").to_string();

    // Escape body for plain text, and produce a simple HTML version
    let body_with_sig = format!("{body}\n\n---\nSent with Memphis");
    let body_plain = body_with_sig.clone();
    let body_html = body_with_sig
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\n', "<br>");

    let boundary = format!("----=_Part_{}", uuid::Uuid::new_v4().as_simple());

    // Build headers, conditionally adding Cc and Bcc
    let mut headers = format!(
        "From: {from_display} <{from_email}>\r\n\
         To: {to}\r\n"
    );
    if let Some(cc_val) = &cc {
        let cc_val = sanitize_header(cc_val);
        if !cc_val.trim().is_empty() {
            headers.push_str(&format!("Cc: {cc_val}\r\n"));
        }
    }
    if let Some(bcc_val) = &bcc {
        let bcc_val = sanitize_header(bcc_val);
        if !bcc_val.trim().is_empty() {
            headers.push_str(&format!("Bcc: {bcc_val}\r\n"));
        }
    }
    headers.push_str(&format!(
        "Subject: {subject}\r\n\
         In-Reply-To: <{message_id}>\r\n\
         References: <{message_id}>\r\n\
         Date: {date}\r\n\
         MIME-Version: 1.0\r\n\
         Content-Type: multipart/alternative; boundary=\"{boundary}\"\r\n"
    ));

    let raw_message = format!(
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
        plain_b64 = URL_SAFE_NO_PAD.encode(body_plain.as_bytes()),
        html_b64 = URL_SAFE_NO_PAD.encode(body_html.as_bytes()),
    );

    // Gmail wants base64url-encoded raw message
    let encoded = URL_SAFE_NO_PAD.encode(raw_message.as_bytes());

    client.send_message(&encoded).await?;
    log::info!("Sent reply in thread {thread_id} to {to}");

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
