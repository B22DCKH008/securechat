package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/securechat/backend/internal/domain"
)

// UpsertPreKeyBundle stores the PUBLIC identity/signed pre-key for a device (SC2).
// Identity key change detection/notification is a TODO (BE2 + FE1).
func UpsertPreKeyBundle(ctx context.Context, db DBTX, b domain.PreKeyBundle) error {
	_, err := db.Exec(ctx, `
		INSERT INTO prekey_bundles (user_id, device_id, registration_id, identity_key,
		                            signed_prekey_id, signed_prekey, signed_prekey_signature, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7, now())
		ON CONFLICT (user_id, device_id) DO UPDATE SET
		  registration_id = EXCLUDED.registration_id,
		  identity_key = EXCLUDED.identity_key,
		  signed_prekey_id = EXCLUDED.signed_prekey_id,
		  signed_prekey = EXCLUDED.signed_prekey,
		  signed_prekey_signature = EXCLUDED.signed_prekey_signature,
		  updated_at = now()`,
		b.UserID, b.DeviceID, b.RegistrationID, b.IdentityKey,
		b.SignedPreKeyID, b.SignedPreKey, b.SignedPreKeySignature)
	return err
}

func AddOneTimePreKeys(ctx context.Context, db DBTX, userID uuid.UUID, deviceID int, keys []domain.OneTimePreKey) error {
	for _, k := range keys {
		if _, err := db.Exec(ctx, `
			INSERT INTO one_time_prekeys (user_id, device_id, key_id, public_key)
			VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, userID, deviceID, k.KeyID, k.PublicKey); err != nil {
			return err
		}
	}
	return nil
}

// ClaimPreKeyBundle returns a device bundle and atomically consumes one one-time pre-key
// (if any remain). Must run inside a tx.
func ClaimPreKeyBundle(ctx context.Context, tx pgx.Tx, userID uuid.UUID, deviceID int) (domain.PreKeyBundle, error) {
	b := domain.PreKeyBundle{UserID: userID, DeviceID: deviceID}
	err := tx.QueryRow(ctx, `
		SELECT registration_id, identity_key, signed_prekey_id, signed_prekey, signed_prekey_signature
		FROM prekey_bundles WHERE user_id = $1 AND device_id = $2`, userID, deviceID).
		Scan(&b.RegistrationID, &b.IdentityKey, &b.SignedPreKeyID, &b.SignedPreKey, &b.SignedPreKeySignature)
	if errors.Is(err, pgx.ErrNoRows) {
		return b, domain.ErrNoPreKeyBundle
	}
	if err != nil {
		return b, err
	}

	var keyID int
	var pub []byte
	err = tx.QueryRow(ctx, `
		DELETE FROM one_time_prekeys
		WHERE (user_id, device_id, key_id) = (
		  SELECT user_id, device_id, key_id FROM one_time_prekeys
		  WHERE user_id = $1 AND device_id = $2
		  ORDER BY key_id LIMIT 1 FOR UPDATE SKIP LOCKED)
		RETURNING key_id, public_key`, userID, deviceID).Scan(&keyID, &pub)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// No one-time pre-keys left: X3DH still works with signed pre-key only.
	case err != nil:
		return b, err
	default:
		b.OneTimePreKeyID, b.OneTimePreKey = &keyID, pub
	}
	return b, nil
}
