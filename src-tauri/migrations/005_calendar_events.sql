CREATE TABLE IF NOT EXISTS calendar_events (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    provider_event_id TEXT NOT NULL,
    calendar_id TEXT NOT NULL,
    calendar_name TEXT,
    title TEXT NOT NULL DEFAULT '',
    start_time TEXT NOT NULL,   -- ISO 8601 / RFC 3339
    end_time TEXT NOT NULL,     -- ISO 8601 / RFC 3339
    location TEXT,
    description TEXT,
    status TEXT,
    color TEXT,
    organizer_email TEXT,
    attendees TEXT,             -- JSON array
    is_all_day INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(account_id, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_cal_events_time ON calendar_events(account_id, start_time);
