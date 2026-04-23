use std::collections::HashMap;

use crate::error::Error;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenEvent {
    pub opened_at: String,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
}

#[derive(serde::Deserialize)]
struct OpensResponse {
    opens: HashMap<String, Vec<OpenEvent>>,
}

pub struct TrackingClient {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
}

impl TrackingClient {
    /// Returns None if env vars are not set (graceful degradation).
    pub fn from_env() -> Option<Self> {
        let base_url = std::env::var("TRACKING_WORKER_URL").ok()?;
        let api_key = std::env::var("TRACKING_API_KEY").ok()?;
        if base_url.is_empty() || api_key.is_empty() {
            return None;
        }
        Some(Self {
            http: reqwest::Client::new(),
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key,
        })
    }

    /// Returns the base URL for constructing tracking pixel URLs.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Batch-fetch open events for a list of tracking IDs.
    pub async fn fetch_opens(
        &self,
        ids: &[String],
    ) -> Result<HashMap<String, Vec<OpenEvent>>, Error> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let joined = ids.join(",");
        let url = format!("{}/api/opens?ids={}", self.base_url, joined);
        let resp = self
            .http
            .get(&url)
            .header("X-API-Key", &self.api_key)
            .send()
            .await
            .map_err(|e| Error::Internal(format!("Tracking API request failed: {e}")))?;

        if !resp.status().is_success() {
            return Err(Error::Internal(format!(
                "Tracking API returned {}",
                resp.status()
            )));
        }

        let body: OpensResponse = resp
            .json()
            .await
            .map_err(|e| Error::Internal(format!("Tracking API parse error: {e}")))?;
        Ok(body.opens)
    }
}

/// Get the tracking worker base URL from env (for pixel injection).
pub fn tracking_worker_url() -> Option<String> {
    let url = std::env::var("TRACKING_WORKER_URL").ok()?;
    if url.is_empty() {
        return None;
    }
    Some(url.trim_end_matches('/').to_string())
}
