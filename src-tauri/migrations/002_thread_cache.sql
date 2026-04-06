-- Add fields needed for cached thread list display
ALTER TABLE threads ADD COLUMN from_name TEXT NOT NULL DEFAULT '';
ALTER TABLE threads ADD COLUMN from_email TEXT NOT NULL DEFAULT '';
ALTER TABLE threads ADD COLUMN label_ids TEXT NOT NULL DEFAULT '[]';
