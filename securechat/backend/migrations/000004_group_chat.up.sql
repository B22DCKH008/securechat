-- Group chat with pairwise fan-out (RS31, RS34, KF17).
-- The client encrypts one Signal ciphertext per recipient; the server stores the
-- opaque copies and never sees a group key or plaintext.
BEGIN;

ALTER TABLE conversations
    ADD COLUMN title      TEXT CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 64),
    ADD COLUMN created_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- joined_seq: a member sees messages with seq > joined_seq (history visibility, RS34).
ALTER TABLE conversation_members
    ADD COLUMN role       TEXT   NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    ADD COLUMN joined_seq BIGINT NOT NULL DEFAULT 0 CHECK (joined_seq >= 0);
CREATE UNIQUE INDEX uq_members_one_owner ON conversation_members (conversation_id) WHERE role = 'owner';

-- System messages (membership changes) take a seq so cursor sync stays gapless.
ALTER TABLE messages
    ADD COLUMN kind         TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'system')),
    ADD COLUMN system_event JSONB,
    ADD CONSTRAINT ck_messages_system_event CHECK ((kind = 'system') = (system_event IS NOT NULL));

-- One ciphertext per recipient for group messages; messages.ciphertext is empty then.
CREATE TABLE message_recipients (
    message_id    UUID  NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    recipient_id  UUID  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id     INT   NOT NULL DEFAULT 1 CHECK (device_id > 0),
    ciphertext    BYTEA NOT NULL CHECK (octet_length(ciphertext) > 0),
    protocol_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (message_id, recipient_id)
);

-- Removed/left members lose server-side access; this row lets their sync learn why.
CREATE TABLE conversation_departures (
    conversation_id UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    left_seq        BIGINT      NOT NULL,
    left_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, user_id)
);

COMMIT;
