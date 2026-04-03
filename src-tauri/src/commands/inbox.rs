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

    // Fetch threads from Gmail
    let limit = max_results.unwrap_or(30);
    let list = client.list_threads(Some("in:inbox"), limit, None).await?;

    let stubs = list.threads.unwrap_or_default();
    let mut threads = Vec::with_capacity(stubs.len());

    // Fetch metadata for each thread (batch in the future, sequential for now)
    for stub in &stubs {
        match client.get_thread(&stub.id).await {
            Ok(thread) => {
                let messages = thread.messages.unwrap_or_default();
                if messages.is_empty() {
                    continue;
                }

                // Use the last message for display
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

                // Parse internal date (millis since epoch)
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

                let snippet = stub
                    .snippet
                    .as_deref()
                    .unwrap_or("")
                    .to_string();

                threads.push(ThreadRow {
                    id: thread.id.clone(),
                    gmail_thread_id: thread.id,
                    subject,
                    snippet,
                    from_name,
                    from_email,
                    date: date_display,
                    is_read,
                    message_count: messages.len() as u32,
                });
            }
            Err(e) => {
                log::warn!("Failed to fetch thread {}: {e}", stub.id);
            }
        }
    }

    Ok(InboxResponse {
        threads,
        next_page_token: list.next_page_token,
    })
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
