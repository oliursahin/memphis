use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::Rng;
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::Error;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const SCOPES: &str = "openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify";

pub struct OAuthConfig {
    pub client_id: String,
    pub client_secret: String,
}

impl OAuthConfig {
    pub fn from_env() -> Result<Self, Error> {
        let client_id = std::env::var("GOOGLE_CLIENT_ID")
            .map_err(|_| Error::Auth("GOOGLE_CLIENT_ID not set".into()))?;
        let client_secret = std::env::var("GOOGLE_CLIENT_SECRET")
            .map_err(|_| Error::Auth("GOOGLE_CLIENT_SECRET not set".into()))?;
        Ok(Self {
            client_id,
            client_secret,
        })
    }
}

/// Generate a random PKCE code verifier (43-128 chars of unreserved URI chars).
fn generate_code_verifier() -> String {
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..32).map(|_| rng.gen::<u8>()).collect();
    URL_SAFE_NO_PAD.encode(&bytes)
}

/// Derive the PKCE code challenge from the verifier (S256).
fn code_challenge(verifier: &str) -> String {
    let hash = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(hash)
}

/// Start the OAuth flow: spawn a localhost callback server, return the auth URL.
/// Returns (auth_url, port, code_verifier) — the caller opens the URL in a browser.
pub fn build_auth_url(config: &OAuthConfig) -> Result<(String, u16, String), Error> {
    // Fixed port for OAuth callback — must match Google Cloud Console redirect URI
    let port: u16 = 8923;
    let redirect_uri = format!("http://127.0.0.1:{port}");
    let verifier = generate_code_verifier();
    let challenge = code_challenge(&verifier);
    let state = Uuid::new_v4().to_string();

    let auth_url = format!(
        "{AUTH_URL}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        urlencoding::encode(&config.client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(SCOPES),
        urlencoding::encode(&challenge),
        urlencoding::encode(&state),
    );

    Ok((auth_url, port, verifier))
}

/// Listen for the OAuth callback on the given port. Blocks until a request is received.
/// Returns the authorization code.
pub fn wait_for_callback(port: u16) -> Result<String, Error> {
    let server = tiny_http::Server::http(format!("127.0.0.1:{port}"))
        .map_err(|e| Error::Internal(format!("Failed to start callback server: {e}")))?;

    log::info!("OAuth callback server listening on 127.0.0.1:{port}");

    // Wait for one request (with a 5-minute timeout)
    let request = server
        .recv_timeout(std::time::Duration::from_secs(300))
        .map_err(|e| Error::Internal(format!("Callback server error: {e}")))?
        .ok_or_else(|| Error::Auth("OAuth callback timed out".into()))?;

    let url = request.url().to_string();
    log::info!("Received callback: {url}");

    // Parse the code from query params
    let query = url.split('?').nth(1).unwrap_or("");
    let code = query
        .split('&')
        .find_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            if k == "code" {
                Some(urlencoding::decode(v).unwrap_or_default().into_owned())
            } else {
                None
            }
        })
        .ok_or_else(|| {
            // Check for error
            let error = query
                .split('&')
                .find_map(|pair| {
                    let (k, v) = pair.split_once('=')?;
                    if k == "error" { Some(v.to_string()) } else { None }
                })
                .unwrap_or_else(|| "no code in callback".into());
            Error::Auth(format!("OAuth error: {error}"))
        })?;

    // Respond with a success page
    let response = tiny_http::Response::from_string(
        "<html><body style='font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;color:#333'><div style='text-align:center'><h2>Connected!</h2><p>You can close this tab and return to Memphis.</p></div></body></html>"
    ).with_header("Content-Type: text/html".parse::<tiny_http::Header>().unwrap());

    let _ = request.respond(response);

    Ok(code)
}

/// Exchange the authorization code for tokens.
pub async fn exchange_code(
    config: &OAuthConfig,
    code: &str,
    verifier: &str,
    port: u16,
) -> Result<TokenResponse, Error> {
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let client = reqwest::Client::new();
    let resp = client
        .post(TOKEN_URL)
        .form(&[
            ("code", code),
            ("client_id", &config.client_id),
            ("client_secret", &config.client_secret),
            ("redirect_uri", &redirect_uri),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier),
        ])
        .send()
        .await?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(Error::Auth(format!("Token exchange failed: {body}")));
    }

    let token: TokenResponse = resp.json().await?;
    Ok(token)
}

