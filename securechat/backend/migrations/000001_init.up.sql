-- SecureChat initial schema.
-- PostgreSQL is the durable source of truth. Only ciphertext + minimal metadata is stored (SC6).

-- gen_random_uuid() is built into PostgreSQL 13+, no extension needed.

CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username    TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Multi-device (RS9 / SC4 – SHOULD). MVP uses device_id = 1.
CREATE TABLE devices (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id   INT  NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, device_id)
);

CREATE TABLE conversations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind        TEXT NOT NULL DEFAULT 'direct' CHECK (kind IN ('direct', 'group')),
    -- Per-conversation sequence counter. UPDATE ... RETURNING serialises writers
    -- on the row lock, which is exactly the contention RS27/RS24 measure.
    last_seq    BIGINT NOT NULL DEFAULT 0,
    -- Canonical "userA:userB" (sorted) to guarantee one direct conversation per pair.
    direct_key  TEXT UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE conversation_members (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX idx_members_user ON conversation_members (user_id);

CREATE TABLE messages (
    id                 UUID PRIMARY KEY,
    conversation_id    UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq                BIGINT NOT NULL,
    sender_id          UUID NOT NULL REFERENCES users(id),
    client_message_id  TEXT NOT NULL,
    ciphertext         BYTEA NOT NULL,
    protocol_meta      JSONB NOT NULL DEFAULT '{}'::jsonb,
    client_created_at  TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- RS5: authoritative ordering + guards concurrent writers (RS7).
    CONSTRAINT uq_messages_conv_seq UNIQUE (conversation_id, seq),
    -- RS2: retries with the same clientMessageId never create a duplicate.
    CONSTRAINT uq_messages_sender_client_id UNIQUE (sender_id, client_message_id)
);
-- RS25 / RS8: history + sync queries are (conversation_id, seq) range scans,
-- served by the uq_messages_conv_seq index.

CREATE TABLE message_receipts (
    message_id    UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delivered_at  TIMESTAMPTZ,
    read_at       TIMESTAMPTZ,
    PRIMARY KEY (message_id, user_id)
);

-- Transactional outbox (KF1, KF2, doc §7.3).
CREATE TABLE outbox (
    id            BIGSERIAL PRIMARY KEY,           -- relay reads in id order
    event_id      UUID NOT NULL UNIQUE,            -- = Kafka envelope eventId
    event_type    TEXT NOT NULL,
    topic         TEXT NOT NULL,
    key           TEXT NOT NULL,                   -- conversationId (KF4)
    payload       JSONB NOT NULL,                  -- full envelope; ciphertext only
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at  TIMESTAMPTZ,                     -- set only after broker ack
    attempts      INT NOT NULL DEFAULT 0,
    last_error    TEXT
);
CREATE INDEX idx_outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
CREATE INDEX idx_outbox_published_at ON outbox (published_at) WHERE published_at IS NOT NULL;

-- Signal Protocol PUBLIC key material (SC2). Private keys are never uploaded.
CREATE TABLE prekey_bundles (
    user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id                INT  NOT NULL,
    registration_id          INT  NOT NULL,
    identity_key             BYTEA NOT NULL,
    signed_prekey_id         INT  NOT NULL,
    signed_prekey            BYTEA NOT NULL,
    signed_prekey_signature  BYTEA NOT NULL,
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, device_id)
);

CREATE TABLE one_time_prekeys (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id   INT  NOT NULL,
    key_id      INT  NOT NULL,
    public_key  BYTEA NOT NULL,
    PRIMARY KEY (user_id, device_id, key_id)
);
