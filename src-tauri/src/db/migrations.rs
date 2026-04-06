use rusqlite::Connection;

use crate::error::Error;

const MIGRATIONS: &[(&str, &str)] = &[
    (
        "001_initial",
        include_str!("../../migrations/001_initial.sql"),
    ),
    (
        "002_thread_cache",
        include_str!("../../migrations/002_thread_cache.sql"),
    ),
    (
        "003_sender_emails",
        include_str!("../../migrations/003_sender_emails.sql"),
    ),
    (
        "004_calendar_flag",
        include_str!("../../migrations/004_calendar_flag.sql"),
    ),
];

pub fn run_migrations(conn: &Connection) -> Result<(), Error> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );",
    )?;

    let current_version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM _migrations",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    for (i, (name, sql)) in MIGRATIONS.iter().enumerate() {
        let version = (i + 1) as i64;
        if version > current_version {
            log::info!("Running migration {version}: {name}");
            conn.execute_batch(sql)?;
            conn.execute(
                "INSERT INTO _migrations (version, name) VALUES (?1, ?2)",
                rusqlite::params![version, name],
            )?;
        }
    }

    Ok(())
}
