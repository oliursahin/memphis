-- Flag calendar threads (detected via Gmail's filename:ics search).
ALTER TABLE threads ADD COLUMN is_calendar INTEGER NOT NULL DEFAULT 0;
