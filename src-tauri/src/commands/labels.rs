use tauri::State;

use crate::error::Error;
use crate::integrations::gmail::client::{GmailClient, GmailLabel};
use crate::integrations::gmail::oauth;
use crate::state::AppState;

/// Fetch all labels from the user's Gmail account.
#[tauri::command]
pub async fn list_labels(state: State<'_, AppState>) -> Result<Vec<GmailLabel>, Error> {
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

    let token = oauth::get_valid_token(&state.db, &account_id).await?;
    let client = GmailClient::new(token);
    let resp = client.list_labels().await?;
    Ok(resp.labels.unwrap_or_default())
}
