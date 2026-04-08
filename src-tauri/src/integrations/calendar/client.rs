use crate::error::Error;
use serde::Deserialize;

const CALENDAR_API: &str = "https://www.googleapis.com/calendar/v3";

#[derive(Clone)]
pub struct CalendarClient {
    http: reqwest::Client,
    access_token: String,
}

impl CalendarClient {
    pub fn new(access_token: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            access_token,
        }
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, url: &str) -> Result<T, Error> {
        let resp = self
            .http
            .get(url)
            .bearer_auth(&self.access_token)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            if status == reqwest::StatusCode::FORBIDDEN {
                return Err(Error::Auth(format!("Calendar API {status}: {body}")));
            }
            if status == reqwest::StatusCode::NOT_FOUND {
                return Err(Error::NotFound(format!("Calendar API 404: {body}")));
            }
            return Err(Error::Internal(format!("Calendar API {status}: {body}")));
        }
        Ok(resp.json().await?)
    }

    /// List the user's calendar list (to discover calendar IDs).
    pub async fn list_calendars(&self) -> Result<Vec<CalendarEntry>, Error> {
        let url = format!("{CALENDAR_API}/users/me/calendarList");
        let resp: CalendarListResponse = self.get_json(&url).await?;
        Ok(resp.items.unwrap_or_default())
    }

    /// List events from a specific calendar within a time range.
    /// Uses `singleEvents=true` to expand recurring events and `orderBy=startTime`.
    pub async fn list_events(
        &self,
        calendar_id: &str,
        time_min: &str,
        time_max: &str,
        max_results: u32,
    ) -> Result<Vec<EventEntry>, Error> {
        let mut all_events = Vec::new();
        let mut page_token: Option<String> = None;

        loop {
            let mut url = format!(
                "{CALENDAR_API}/calendars/{}/events?singleEvents=true&orderBy=startTime&timeMin={}&timeMax={}&maxResults={}",
                urlencoding::encode(calendar_id),
                urlencoding::encode(time_min),
                urlencoding::encode(time_max),
                max_results,
            );
            if let Some(ref pt) = page_token {
                url.push_str(&format!("&pageToken={}", urlencoding::encode(pt)));
            }

            let resp: EventListResponse = self.get_json(&url).await?;
            if let Some(items) = resp.items {
                all_events.extend(items);
            }
            match resp.next_page_token {
                Some(pt) => page_token = Some(pt),
                None => break,
            }
        }

        Ok(all_events)
    }
}

// --- Calendar API response types ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarListResponse {
    items: Option<Vec<CalendarEntry>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEntry {
    pub id: String,
    pub summary: Option<String>,
    pub primary: Option<bool>,
    pub background_color: Option<String>,
    pub foreground_color: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventListResponse {
    items: Option<Vec<EventEntry>>,
    next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEntry {
    pub id: String,
    pub summary: Option<String>,
    pub start: Option<EventTime>,
    pub end: Option<EventTime>,
    pub location: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub color_id: Option<String>,
    pub organizer: Option<EventPerson>,
    pub attendees: Option<Vec<EventPerson>>,
    pub updated: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventTime {
    /// Present for timed events (RFC 3339).
    pub date_time: Option<String>,
    /// Present for all-day events (YYYY-MM-DD).
    pub date: Option<String>,
    pub time_zone: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPerson {
    pub email: Option<String>,
    pub display_name: Option<String>,
    #[serde(rename = "self")]
    pub is_self: Option<bool>,
}
