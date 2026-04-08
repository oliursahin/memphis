use std::time::Duration;

use tauri::tray::TrayIconEvent;
use tauri::{
    tray::MouseButton, tray::MouseButtonState, AppHandle, Emitter, Manager, WebviewUrl,
    WebviewWindowBuilder,
};

use crate::db::calendar_events;
use crate::state::AppState;

/// Create the tray icon and the hidden menubar-calendar popup window.
pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Create the popup window (hidden by default, toggled on tray click)
    let _popup = WebviewWindowBuilder::new(app, "menubar-calendar", WebviewUrl::default())
        .title("morphis calendar")
        .inner_size(320.0, 480.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .visible(false)
        .skip_taskbar(true)
        .build()?;

    // Hide popup when it loses focus (matches native macOS popover behavior)
    let popup_handle = app.get_webview_window("menubar-calendar").unwrap();
    let popup_for_blur = popup_handle.clone();
    popup_handle.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            let _ = popup_for_blur.hide();
        }
    });

    // Wire tray icon click to toggle popup
    let tray = app.tray_by_id("main-tray").expect("tray icon not found");
    tray.set_title(Some("morphis"))?;

    let app_handle = app.handle().clone();
    tray.on_tray_icon_event(move |_tray, event| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            toggle_popup(&app_handle);
        }
    });

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

/// Toggle the menubar popup window: show below tray if hidden, hide if visible.
fn toggle_popup(app_handle: &AppHandle) {
    let Some(popup) = app_handle.get_webview_window("menubar-calendar") else {
        return;
    };

    if popup.is_visible().unwrap_or(false) {
        let _ = popup.hide();
        return;
    }

    // Position the popup near the tray icon
    if let Some(tray) = app_handle.tray_by_id("main-tray") {
        if let Ok(Some(rect)) = tray.rect() {
            let pos: tauri::PhysicalPosition<i32> = rect.position.to_physical(1.0);
            let size: tauri::PhysicalSize<u32> = rect.size.to_physical(1.0);
            let x = pos.x - 160 + (size.width as i32 / 2); // center under icon
            let y = pos.y + size.height as i32;
            let _ = popup.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }

    let _ = popup.show();
    let _ = popup.set_focus();

    // Tell the popup to refresh its data
    let _ = app_handle.emit("calendar:popup_opened", ());
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
