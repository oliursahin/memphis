use serde::Serialize;
use tauri::State;

use crate::db::calendar_events;
use crate::error::Error;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEventDto {
    pub id: String,
    pub title: String,
    pub start_time: String,
    pub end_time: String,
    pub location: Option<String>,
    pub description: Option<String>,
    pub calendar_name: Option<String>,
    pub color: Option<String>,
    pub organizer_email: Option<String>,
    pub attendees: Option<Vec<String>>,
    pub is_all_day: bool,
}

fn row_to_dto(r: calendar_events::CalendarEventRow) -> CalendarEventDto {
    let attendees = r.attendees.and_then(|json| {
        serde_json::from_str::<Vec<String>>(&json).ok()
    });
    CalendarEventDto {
        id: r.id,
        title: r.title,
        start_time: r.start_time,
        end_time: r.end_time,
        location: r.location,
        description: r.description,
        calendar_name: r.calendar_name,
        color: r.color,
        organizer_email: r.organizer_email,
        attendees,
        is_all_day: r.is_all_day,
    }
}

/// Get upcoming events within the next N days.
/// Pass `account_id: "_all"` to get events from all active accounts.
#[tauri::command]
pub fn get_upcoming_events(
    state: State<'_, AppState>,
    account_id: String,
    days: Option<u32>,
) -> Result<Vec<CalendarEventDto>, Error> {
    let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;

    let now = chrono::Utc::now();
    let from = now.to_rfc3339();
    let to = (now + chrono::Duration::days(days.unwrap_or(7) as i64)).to_rfc3339();

    let account_ids: Vec<String> = if account_id == "_all" {
        let mut stmt = conn.prepare("SELECT id FROM accounts WHERE is_active = 1")?;
        let ids = stmt.query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids
    } else {
        vec![account_id]
    };

    let mut all_dtos = Vec::new();
    for aid in &account_ids {
        let rows = calendar_events::get_upcoming_events(&conn, aid, &from, &to)?;
        all_dtos.extend(rows.into_iter().map(row_to_dto));
    }

    // Sort merged events by start_time
    all_dtos.sort_by(|a, b| a.start_time.cmp(&b.start_time));

    Ok(all_dtos)
}

/// Get the single next upcoming event across all accounts.
#[tauri::command]
pub fn get_next_event(
    state: State<'_, AppState>,
) -> Result<Option<CalendarEventDto>, Error> {
    let conn = state.db.lock().map_err(|e| Error::Internal(format!("DB lock: {e}")))?;

    let now = chrono::Utc::now().to_rfc3339();

    // Get all active accounts
    let mut stmt = conn.prepare("SELECT id FROM accounts WHERE is_active = 1")?;
    let account_ids: Vec<String> = stmt
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut best: Option<CalendarEventDto> = None;

    for account_id in &account_ids {
        if let Some(row) = calendar_events::get_next_event(&conn, account_id, &now)? {
            let start = row.start_time.clone();
            let dto = row_to_dto(row);
            match &best {
                None => best = Some(dto),
                Some(existing) => {
                    if start < existing.start_time {
                        best = Some(dto);
                    }
                }
            }
        }
    }

    Ok(best)
}
