-- Additive upgrade: existing dev users remain passwordless until an explicit
-- account recovery/migration policy is agreed. Registration never claims them.
ALTER TABLE users ADD COLUMN password_hash TEXT;
CREATE TABLE auth_sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    device_id INT NOT NULL CHECK (device_id > 0),
    family_id UUID NOT NULL,
    refresh_token_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(refresh_token_hash) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    FOREIGN KEY (user_id, device_id) REFERENCES devices(user_id, device_id) ON DELETE CASCADE
);
CREATE INDEX idx_auth_sessions_family ON auth_sessions(family_id);
