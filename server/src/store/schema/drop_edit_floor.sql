-- Editing an earlier message no longer stops at a completed mutative call, so
-- nothing tracks where that boundary was.
ALTER TABLE conversations DROP COLUMN edit_floor_seq;
