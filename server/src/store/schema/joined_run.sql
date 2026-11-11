-- A user Message that joined a run already in progress: sent while Squire
-- worked and taken into context at a tool boundary, rather than starting a
-- run of its own. The transcript keeps it in that run's turn, so a run is
-- always one turn however many times the user steered it.
ALTER TABLE messages
    ADD COLUMN joined_run INTEGER NOT NULL DEFAULT 0 CHECK (joined_run IN (0, 1));
