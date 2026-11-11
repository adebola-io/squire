-- Persist observed foreground call boundaries; inference itself remains transient.
ALTER TABLE thread_calls ADD COLUMN promoted_at INTEGER;
ALTER TABLE threads ADD COLUMN foreground_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN last_foreground_started_at INTEGER;
ALTER TABLE threads ADD COLUMN last_foreground_end_at INTEGER;
ALTER TABLE threads ADD COLUMN last_batch_had_ordinary INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN current_batch_has_ordinary INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN recent_foreground_gaps TEXT NOT NULL DEFAULT '[]';
ALTER TABLE threads ADD COLUMN foreground_grace_ms INTEGER NOT NULL DEFAULT 60000;
