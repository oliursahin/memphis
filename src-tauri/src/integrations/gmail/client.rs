use crate::error::Error;
use serde::Deserialize;

const GMAIL_API: &str = "https://www.googleapis.com/gmail/v1/users/me";

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

    /// List threads in the user's mailbox.
    pub async fn list_threads(
        &self,
        query: Option<&str>,
        max_results: u32,
        page_token: Option<&str>,
    ) -> Result<ThreadListResponse, Error> {
        let mut url = format!("{GMAIL_API}/threads?maxResults={max_results}");
        if let Some(q) = query {
            url.push_str(&format!("&q={}", urlencoding::encode(q)));
        }
        if let Some(pt) = page_token {
            url.push_str(&format!("&pageToken={pt}"));
        }

        let resp = self
            .http
            .get(&url)
            .bearer_auth(&self.access_token)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(Error::Internal(format!("Gmail API {status}: {body}")));
        }

        let list: ThreadListResponse = resp.json().await?;
        Ok(list)
    }

    /// Get a single thread with all messages (metadata format for speed).
    pub async fn get_thread(&self, thread_id: &str) -> Result<GmailThread, Error> {
        let url = format!("{GMAIL_API}/threads/{thread_id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date");

        let resp = self
            .http
            .get(&url)
            .bearer_auth(&self.access_token)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(Error::Internal(format!("Gmail API {status}: {body}")));
        }

        let thread: GmailThread = resp.json().await?;
        Ok(thread)
    }

    /// Get a single thread with full message bodies.
    pub async fn get_thread_full(&self, thread_id: &str) -> Result<GmailThread, Error> {
        let url = format!("{GMAIL_API}/threads/{thread_id}?format=full");

        let resp = self
            .http
            .get(&url)
            .bearer_auth(&self.access_token)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(Error::Internal(format!("Gmail API {status}: {body}")));
        }

        let thread: GmailThread = resp.json().await?;
        Ok(thread)
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

        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.access_token)
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(Error::Internal(format!("Gmail modify {status}: {body}")));
        }

        Ok(())
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
}

#[derive(Debug, Deserialize)]
pub struct Header {
    pub name: String,
    pub value: String,
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
