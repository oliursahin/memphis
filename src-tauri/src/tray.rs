use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::db::calendar_events;
use crate::state::AppState;

/// Set up the tray icon with a countdown to the next calendar event.
pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let tray = app.tray_by_id("main-tray").expect("tray icon not found");
    tray.set_title(Some("morphis"))?;

    // Spawn a 60-second timer to update the tray title with next event countdown
    let timer_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        loop {
            update_tray_title(&timer_handle);
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });

    Ok(())
}

/// Query the next upcoming event and update the tray icon title.
fn update_tray_title(app_handle: &AppHandle) {
    let Some(tray) = app_handle.tray_by_id("main-tray") else {
        return;
    };

    let state = match app_handle.try_state::<AppState>() {
        Some(s) => s,
        None => {
            let _ = tray.set_title(Some("morphis"));
            return;
        }
    };

    let conn = match state.db.lock() {
        Ok(c) => c,
        Err(_) => {
            let _ = tray.set_title(Some("morphis"));
            return;
        }
    };

    // Get all active account IDs
    let account_ids: Vec<String> = {
        let mut stmt = match conn.prepare("SELECT id FROM accounts WHERE is_active = 1") {
            Ok(s) => s,
            Err(_) => {
                let _ = tray.set_title(Some("morphis"));
                return;
            }
        };
        stmt.query_map([], |row| row.get(0))
            .ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    };

    // Find the soonest next event across all accounts
    let now = chrono::Utc::now();
    let now_str = now.to_rfc3339();
    let mut next_event: Option<(String, String)> = None; // (title, start_time)

    for account_id in &account_ids {
        if let Ok(Some(ev)) = calendar_events::get_next_event(&conn, account_id, &now_str) {
            match &next_event {
                None => next_event = Some((ev.title, ev.start_time)),
                Some((_, existing_start)) => {
                    if ev.start_time < *existing_start {
                        next_event = Some((ev.title, ev.start_time));
                    }
                }
            }
        }
    }

    let title = match next_event {
        Some((event_title, start_time)) => {
            if let Ok(start) = chrono::DateTime::parse_from_rfc3339(&start_time) {
                let diff = start.signed_duration_since(now);
                let total_mins = diff.num_minutes();
                if total_mins <= 0 {
                    format!("{} · now", truncate_title(&event_title, 20))
                } else {
                    let hours = total_mins / 60;
                    let mins = total_mins % 60;
                    let relative = if hours > 0 {
                        format!("in {}h {}m", hours, mins)
                    } else {
                        format!("in {}m", mins)
                    };
                    format!("{} · {}", truncate_title(&event_title, 20), relative)
                }
            } else {
                "morphis".to_string()
            }
        }
        None => "morphis".to_string(),
    };

    let _ = tray.set_title(Some(&title));
}

fn truncate_title(title: &str, max: usize) -> &str {
    if title.len() <= max {
        title
    } else {
        let end = title
            .char_indices()
            .nth(max)
            .map(|(i, _)| i)
            .unwrap_or(title.len());
        &title[..end]
    }
}
