use std::collections::HashSet;

use crate::integrations::gmail::client::GmailThread;

/// Thread data ready for SQLite upsert.
pub struct CachedThread {
    pub provider_thread_id: String,
    pub subject: String,
    pub snippet: String,
    pub from_name: String,
    pub from_email: String,
    pub last_message_at: String, // millis as string (matches Gmail internalDate)
    pub message_count: u32,
    pub is_read: bool,
    pub is_starred: bool,
    pub is_archived: bool,
    pub is_trashed: bool,
    pub label_ids: Vec<String>,
    pub sender_emails: Vec<String>, // all unique sender emails across all messages
}

/// Convert a GmailThread (metadata format) into a CachedThread for local storage.
pub fn map_gmail_thread(thread: &GmailThread) -> Option<CachedThread> {
    let messages = thread.messages.as_ref()?;
    if messages.is_empty() {
        return None;
    }

    let first_msg = &messages[0];
    let last_msg = &messages[messages.len() - 1];

    let subject = first_msg
        .get_header("Subject")
        .unwrap_or("(no subject)")
        .to_string();

    let from_raw = last_msg.get_header("From").unwrap_or("");
    let (from_name, from_email) = parse_from(from_raw);

    let snippet = last_msg.snippet.clone().unwrap_or_default();

    let last_message_at = last_msg
        .internal_date
        .clone()
        .unwrap_or_default();

    // Collect unique labels and sender emails across all messages
    let mut all_labels = HashSet::new();
    let mut all_senders = HashSet::new();
    for msg in messages {
        if let Some(labels) = &msg.label_ids {
            all_labels.extend(labels.iter().cloned());
        }
        if let Some(from_raw) = msg.get_header("From") {
            let (_, email) = parse_from(from_raw);
            if !email.is_empty() {
                all_senders.insert(email.to_lowercase());
            }
        }
    }

    let is_read = !all_labels.contains("UNREAD");
    let is_starred = all_labels.contains("STARRED");
    let is_archived = !all_labels.contains("INBOX");
    let is_trashed = all_labels.contains("TRASH");

    Some(CachedThread {
        provider_thread_id: thread.id.clone(),
        subject,
        snippet,
        from_name,
        from_email,
        last_message_at,
        message_count: messages.len() as u32,
        is_read,
        is_starred,
        is_archived,
        is_trashed,
        label_ids: all_labels.into_iter().collect(),
        sender_emails: all_senders.into_iter().collect(),
    })
}

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
