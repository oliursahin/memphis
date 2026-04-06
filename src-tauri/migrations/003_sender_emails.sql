-- Store all unique sender emails per thread for accurate from: matching.
-- Gmail search checks all messages in a thread, not just the last one.
ALTER TABLE threads ADD COLUMN sender_emails TEXT NOT NULL DEFAULT '[]';
