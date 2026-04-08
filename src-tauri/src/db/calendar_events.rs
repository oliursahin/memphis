use rusqlite::Connection;

use crate::error::Error;

pub struct CalendarEventRow {
    pub id: String,
    pub account_id: String,
    pub provider_event_id: String,
    pub calendar_id: String,
    pub calendar_name: Option<String>,
    pub title: String,
    pub start_time: String,
    pub end_time: String,
    pub location: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub color: Option<String>,
    pub organizer_email: Option<String>,
    pub attendees: Option<String>, // JSON array
    pub is_all_day: bool,
}

/// Upsert a calendar event (insert or update on conflict).
pub fn upsert_event(conn: &Connection, event: &CalendarEventRow) -> Result<(), Error> {
    conn.execute(
        "INSERT INTO calendar_events (
            id, account_id, provider_event_id, calendar_id, calendar_name,
            title, start_time, end_time, location, description,
            status, color, organizer_email, attendees, is_all_day, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, datetime('now'))
        ON CONFLICT(account_id, provider_event_id) DO UPDATE SET
            calendar_id = excluded.calendar_id,
            calendar_name = excluded.calendar_name,
            title = excluded.title,
            start_time = excluded.start_time,
            end_time = excluded.end_time,
            location = excluded.location,
            description = excluded.description,
            status = excluded.status,
            color = excluded.color,
            organizer_email = excluded.organizer_email,
            attendees = excluded.attendees,
            is_all_day = excluded.is_all_day,
            updated_at = datetime('now')",
        rusqlite::params![
            event.id,
            event.account_id,
            event.provider_event_id,
            event.calendar_id,
            event.calendar_name,
            event.title,
            event.start_time,
            event.end_time,
            event.location,
            event.description,
            event.status,
            event.color,
            event.organizer_email,
            event.attendees,
            event.is_all_day as i32,
        ],
    )?;
    Ok(())
}

/// Get upcoming events for an account within a time range (from..to), ordered by start_time.
pub fn get_upcoming_events(
    conn: &Connection,
    account_id: &str,
    from: &str,
    to: &str,
) -> Result<Vec<CalendarEventRow>, Error> {
    let mut stmt = conn.prepare(
        "SELECT id, account_id, provider_event_id, calendar_id, calendar_name,
                title, start_time, end_time, location, description,
                status, color, organizer_email, attendees, is_all_day
         FROM calendar_events
         WHERE account_id = ?1 AND start_time >= ?2 AND start_time < ?3
         ORDER BY start_time ASC",
    )?;

    let rows = stmt
        .query_map(rusqlite::params![account_id, from, to], |row| {
            Ok(CalendarEventRow {
                id: row.get(0)?,
                account_id: row.get(1)?,
                provider_event_id: row.get(2)?,
                calendar_id: row.get(3)?,
                calendar_name: row.get(4)?,
                title: row.get(5)?,
                start_time: row.get(6)?,
                end_time: row.get(7)?,
                location: row.get(8)?,
                description: row.get(9)?,
                status: row.get(10)?,
                color: row.get(11)?,
                organizer_email: row.get(12)?,
                attendees: row.get(13)?,
                is_all_day: row.get::<_, i32>(14)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(rows)
}

/// Get the single next upcoming event (non-all-day) after a given timestamp.
pub fn get_next_event(
    conn: &Connection,
    account_id: &str,
    after: &str,
) -> Result<Option<CalendarEventRow>, Error> {
    let mut stmt = conn.prepare(
        "SELECT id, account_id, provider_event_id, calendar_id, calendar_name,
                title, start_time, end_time, location, description,
                status, color, organizer_email, attendees, is_all_day
         FROM calendar_events
         WHERE account_id = ?1 AND start_time > ?2 AND is_all_day = 0
         ORDER BY start_time ASC
         LIMIT 1",
    )?;

    let row = stmt
        .query_row(rusqlite::params![account_id, after], |row| {
            Ok(CalendarEventRow {
                id: row.get(0)?,
                account_id: row.get(1)?,
                provider_event_id: row.get(2)?,
                calendar_id: row.get(3)?,
                calendar_name: row.get(4)?,
                title: row.get(5)?,
                start_time: row.get(6)?,
                end_time: row.get(7)?,
                location: row.get(8)?,
                description: row.get(9)?,
                status: row.get(10)?,
                color: row.get(11)?,
                organizer_email: row.get(12)?,
                attendees: row.get(13)?,
                is_all_day: row.get::<_, i32>(14)? != 0,
            })
        })
        .ok();

    Ok(row)
}

/// Delete events that ended before a given timestamp (cleanup old data).
pub fn delete_stale_events(
    conn: &Connection,
    account_id: &str,
    before: &str,
) -> Result<(), Error> {
    conn.execute(
        "DELETE FROM calendar_events WHERE account_id = ?1 AND end_time < ?2",
        rusqlite::params![account_id, before],
    )?;
    Ok(())
}
