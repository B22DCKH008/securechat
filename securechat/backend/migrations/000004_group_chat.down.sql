BEGIN;
DROP TABLE IF EXISTS conversation_departures;
DROP TABLE IF EXISTS message_recipients;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS ck_messages_system_event,
    DROP COLUMN IF EXISTS system_event, DROP COLUMN IF EXISTS kind;
DROP INDEX IF EXISTS uq_members_one_owner;
ALTER TABLE conversation_members DROP COLUMN IF EXISTS joined_seq, DROP COLUMN IF EXISTS role;
ALTER TABLE conversations DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS title;
COMMIT;
