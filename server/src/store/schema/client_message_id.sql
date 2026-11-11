-- The client's idempotency key for a sent Message. It follows the Message from
-- the queue into the transcript so a retried send can find the original
-- instead of creating a duplicate.
ALTER TABLE messages
    ADD COLUMN client_message_id TEXT;

ALTER TABLE queued_messages
    ADD COLUMN client_message_id TEXT;

CREATE UNIQUE INDEX messages_by_client_message_id
    ON messages(client_message_id)
    WHERE client_message_id IS NOT NULL;

CREATE UNIQUE INDEX queued_messages_by_client_message_id
    ON queued_messages(client_message_id)
    WHERE client_message_id IS NOT NULL;
