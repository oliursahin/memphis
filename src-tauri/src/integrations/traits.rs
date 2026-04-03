use async_trait::async_trait;

use crate::error::Error;

/// Raw thread data from a provider before mapping to internal models.
pub struct RawThread {
    pub provider_thread_id: String,
    pub subject: String,
    pub snippet: String,
    pub last_message_at: String,
    pub message_count: u32,
    pub label_ids: Vec<String>,
}

/// Raw message data from a provider.
pub struct RawMessage {
    pub provider_message_id: String,
    pub provider_thread_id: String,
    pub from_name: String,
    pub from_email: String,
    pub to: Vec<(String, String)>,
    pub cc: Vec<(String, String)>,
    pub subject: String,
    pub body_html: Option<String>,
    pub body_text: Option<String>,
    pub date: String,
    pub label_ids: Vec<String>,
    pub has_attachments: bool,
    pub raw_size: u64,
}

/// Composed message ready to send.
pub struct ComposedMessage {
    pub to: Vec<(String, String)>,
    pub cc: Vec<(String, String)>,
    pub bcc: Vec<(String, String)>,
    pub subject: String,
    pub body_html: String,
    pub body_text: String,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
}

#[async_trait]
pub trait EmailProvider: Send + Sync {
    async fn fetch_message(&self, message_id: &str) -> Result<RawMessage, Error>;
    async fn send_message(&self, draft: &ComposedMessage) -> Result<String, Error>;
    async fn archive(&self, thread_ids: &[String]) -> Result<(), Error>;
    async fn modify_labels(
        &self,
        thread_id: &str,
        add: &[String],
        remove: &[String],
    ) -> Result<(), Error>;
    async fn trash(&self, thread_id: &str) -> Result<(), Error>;
}

#[async_trait]
pub trait SyncProvider: Send + Sync {
    /// Full initial sync. Returns the sync checkpoint (e.g., Gmail historyId).
    async fn full_sync(&self, db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>) -> Result<String, Error>;
    /// Incremental sync from checkpoint. Returns new checkpoint.
    async fn incremental_sync(
        &self,
        db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
        checkpoint: &str,
    ) -> Result<String, Error>;
}
