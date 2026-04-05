use crate::error::Error;

#[derive(Debug, serde::Deserialize)]
struct UnsplashPhoto {
    urls: UnsplashUrls,
    user: UnsplashUser,
    links: UnsplashLinks,
}

#[derive(Debug, serde::Deserialize)]
struct UnsplashUrls {
    raw: String,
}

#[derive(Debug, serde::Deserialize)]
struct UnsplashUser {
    name: String,
    links: UnsplashUserLinks,
}

#[derive(Debug, serde::Deserialize)]
struct UnsplashUserLinks {
    html: String,
}

#[derive(Debug, serde::Deserialize)]
struct UnsplashLinks {
    download_location: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxZeroPhoto {
    /// Raw URL with Imgix params for sizing
    pub url: String,
    /// Photographer name (for attribution)
    pub photographer: String,
    /// Link to photographer's Unsplash profile
    pub photographer_url: String,
}

/// Fetch a random landscape photo from Unsplash for the inbox-zero background.
/// Also triggers the required download tracking endpoint per Unsplash guidelines.
#[tauri::command]
pub async fn get_inbox_zero_photo() -> Result<InboxZeroPhoto, Error> {
    let access_key = option_env!("UNSPLASH_ACCESS_KEY")
        .map(String::from)
        .or_else(|| std::env::var("UNSPLASH_ACCESS_KEY").ok())
        .ok_or_else(|| Error::Internal("UNSPLASH_ACCESS_KEY not set".into()))?;

    let client = reqwest::Client::new();

    let photo: UnsplashPhoto = client
        .get("https://api.unsplash.com/photos/random")
        .query(&[
            ("orientation", "landscape"),
            ("query", "nature landscape"),
            ("content_filter", "high"),
        ])
        .header("Authorization", format!("Client-ID {access_key}"))
        .header("Accept-Version", "v1")
        .send()
        .await?
        .error_for_status()
        .map_err(|e| Error::Internal(format!("Unsplash API error: {e}")))?
        .json()
        .await?;

    // Fire-and-forget: trigger download tracking (required by Unsplash guidelines)
    let dl_url = photo.links.download_location.clone();
    let dl_key = access_key.clone();
    tauri::async_runtime::spawn(async move {
        let _ = reqwest::Client::new()
            .get(&dl_url)
            .header("Authorization", format!("Client-ID {dl_key}"))
            .header("Accept-Version", "v1")
            .send()
            .await;
    });

    // Use Imgix params on the raw URL for a reasonable desktop size
    let sized_url = format!("{}&w=2560&q=80&fm=jpg&fit=crop", photo.urls.raw);

    Ok(InboxZeroPhoto {
        url: sized_url,
        photographer: photo.user.name,
        photographer_url: photo.user.links.html,
    })
}
