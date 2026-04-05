use crate::error::Error;
use serde::Deserialize;

const GMAIL_API: &str = "https://www.googleapis.com/gmail/v1/users/me";

#[derive(Clone)]
pub struct GmailClient {
    http: reqwest::Client,
    access_token: String,
}

impl GmailClient {
    pub fn new(access_token: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            access_token,
        }
    }

    // ── Internal helpers ──

    async fn get_json<T: serde::de::DeserializeOwned>(&self, url: &str) -> Result<T, Error> {
        let resp = self.http.get(url).bearer_auth(&self.access_token).send().await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            if status == reqwest::StatusCode::NOT_FOUND {
                return Err(Error::NotFound(format!("Gmail API 404: {body}")));
            }
            return Err(Error::Internal(format!("Gmail API {status}: {body}")));
        }
        Ok(resp.json().await?)
    }

    async fn post_json(&self, url: &str, body: &impl serde::Serialize) -> Result<(), Error> {
        let resp = self.http.post(url).bearer_auth(&self.access_token).json(body).send().await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(Error::Internal(format!("Gmail API {status}: {text}")));
        }
        Ok(())
    }

    // ── Public API ──

    /// List threads in the user's mailbox.
    pub async fn list_threads(
        &self,
        query: Option<&str>,
        max_results: u32,
        page_token: Option<&str>,
        label_ids: Option<&[&str]>,
    ) -> Result<ThreadListResponse, Error> {
        let mut url = format!("{GMAIL_API}/threads?maxResults={max_results}");
        if let Some(q) = query {
            url.push_str(&format!("&q={}", urlencoding::encode(q)));
        }
        if let Some(pt) = page_token {
            url.push_str(&format!("&pageToken={pt}"));
        }
        if let Some(ids) = label_ids {
            for id in ids {
                url.push_str(&format!("&labelIds={id}"));
            }
        }

        self.get_json(&url).await
    }

    /// Get a single thread with all messages (metadata format for speed).
    pub async fn get_thread(&self, thread_id: &str) -> Result<GmailThread, Error> {
        let url = format!("{GMAIL_API}/threads/{thread_id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date");
        self.get_json(&url).await
    }

    /// Get a single thread with full message bodies.
    pub async fn get_thread_full(&self, thread_id: &str) -> Result<GmailThread, Error> {
        let url = format!("{GMAIL_API}/threads/{thread_id}?format=full");
        self.get_json(&url).await
    }

    /// List all labels in the user's mailbox.
    pub async fn list_labels(&self) -> Result<LabelListResponse, Error> {
        let url = format!("{GMAIL_API}/labels");
        self.get_json(&url).await
    }

    /// Fetch attachment data by ID (for large message bodies stored as attachments).
    pub async fn get_attachment(
        &self,
        message_id: &str,
        attachment_id: &str,
    ) -> Result<String, Error> {
        let url = format!("{GMAIL_API}/messages/{message_id}/attachments/{attachment_id}");

        #[derive(Deserialize)]
        struct AttachmentResponse {
            data: Option<String>,
        }
        let att: AttachmentResponse = self.get_json(&url).await?;
        Ok(att.data.unwrap_or_default())
    }

    /// Send a raw RFC 2822 email message (base64url-encoded).
    pub async fn send_message(&self, raw: &str) -> Result<(), Error> {
        let url = format!("{GMAIL_API}/messages/send");
        let body = serde_json::json!({ "raw": raw });
        self.post_json(&url, &body).await
    }

    /// Modify labels on a thread (archive = remove INBOX, etc.)
    pub async fn modify_thread(
        &self,
        thread_id: &str,
        add_labels: &[&str],
        remove_labels: &[&str],
    ) -> Result<(), Error> {
        let url = format!("{GMAIL_API}/threads/{thread_id}/modify");
        let body = serde_json::json!({
            "addLabelIds": add_labels,
            "removeLabelIds": remove_labels,
        });
        self.post_json(&url, &body).await
    }

    /// Get the user's profile (email, historyId).
    pub async fn get_profile(&self) -> Result<ProfileResponse, Error> {
        let url = format!("{GMAIL_API}/profile");
        self.get_json(&url).await
    }

    /// List history changes since the given historyId.
    /// Handles pagination internally, returning all changes.
    pub async fn list_history(&self, start_history_id: &str) -> Result<HistoryResponse, Error> {
        let mut all_records: Vec<HistoryRecord> = Vec::new();
        let mut page_token: Option<String> = None;
        let mut latest_history_id = String::new();

        loop {
            let mut url = format!(
                "{GMAIL_API}/history?startHistoryId={start_history_id}\
                 &historyTypes=messageAdded\
                 &historyTypes=labelAdded\
                 &historyTypes=labelRemoved"
            );
            if let Some(ref pt) = page_token {
                url.push_str(&format!("&pageToken={pt}"));
            }

            let page: HistoryListPage = self.get_json(&url).await?;
            latest_history_id = page.history_id;
            if let Some(records) = page.history {
                all_records.extend(records);
            }
            match page.next_page_token {
                Some(pt) => page_token = Some(pt),
                None => break,
            }
        }

        Ok(HistoryResponse {
            history: all_records,
            history_id: latest_history_id,
        })
    }
}

