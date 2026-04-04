use std::sync::Arc;

use tauri::State;
use uuid::Uuid;

use crate::error::Error;
use crate::integrations::gmail::oauth::{self, OAuthConfig};
use crate::models::account::Account;
use crate::state::AppState;

#[tauri::command]
pub async fn start_oauth_flow(state: State<'_, AppState>) -> Result<(), Error> {
    let config = OAuthConfig::from_env()?;
    let (auth_url, port, verifier) = oauth::build_auth_url(&config)?;

    // Open the URL in the default browser
    open::that(&auth_url)
        .map_err(|e| Error::Internal(format!("Failed to open browser: {e}")))?;

    // Wait for the callback in a blocking thread (tiny_http is sync)
    let code = tokio::task::spawn_blocking(move || oauth::wait_for_callback(port))
        .await
        .map_err(|e| Error::Internal(format!("spawn_blocking: {e}")))?
        ?;

    // Exchange code for tokens
    let tokens = oauth::exchange_code(&config, &code, &verifier, port).await?;

    // Get user info
    let user_info = oauth::get_user_info(&tokens.access_token).await?;

    let account_id = Uuid::new_v4().to_string();
    let expires_at = chrono::Utc::now()
        + chrono::Duration::seconds(tokens.expires_in.unwrap_or(3600) as i64);
    let expires_str = expires_at.to_rfc3339();

    // Save to DB
    {
        let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        oauth::save_account(&conn, &account_id, &user_info, &tokens, &expires_str)?;
    }

    log::info!("Account created: {} ({})", user_info.email, account_id);
    Ok(())
}

#[tauri::command]
pub async fn get_accounts(state: State<'_, AppState>) -> Result<Vec<Account>, Error> {
    let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
    crate::db::accounts::get_accounts(&conn)
}

#[tauri::command]
pub async fn has_accounts(state: State<'_, AppState>) -> Result<bool, Error> {
    let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM accounts WHERE is_active = 1",
        [],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

#[tauri::command]
pub async fn logout(state: State<'_, AppState>) -> Result<(), Error> {
    let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
    conn.execute("DELETE FROM oauth_tokens", [])?;
    conn.execute("DELETE FROM accounts", [])?;
    log::info!("All accounts logged out");
    Ok(())
}
