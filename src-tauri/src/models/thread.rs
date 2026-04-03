use serde::{Deserialize, Serialize};

use super::message::Message;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: String,
    pub subject: String,
    pub snippet: String,
    pub last_message_at: String,
    pub message_count: u32,
    pub is_read: bool,
    pub is_starred: bool,
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDetail {
    pub id: String,
    pub subject: String,
    pub last_message_at: String,
    pub is_read: bool,
    pub is_starred: bool,
    pub is_archived: bool,
    pub category: String,
    pub messages: Vec<Message>,
}