// --- Gmail API response types ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListResponse {
    pub threads: Option<Vec<ThreadStub>>,
    pub next_page_token: Option<String>,
    pub result_size_estimate: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStub {
    pub id: String,
    pub snippet: Option<String>,
    pub history_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailThread {
    pub id: String,
    pub history_id: Option<String>,
    pub messages: Option<Vec<GmailMessage>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailMessage {
    pub id: String,
    pub thread_id: String,
    pub label_ids: Option<Vec<String>>,
    pub snippet: Option<String>,
    pub payload: Option<MessagePayload>,
    pub internal_date: Option<String>,
    pub size_estimate: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePayload {
    pub headers: Option<Vec<Header>>,
    pub mime_type: Option<String>,
    pub body: Option<MessageBody>,
    pub parts: Option<Vec<MessagePart>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePart {
    pub mime_type: Option<String>,
    pub body: Option<MessageBody>,
    pub parts: Option<Vec<MessagePart>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageBody {
    pub data: Option<String>,
    pub size: Option<u64>,
    pub attachment_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Header {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Deserialize)]
pub struct LabelListResponse {
    pub labels: Option<Vec<GmailLabel>>,
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailLabel {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub r#type: Option<String>,
    pub message_list_visibility: Option<String>,
    pub label_list_visibility: Option<String>,
}

impl GmailMessage {
    pub fn get_header(&self, name: &str) -> Option<&str> {
        self.payload.as_ref()?.headers.as_ref()?.iter().find_map(|h| {
            if h.name.eq_ignore_ascii_case(name) {
                Some(h.value.as_str())
            } else {
                None
            }
        })
    }
}

// --- Profile & History API response types ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileResponse {
    pub email_address: String,
    pub history_id: String,
}

/// Internal page response from Gmail History API.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryListPage {
    pub history: Option<Vec<HistoryRecord>>,
    pub next_page_token: Option<String>,
    pub history_id: String,
}

/// Aggregated history response (all pages combined).
pub struct HistoryResponse {
    pub history: Vec<HistoryRecord>,
    pub history_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRecord {
    pub messages: Option<Vec<HistoryMessage>>,
    pub messages_added: Option<Vec<HistoryMessageWrapper>>,
    pub labels_added: Option<Vec<HistoryLabelMod>>,
    pub labels_removed: Option<Vec<HistoryLabelMod>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessage {
    pub id: String,
    pub thread_id: String,
}

#[derive(Debug, Deserialize)]
pub struct HistoryMessageWrapper {
    pub message: HistoryMessage,
}

#[derive(Debug, Deserialize)]
pub struct HistoryLabelMod {
    pub message: HistoryMessage,
    #[serde(rename = "labelIds")]
    pub label_ids: Vec<String>,
}