/// Refresh an access token using a refresh token.
pub async fn refresh_access_token(
    config: &OAuthConfig,
    refresh_token: &str,
) -> Result<TokenResponse, Error> {
    let client = reqwest::Client::new();
    let resp = client
        .post(TOKEN_URL)
        .form(&[
            ("refresh_token", refresh_token),
            ("client_id", &config.client_id),
            ("client_secret", &config.client_secret),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(Error::Auth(format!("Token refresh failed: {body}")));
    }

    let token: TokenResponse = resp.json().await?;
    Ok(token)
}

/// Fetch Google user info (name, email, avatar) using the access token.
pub async fn get_user_info(access_token: &str) -> Result<UserInfo, Error> {
    let client = reqwest::Client::new();
    let resp = client
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .bearer_auth(access_token)
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(Error::Auth("Failed to fetch user info".into()));
    }

    let info: UserInfo = resp.json().await?;
    Ok(info)
}

/// Save account and tokens to the database.
pub fn save_account(
    conn: &Connection,
    account_id: &str,
    user_info: &UserInfo,
    tokens: &TokenResponse,
    expires_at: &str,
) -> Result<(), Error> {
    conn.execute(
        "INSERT OR REPLACE INTO accounts (id, email, display_name, avatar_url, provider, is_active)
         VALUES (?1, ?2, ?3, ?4, 'gmail', 1)",
        rusqlite::params![account_id, user_info.email, user_info.name, user_info.picture],
    )?;

    conn.execute(
        "INSERT OR REPLACE INTO oauth_tokens (account_id, access_token, refresh_token, expires_at, scope)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            account_id,
            tokens.access_token,
            tokens.refresh_token.as_deref().unwrap_or(""),
            expires_at,
            SCOPES,
        ],
    )?;

    conn.execute(
        "INSERT OR IGNORE INTO sync_state (account_id) VALUES (?1)",
        rusqlite::params![account_id],
    )?;

    Ok(())
}

/// Get a valid access token for the given account, refreshing if needed.
pub async fn get_valid_token(
    db: &Arc<Mutex<Connection>>,
    account_id: &str,
) -> Result<String, Error> {
    let (access_token, refresh_token, expires_at) = {
        let conn = db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        let mut stmt = conn.prepare(
            "SELECT access_token, refresh_token, expires_at FROM oauth_tokens WHERE account_id = ?1"
        )?;
        stmt.query_row(rusqlite::params![account_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        }).map_err(|_| Error::Auth("No tokens found for account".into()))?
    };

    // Check if token needs refresh (within 5 minutes of expiry)
    let needs_refresh = match &expires_at {
        Some(exp) => {
            chrono::DateTime::parse_from_rfc3339(exp)
                .map(|exp| exp < chrono::Utc::now() + chrono::Duration::minutes(5))
                .unwrap_or(true)
        }
        None => true,
    };

    if !needs_refresh {
        return Ok(access_token);
    }

    log::info!("Refreshing access token for account {account_id}");
    let config = OAuthConfig::from_env()?;
    let new_tokens = refresh_access_token(&config, &refresh_token).await?;

    let new_expires_at = chrono::Utc::now()
        + chrono::Duration::seconds(new_tokens.expires_in.unwrap_or(3600) as i64);
    let expires_str = new_expires_at.to_rfc3339();

    // Update tokens in DB
    {
        let conn = db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;
        conn.execute(
            "UPDATE oauth_tokens SET access_token = ?1, expires_at = ?2 WHERE account_id = ?3",
            rusqlite::params![new_tokens.access_token, expires_str, account_id],
        )?;
        // If a new refresh token was issued, update it too
        if let Some(ref rt) = new_tokens.refresh_token {
            conn.execute(
                "UPDATE oauth_tokens SET refresh_token = ?1 WHERE account_id = ?2",
                rusqlite::params![rt, account_id],
            )?;
        }
    }

    Ok(new_tokens.access_token)
}

#[derive(Debug, serde::Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<u64>,
    pub token_type: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
pub struct UserInfo {
    pub email: String,
    pub name: Option<String>,
    pub picture: Option<String>,
}
