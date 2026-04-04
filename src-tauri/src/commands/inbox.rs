use futures::stream::{self, StreamExt};
use tauri::State;

use crate::error::Error;
use crate::integrations::gmail::client::GmailClient;
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
        // label: queries may include archived emails — don't force in:inbox
        let full_query = if q.starts_with("label:") {
            q.clone()
        } else {
            format!("in:inbox {q}")
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
