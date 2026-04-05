use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use crate::error::Error;
use crate::integrations::gmail::client::GmailClient;
use crate::integrations::gmail::oauth;

/// Result of an incremental sync cycle.
pub struct SyncResult {
    pub changed_thread_ids: Vec<String>,
    pub new_history_id: String,
}

impl SyncResult {
    pub fn has_changes(&self) -> bool {
        !self.changed_thread_ids.is_empty()
    }
}

/// Seed the sync checkpoint by fetching the current historyId from Gmail.
/// Returns the historyId to use as the starting checkpoint.
pub async fn seed_checkpoint(
    db: &Arc<Mutex<Connection>>,
    account_id: &str,
) -> Result<String, Error> {
    let token = oauth::get_valid_token(db, account_id).await?;
    let client = GmailClient::new(token);
    let profile = client.get_profile().await?;

    // Store the checkpoint
    {
        let conn = db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        conn.execute(
            "UPDATE sync_state SET checkpoint = ?1, last_full_sync = datetime('now') WHERE account_id = ?2",
            rusqlite::params![profile.history_id, account_id],
        )?;
    }

    Ok(profile.history_id)
}

/// Perform an incremental sync using Gmail History API.
/// Returns the set of changed thread IDs and the new checkpoint.
pub async fn incremental_sync(
    db: &Arc<Mutex<Connection>>,
    account_id: &str,
    checkpoint: &str,
) -> Result<SyncResult, Error> {
    let token = oauth::get_valid_token(db, account_id).await?;
    let client = GmailClient::new(token);

    let response = client.list_history(checkpoint).await?;

    // Collect unique thread IDs from all history records
    let mut thread_ids = HashSet::new();
    for record in &response.history {
        if let Some(ref added) = record.messages_added {
            for wrapper in added {
                thread_ids.insert(wrapper.message.thread_id.clone());
            }
        }
        if let Some(ref label_added) = record.labels_added {
            for lm in label_added {
                thread_ids.insert(lm.message.thread_id.clone());
            }
        }
        if let Some(ref label_removed) = record.labels_removed {
            for lm in label_removed {
                thread_ids.insert(lm.message.thread_id.clone());
            }
        }
    }

    // Update checkpoint
    {
        let conn = db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        conn.execute(
            "UPDATE sync_state SET checkpoint = ?1, last_incremental_sync = datetime('now') WHERE account_id = ?2",
            rusqlite::params![response.history_id, account_id],
        )?;
    }

    Ok(SyncResult {
        changed_thread_ids: thread_ids.into_iter().collect(),
        new_history_id: response.history_id,
    })
}
