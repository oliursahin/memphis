use tauri::State;
use uuid::Uuid;

use crate::error::Error;
use crate::integrations::gmail::oauth::{self, OAuthConfig};
use crate::models::account::Account;
use crate::state::AppState;
use crate::sync::engine::clear_calendar_denied;

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

    let expires_at = chrono::Utc::now()
        + chrono::Duration::seconds(tokens.expires_in.unwrap_or(3600) as i64);
    let expires_str = expires_at.to_rfc3339();

    // Check if an account with this email already exists (re-auth scenario)
    let existing_account_id: Option<String> = {
        let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        conn.query_row(
            "SELECT id FROM accounts WHERE email = ?1 AND is_active = 1",
            rusqlite::params![user_info.email],
            |row| row.get(0),
        )
        .ok()
    };

    let account_id = existing_account_id.unwrap_or_else(|| Uuid::new_v4().to_string());

    // Save to DB (upserts account + tokens)
    {
        let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        oauth::save_account(&conn, &account_id, &user_info, &tokens, &expires_str)?;
    }

    // Clear stale in-memory caches so the new token (with updated scopes) is used
    oauth::clear_token_cache(&account_id).await;
    clear_calendar_denied(&account_id).await;

    log::info!("Account saved: {} ({})", user_info.email, account_id);
    Ok(())
}

/// Re-authenticate an existing account to update OAuth scopes (e.g., add calendar access).
/// Preserves the account ID and sync state — only refreshes the tokens.
#[tauri::command]
pub async fn reauth_account(state: State<'_, AppState>, account_id: String) -> Result<(), Error> {
    let config = OAuthConfig::from_env()?;
    let (auth_url, port, verifier) = oauth::build_auth_url(&config)?;

    open::that(&auth_url)
        .map_err(|e| Error::Internal(format!("Failed to open browser: {e}")))?;

    let code = tokio::task::spawn_blocking(move || oauth::wait_for_callback(port))
        .await
        .map_err(|e| Error::Internal(format!("spawn_blocking: {e}")))?
        ?;

    let tokens = oauth::exchange_code(&config, &code, &verifier, port).await?;
    let user_info = oauth::get_user_info(&tokens.access_token).await?;

    let expires_at = chrono::Utc::now()
        + chrono::Duration::seconds(tokens.expires_in.unwrap_or(3600) as i64);
    let expires_str = expires_at.to_rfc3339();

    // Update tokens for the existing account (preserves sync_state)
    {
        let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        oauth::save_account(&conn, &account_id, &user_info, &tokens, &expires_str)?;
    }

    // Clear stale in-memory caches so sync engine uses the fresh token
    oauth::clear_token_cache(&account_id).await;
    clear_calendar_denied(&account_id).await;

    log::info!("Re-authenticated account {} ({})", user_info.email, account_id);
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
pub async fn disconnect_account(state: State<'_, AppState>, account_id: String) -> Result<(), Error> {
    let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
    conn.execute("DELETE FROM oauth_tokens WHERE account_id = ?1", [&account_id])?;
    conn.execute("DELETE FROM accounts WHERE id = ?1", [&account_id])?;
    log::info!("Account disconnected: {}", account_id);
    Ok(())
}

/// Re-fetch profile info (avatar, name) for accounts missing an avatar.
#[tauri::command]
pub async fn refresh_account_profiles(state: State<'_, AppState>) -> Result<(), Error> {
    let accounts_missing_avatar: Vec<(String, String)> = {
        let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        let mut stmt = conn.prepare(
            "SELECT a.id, a.email FROM accounts a
             WHERE a.is_active = 1 AND (a.avatar_url IS NULL OR a.avatar_url = '')"
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }
        result
    };

    for (account_id, email) in &accounts_missing_avatar {
        match oauth::get_valid_token(&state.db, account_id).await {
            Ok(token) => {
                if let Ok(info) = oauth::get_user_info(&token).await {
                    let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
                    conn.execute(
                        "UPDATE accounts SET avatar_url = ?1, display_name = COALESCE(display_name, ?2) WHERE id = ?3",
                        rusqlite::params![info.picture, info.name, account_id],
                    )?;
                    log::info!("Refreshed profile for {email}");
                }
            }
            Err(e) => log::warn!("Skipping profile refresh for {email}: {e}"),
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn logout(state: State<'_, AppState>) -> Result<(), Error> {
    let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
    conn.execute("DELETE FROM oauth_tokens", [])?;
    conn.execute("DELETE FROM accounts", [])?;
    log::info!("All accounts logged out");
    Ok(())
}
